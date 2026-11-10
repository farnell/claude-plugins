// Ralph NEXT-STEP resolver — "which task, which stage, right now?"
//
// The PR pipeline (docs/ralph/ralph-policy.md) keeps NO state in the
// orchestrating session. Everything it needs is on GitHub and `origin/main`:
//
//   · the ledger JSON on origin/main  — which tasks are done (a task's PR ticks
//     it `done`, so merging the PR is what lands the tick on main);
//   · one PR per task on branch `ralph/<slug>/<id>`;
//   · an append-only log of MARKER comments on that PR, one per finished stage:
//       <!-- ralph:red sha=<sha> files=<a,b> --> red tests pushed (sha = the red commit,
//                                               files = the red test files it wrote/changed)
//       <!-- ralph:implemented sha=<sha> -->    implementation pushed
//       <!-- ralph:check result=pass|fail -->   head re-verified by a fresh agent
//       <!-- ralph:review verdict=approve|changes|redo-red -->
//                                               redo-red (code only): a RED test is
//                                               bad, and implement may not change
//                                               red's assertions, so red rewrites it
//       <!-- ralph:blind-check result=pass|fail -->  an independent agent that
//                                               never saw the grades re-did the
//                                               blind check (measure tasks that
//                                               ask for one: blind_check:true)
//       <!-- ralph:blocked reason=... -->       a stage gave up; parks the task
//       <!-- ralph:retry -->  OR a comment that is just "retry"
//                                               a human un-parks it (clears the
//                                               block + the failure counters)
//
// Stages per kind: code = red -> implement -> check -> review -> merge. docs /
// measure = implement -> [blind-check] -> review -> merge: their review does the
// check stage's duties too (2026-10-12: on a docs/measure task the check only
// re-confirmed what review re-checked, at a full agent's cost).
// A code task with `size: "small"` (2026-11-02) runs implement -> review -> merge:
// implement writes the tests with the code, and review does the check duties. A
// fresh agent costs ~40k tokens of fixed context before it does anything, so a
// small, low-risk task paid that five times for checks that found nothing.
//
// So a killed run — or a brand-new session — resumes exactly where the last one
// stopped by calling this. The decision is a pure function (`nextStep`) over
// plain data; the CLI below is plumbing that fetches the data.

import { execFileSync } from "node:child_process";

import { loadAdapter } from "./adapter.ts";
import { contextFrom, NO_CONTEXT, validateDoneWhen, type GateContext } from "./gate-checks.ts";
import { isEntryPoint } from "./is-entry-point.ts";
import { isClosed, resolveHost } from "./ledger-status.ts";

// The Nth failure parks the task: 3 → two fix rounds get acted on.
export const MAX_CHECK_FAILURES = 3;
export const MAX_REVIEW_CHANGES = 3;

export type Stage = "red" | "implement" | "check" | "blind-check" | "review" | "merge";

export interface LedgerTask {
  id: string;
  title: string;
  pointer: string;
  status: string;
  deps?: string[];
  human_gate?: boolean;
  kind?: string;
  verify?: string | null;
  model?: string;
  done_when?: unknown;
  /** measure only: an independent fresh agent re-does the blind check before review. */
  blind_check?: boolean;
  /** code only: "small" skips the red and check stages (see SIZES). Absent = "standard". */
  size?: string;
  /** status "batched" only: the task whose PR ships this one's section. */
  batched_into?: string;
}

/** Pipeline size of a code task. "small" = implement -> review -> merge. */
export const SIZES = ["small", "standard"] as const;

/** True when a task runs the lean code route: no red stage, no check stage. */
export function isSmallCode(kind: string, size: string | undefined): boolean {
  return kind === "code" && size === "small";
}

export interface LedgerLike {
  feature: { slug: string };
  tasks: LedgerTask[];
}

export interface Marker {
  event: string;
  attrs: Record<string, string>;
}

export interface PrFacts {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  headRefOid: string;
  url: string;
  markers: Marker[];
}

export type Resolution =
  | { action: "skip" }
  | { action: "park"; reason: string }
  | ({ action: "run"; stage: Stage; reviewRound: number; checkFailures: number; lastEvent: LastEvent } & RedFacts);

/**
 * What check diffs against, read from the red markers (`<!-- ralph:red sha=<commit>
 * files=a.test.ts,b.test.ts -->`), never from a commit-message search: redSha = the latest red
 * commit (the baseline), prevRedSha = the red commit before it ("" until a redo), redFiles = every
 * red test file named on any red marker (a redo names only what it changed).
 */
export interface RedFacts {
  redSha: string;
  prevRedSha: string;
  redFiles: string[];
}

export function redFactsOf(markers: Marker[]): RedFacts {
  const files = new Set<string>();
  let redSha = "";
  let prevRedSha = "";
  let redoAsked = false; // a `review verdict=redo-red` since the last red marker
  for (const m of markers) {
    if (m.event === "review" && m.attrs.verdict === "redo-red") redoAsked = true;
    if (m.event !== "red") continue;
    for (const f of (m.attrs.files ?? "").split(",")) if (f) files.add(f);
    const sha = m.attrs.sha ?? "";
    // Only a red that answers a redo-red review is a redo; a re-posted red just replaces the baseline.
    if (sha) {
      prevRedSha = redoAsked && redSha ? redSha : "";
      redSha = sha;
    }
    redoAsked = false;
  }
  return { redSha, prevRedSha, redFiles: [...files].sort() };
}

const NO_RED: RedFacts = { redSha: "", prevRedSha: "", redFiles: [] };

/** Why the task is (back) at implement — the implement prompt keys off this, not the counters. */
export type LastEvent = "none" | "check-fail" | "blind-check-fail" | "review-changes" | "review-redo-red" | "red-redone";

const KNOWN_EVENTS = new Set(["red", "implemented", "check", "blind-check", "review", "blocked", "retry"]);
// An attr that must take one of a fixed set of values; anything else (a quoted
// template like `result=pass|fail`, a typo) makes the marker invalid, not a fail.
const ENUM_ATTRS: Record<string, Record<string, string[]>> = {
  check: { result: ["pass", "fail"] },
  "blind-check": { result: ["pass", "fail"] },
  review: { verdict: ["approve", "changes", "redo-red"] },
};
const MARKER_RE = /<!--\s*ralph:([a-z-]+)((?:\s+[a-z_]+=[^\s>]+)*)\s*-->/g;

export function branchFor(slug: string, id: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `ralph/${safe(slug)}/${safe(id)}`;
}

// A human's plain-language un-park. The WHOLE comment (trimmed) must be ONE
// line that is `retry`, `/retry`, `retry.` or `retry!` (any case), or
// `retry - <note>` / `retry — <note>` (a dash with spaces round it). Anything
// else is rejected, because the loose first-line rule it replaced (PR #1164
// review) un-parked a task on "Retry: no, hold off" and on "retry\n\nactually
// don't": a colon or comma form reads as the start of a sentence that may say
// the opposite, and a second line may take it back. Stage agents never post a
// one-line comment like this, so it cannot be posted by accident.
const PLAIN_RETRY_RE = /^\/?retry(?:[.!]|\s+[-—–]\s+\S.*)?$/i;

/** True when a comment is, in its entirety, a human's plain `retry`. */
export function isPlainRetry(body: string): boolean {
  const whole = body.trim();
  if (whole.includes("\n")) return false;
  return PLAIN_RETRY_RE.test(whole);
}

/**
 * One marker per comment, in comment order: the LAST valid marker in each body.
 * A stage posts its marker last, so anything earlier in the same comment (a
 * review quoting the check marker, a pasted template) is ignored.
 */
export function parseMarkers(bodies: string[]): Marker[] {
  const out: Marker[] = [];
  for (const body of bodies) {
    let last: Marker | null = null;
    for (const m of body.matchAll(MARKER_RE)) {
      const event = m[1] ?? "";
      if (!KNOWN_EVENTS.has(event)) continue;
      const attrs: Record<string, string> = {};
      for (const kv of (m[2] ?? "").trim().split(/\s+/).filter(Boolean)) {
        const i = kv.indexOf("=");
        attrs[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const enums = ENUM_ATTRS[event] ?? {};
      // A red marker carries both sha= and files= (check's baseline) or, on a PR older than that
      // rule, neither. One without the other is invalid, so red simply runs again and re-posts it.
      const redHalf = event === "red" && ("sha" in attrs) !== ("files" in attrs);
      const valid = !redHalf && Object.entries(enums).every(([k, allowed]) => allowed.includes(attrs[k] ?? ""));
      if (valid) last = { event, attrs };
    }
    if (!last && isPlainRetry(body)) last = { event: "retry", attrs: {} };
    if (last) out.push(last);
  }
  return out;
}

function lastEventOf(last: Marker | undefined, hasRed: boolean, markers: Marker[]): LastEvent {
  if (last?.event === "check" && last.attrs.result === "fail") return "check-fail";
  if (last?.event === "blind-check" && last.attrs.result === "fail") return "blind-check-fail";
  if (last?.event === "review" && last.attrs.verdict === "redo-red") {
    // Only a task with a red stage can redo it; elsewhere a redo is an ordinary fix round.
    return hasRed ? "review-redo-red" : "review-changes";
  }
  if (last?.event === "review" && last.attrs.verdict === "changes") return "review-changes";
  // A red marker AFTER an implementation is a redo: implement must make the rewritten tests pass.
  if (last?.event === "red" && markers.some((m) => m.event === "implemented")) return "red-redone";
  return "none";
}

/**
 * `full` = the standard code route (red + check stages). Small code tasks and
 * docs/measure tasks have neither: review verifies the pushed head itself.
 */
function stageAfter(last: Marker | undefined, full: boolean, manual: boolean, blindCheck: boolean): Stage | "awaiting-human" {
  if (!last) return full ? "red" : "implement";
  switch (last.event) {
    case "red":
      return "implement";
    case "implemented":
      if (full) return "check";
      return blindCheck ? "blind-check" : "review";
    case "check":
      // A merge-stage `check result=fail` reaches a small task too: back to implement.
      if (last.attrs.result !== "pass") return "implement";
      return "review";
    case "blind-check":
      return last.attrs.result === "pass" ? "review" : "implement";
    case "review":
      if (last.attrs.verdict === "redo-red" && full) return "red";
      if (last.attrs.verdict !== "approve") return "implement";
      return manual ? "awaiting-human" : "merge";
    default:
      return full ? "red" : "implement";
  }
}

/** The pure per-task decision. `done` = ids whose ledger status is done on main. */
export function resolveTask(task: LedgerTask, pr: PrFacts | undefined, done: Set<string>, ctx: GateContext = NO_CONTEXT): Resolution {
  if (isClosed(task)) return { action: "skip" };
  // A gate is Matt's step. tick-gates.ts ticks it from its `done_when` evidence at
  // the start of every run; one with no valid check can never be ticked, so it is
  // reported apart ("gate-no-check": Ralph adds the check on the next ledger refresh).
  if (task.human_gate === true || task.kind === "decision") {
    return { action: "park", reason: validateDoneWhen(task.done_when, ctx).length === 0 ? "human_gate" : "gate-no-check" };
  }
  if (task.status === "blocked") return { action: "park", reason: "blocked" };
  if (task.status === "awaiting_review") return { action: "park", reason: "awaiting-human" };
  if ((task.deps ?? []).some((d) => !done.has(d))) return { action: "park", reason: "deps-not-met" };

  const kind = task.kind ?? "code";
  const manual = task.verify === "manual";
  const blindCheck = kind === "measure" && task.blind_check === true;
  const full = kind === "code" && !isSmallCode(kind, task.size);
  if (!pr) {
    return { action: "run", stage: stageAfter(undefined, full, manual, blindCheck) as Stage, reviewRound: 0, checkFailures: 0, lastEvent: "none", ...NO_RED };
  }
  if (pr.state === "MERGED") return { action: "park", reason: "merged-ledger-not-done" };
  // To restart a closed task: `gh pr reopen <n>` + a retry comment.
  if (pr.state === "CLOSED") return { action: "park", reason: "pr-closed" };

  // Counters and blocks only count since the last human retry; the stage is read
  // from the last stage marker of the whole log, so a retry resumes in place.
  const lastRetry = pr.markers.map((m) => m.event).lastIndexOf("retry");
  const window = pr.markers.slice(lastRetry + 1);
  if (window.some((m) => m.event === "blocked")) return { action: "park", reason: "blocked" };
  const checkFailures = window.filter((m) => (m.event === "check" || m.event === "blind-check") && m.attrs.result === "fail").length;
  // A redo-red is a review round too: it shares the limit, so red ↔ review cannot loop forever.
  const reviewRound = window.filter(
    (m) => m.event === "review" && (m.attrs.verdict === "changes" || m.attrs.verdict === "redo-red"),
  ).length;
  // MAX_* failures park the task, so MAX_* − 1 fix rounds get acted on.
  if (checkFailures >= MAX_CHECK_FAILURES || reviewRound >= MAX_REVIEW_CHANGES) {
    return { action: "park", reason: "blocked" };
  }

  const last = [...pr.markers].reverse().find((m) => m.event !== "blocked" && m.event !== "retry");
  const stage = stageAfter(last, full, manual, blindCheck);
  if (stage === "awaiting-human") return { action: "park", reason: "awaiting-human" };
  return { action: "run", stage, reviewRound, checkFailures, lastEvent: lastEventOf(last, full, pr.markers), ...redFactsOf(pr.markers) };
}

export interface NextTask {
  taskId: string;
  title: string;
  pointer: string;
  kind: string;
  verify: string;
  model: string;
  /** "small" | "standard" (code tasks; "standard" when the ledger omits it). */
  size: string;
  stage: Stage | "";
  branch: string;
  prNumber: number;
  prUrl: string;
  reviewRound: number;
  checkFailures: number;
  lastEvent: LastEvent;
  markerCount: number;
  redSha: string;
  prevRedSha: string;
  redFiles: string[];
}

export interface NextStepResult {
  hasNext: boolean;
  next: NextTask;
  parked: { id: string; reason: string }[];
  /** Open tasks: not done and not batched. */
  remaining: number;
  /** Rows folded into another task (status "batched"). A fold moves a task from `remaining` to here, so the loop can tell it from a vanished task. */
  batched: number;
}

const EMPTY_NEXT: NextTask = {
  taskId: "", title: "", pointer: "", kind: "", verify: "", model: "", size: "", stage: "",
  branch: "", prNumber: 0, prUrl: "", reviewRound: 0, checkFailures: 0, lastEvent: "none", markerCount: 0,
  ...NO_RED,
};

/** Pick the PR for a branch: the open one, else the newest. */
function prForBranch(prs: PrFacts[], branch: string): PrFacts | undefined {
  const mine = prs.filter((p) => p.headRefName === branch).sort((a, b) => b.number - a.number);
  return mine.find((p) => p.state === "OPEN") ?? mine[0];
}

export function nextStep(ledger: LedgerLike, prs: PrFacts[], skip: Set<string>, ctx: GateContext = NO_CONTEXT): NextStepResult {
  const done = new Set(ledger.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const parked: { id: string; reason: string }[] = [];
  let next: NextTask | null = null;

  for (const raw of ledger.tasks) {
    if (isClosed(raw)) continue;
    // A dep on a batched task waits on its host; a dep on a task folded into
    // this one is this task's own work, so it drops out.
    const deps = (raw.deps ?? []).map((d) => resolveHost(d, ledger.tasks)).filter((d) => d !== raw.id);
    const task = { ...raw, deps };
    const branch = branchFor(ledger.feature.slug, task.id);
    const pr = prForBranch(prs, branch);
    const r = skip.has(task.id) ? ({ action: "park", reason: "skipped-this-run" } as const) : resolveTask(task, pr, done, ctx);
    if (r.action === "park") {
      parked.push({ id: task.id, reason: r.reason });
    } else if (r.action === "run" && next === null) {
      next = {
        taskId: task.id,
        title: task.title,
        pointer: task.pointer,
        kind: task.kind ?? "code",
        verify: task.verify ?? "",
        model: task.model ?? "",
        size: task.size ?? "standard",
        stage: r.stage,
        branch,
        prNumber: pr?.number ?? 0,
        prUrl: pr?.url ?? "",
        reviewRound: r.reviewRound,
        checkFailures: r.checkFailures,
        lastEvent: r.lastEvent,
        markerCount: pr?.markers.length ?? 0,
        redSha: r.redSha,
        prevRedSha: r.prevRedSha,
        redFiles: r.redFiles,
      };
    }
  }

  return {
    hasNext: next !== null,
    next: next ?? EMPTY_NEXT,
    parked,
    remaining: ledger.tasks.filter((t) => !isClosed(t)).length,
    batched: ledger.tasks.filter((t) => t.status === "batched").length,
  };
}

// ---------------------------------------------------------------------------
// CLI: `node <ralph>/lib/next-step.ts <ledger.json> [--skip A,B]`
// Reads the ledger from origin/main (after a fetch) — never the local checkout,
// which may be any branch — and, per not-done task, that task branch's PRs from
// GitHub. Prints one JSON NextStepResult on stdout.
// ---------------------------------------------------------------------------
interface GhPr {
  number: number;
  state: PrFacts["state"];
  headRefName: string;
  headRefOid: string;
  url: string;
  comments: { body: string; createdAt: string }[];
}

export type Exec = (cmd: string, args: string[]) => string;

const realExec: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 });

/** Fetch the inputs and decide. Returns an error string on a bad ledger. `exec` is injectable for tests. */
export function loadAndDecide(
  ledgerPath: string,
  skip: Set<string>,
  exec: Exec = realExec,
  ctx: GateContext = NO_CONTEXT,
): NextStepResult | string {
  exec("git", ["fetch", "origin", "main", "--quiet"]);
  const ledger = JSON.parse(exec("git", ["show", `origin/main:${ledgerPath}`])) as LedgerLike;
  if (!ledger?.feature?.slug || !Array.isArray(ledger.tasks)) {
    return `ledger ${ledgerPath} on origin/main has no feature.slug or tasks[]`;
  }

  // One query per not-done task, by exact head branch — no repo-wide list that a
  // long-lived feature's older PRs could fall out of.
  const prs: PrFacts[] = [];
  for (const task of ledger.tasks) {
    if (isClosed(task)) continue;
    const branch = branchFor(ledger.feature.slug, task.id);
    const raw = JSON.parse(
      exec("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,headRefName,headRefOid,url,comments"]),
    ) as GhPr[];
    for (const p of raw) {
      if (p.headRefName !== branch) continue;
      prs.push({
        number: p.number,
        state: p.state,
        headRefName: p.headRefName,
        headRefOid: p.headRefOid,
        url: p.url,
        markers: parseMarkers([...p.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => c.body)),
      });
    }
  }
  return nextStep(ledger, prs, skip, ctx);
}

/** The gate context from this repo's adapter; none (core checks only) when it can't be read — the preflight refuses a run without one. */
export function adapterContext(): GateContext {
  try {
    return contextFrom(loadAdapter());
  } catch {
    return NO_CONTEXT;
  }
}

export function runCli(argv: string[], exec: Exec = realExec, ctx: GateContext = adapterContext()): number {
  const ledgerPath = argv[2];
  if (!ledgerPath) {
    console.error("usage: node <ralph>/lib/next-step.ts <ledger.json> [--skip A,B]");
    return 1;
  }
  const skipIdx = argv.indexOf("--skip");
  const skip = new Set(skipIdx > 0 ? (argv[skipIdx + 1] ?? "").split(",").filter(Boolean) : []);
  const result = loadAndDecide(ledgerPath, skip, exec, ctx);
  if (typeof result === "string") {
    console.error(result);
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) {
  process.exit(runCli(process.argv));
}
