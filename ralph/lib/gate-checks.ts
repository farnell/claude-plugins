// Ralph GATE CHECKS — "has Matt's step actually happened?", answered from evidence.
//
// A human-gate or decision task (a merge, a deploy, an API ship, a decision) is
// never RUN by the pipeline. Before this, nothing ever ticked it either: its
// dependents parked as `deps-not-met` until someone wrote a docs PR flipping the
// ledger by hand. Now every gate carries a `done_when` — one check, or a list
// that must ALL pass — and each run reads the evidence and ticks the gates that
// passed (`tick-gates.ts`).
//
// Why a FIXED list of check types, each tied to a specific PR / issue / file: a
// loose check ("prod was shipped recently") can be satisfied by the wrong event
// — a deploy from last week, before the code that needed it merged. Every type
// below names its anchor, so the trace can't exist unless the event happened.
// Every read is read-only, and any failure to read the evidence FAILS CLOSED
// (the gate stays waiting).
//
// Core check types are below. A repo can add its own (say, checks that read
// its database: `migration-applied`, `sql-true`, …) through its adapter's
// `gateChecks` (`.claude/ralph.json`): the core knows them by NAME only, and a
// repo command judges them (`GateIO.extra`). `pr-merged` / `prod-includes` /
// `issue-closed` take an optional `repo`, so a gate can wait on another repo.
//
/**
 * `repo` (optional, "owner/name") points a check at another GitHub repo — e.g.
 * an app gate that waits for the API PR it depends on to reach API prod. When
 * absent the check reads THIS repo (the adapter's `repo`).
 */
import { isClosed, resolveHost } from "./ledger-status.ts";

export type DoneCheck =
  /** the PR is merged */
  | { type: "pr-merged"; pr: number; repo?: string }
  /** prod contains the PR's merge commit (how prod is read: the adapter's `prod`) */
  | { type: "prod-includes"; pr: number; repo?: string }
  /** the GitHub issue is closed */
  | { type: "issue-closed"; issue: number; repo?: string }
  /** the file on origin/main (this repo) contains the text (a recorded decision) */
  | { type: "doc-contains"; file: string; text: string }
  /** a repo-provided check (adapter `gateChecks.types`), judged by the repo's command */
  | { type: string; [k: string]: unknown };

export type DoneWhen = DoneCheck | DoneCheck[];

/** The core check types. A repo adds more through its adapter. */
export const CHECK_TYPES = ["pr-merged", "prod-includes", "issue-closed", "doc-contains"] as const;

/** What a check needs to know about the repo it runs in (from the adapter). */
export interface GateContext {
  /** this repo, "owner/name" — a check with no `repo` reads here */
  self: string;
  /** repos whose prod `prod-includes` can read */
  prodRepos: string[];
  /** repo-provided check types (adapter gateChecks.types) */
  extraTypes: string[];
}

/** A context with no repo knowledge: core types only, no prod reader. Tests and pure callers. */
export const NO_CONTEXT: GateContext = { self: "", prodRepos: [], extraTypes: [] };

export function contextFrom(a: { repo: string; prod: Record<string, unknown>; gateChecks: { types: string[] } }): GateContext {
  return { self: a.repo, prodRepos: Object.keys(a.prod), extraTypes: a.gateChecks.types };
}

/** Every check type valid in a context. */
export function checkTypes(ctx: GateContext): string[] {
  return [...CHECK_TYPES, ...ctx.extraTypes];
}

export interface PrState {
  state: string;
  mergedAt: string | null;
  mergeCommit: string | null;
}

/**
 * Every fact a check can read. Each returns null when the fact doesn't exist.
 * `repo` is always passed resolved ("owner/name"), never undefined.
 */
export interface GateIO {
  pr(n: number, repo: string): Promise<PrState | null>;
  prodCommit(repo: string): Promise<string | null>;
  /** is `ancestor` contained in `descendant`, in `repo`'s history */
  isAncestor(ancestor: string, descendant: string, repo: string): Promise<boolean>;
  issueState(n: number, repo: string): Promise<string | null>;
  docOnMain(file: string): Promise<string | null>;
  /** judge a repo-provided check type (the adapter's gateChecks command) */
  extra(check: Record<string, unknown>): Promise<CheckResult>;
}

export interface CheckResult {
  pass: boolean;
  reason: string;
}

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isRepo = (v: unknown): v is string => typeof v === "string" && /^[\w.-]+\/[\w.-]+$/.test(v);

/** The repo a check reads: its `repo`, else this one. */
export function repoOf(c: { repo?: unknown }, ctx: GateContext): string {
  return typeof c.repo === "string" ? c.repo : ctx.self;
}

function validateOne(c: unknown, where: string, ctx: GateContext): string[] {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return [`${where} is not a check object`];
  const o = c as Record<string, unknown>;
  const type = o.type;
  const types = checkTypes(ctx);
  if (typeof type !== "string" || !types.includes(type)) {
    return [`${where} has unknown type "${String(type)}" — this repo's checks are ${types.join(" | ")}`];
  }
  // A repo-provided type: its shape is the repo command's to judge (`validate`).
  if (ctx.extraTypes.includes(type)) return [];
  const errs: string[] = [];
  if (o.repo !== undefined) {
    if (type === "doc-contains") errs.push(`${where} (doc-contains) takes no "repo" — it reads this repo's origin/main`);
    else if (!isRepo(o.repo)) errs.push(`${where} (${type}) "repo" must be "owner/name"`);
  }
  if (type === "prod-includes") {
    const repo = repoOf(o, ctx);
    if (!ctx.prodRepos.includes(repo)) {
      errs.push(
        ctx.prodRepos.length
          ? `${where} (prod-includes) can only read prod for ${ctx.prodRepos.join(" or ")} (the adapter's "prod")`
          : `${where} (prod-includes) needs a prod reader: this repo's adapter has no "prod"`,
      );
    }
  }
  switch (type) {
    case "pr-merged":
    case "prod-includes":
      if (!isPosInt(o.pr)) errs.push(`${where} (${type}) needs "pr": <PR number> — the anchor`);
      break;
    case "issue-closed":
      if (!isPosInt(o.issue)) errs.push(`${where} (issue-closed) needs "issue": <issue number>`);
      break;
    case "doc-contains":
      if (!(isNonEmpty(o.file) && isNonEmpty(o.text))) errs.push(`${where} (doc-contains) needs "file" and "text"`);
      break;
  }
  return errs;
}

/** Shape check for a task's `done_when`. Empty array = valid. */
export function validateDoneWhen(x: unknown, ctx: GateContext = NO_CONTEXT): string[] {
  if (x === undefined || x === null) return ['missing "done_when"'];
  if (Array.isArray(x)) {
    if (x.length === 0) return ['"done_when" is an empty list'];
    return x.flatMap((c, i) => validateOne(c, `done_when[${i}]`, ctx));
  }
  return validateOne(x, "done_when", ctx);
}

/** The repo-provided checks in a `done_when` (the ones the repo command must validate). */
export function extraChecks(x: unknown, ctx: GateContext): Record<string, unknown>[] {
  const list = Array.isArray(x) ? x : x ? [x] : [];
  return list.filter(
    (c): c is Record<string, unknown> =>
      !!c && typeof c === "object" && ctx.extraTypes.includes(String((c as Record<string, unknown>).type)),
  );
}

/** "#12" for this repo, "owner/name#12" for another. */
function ref(n: number, repo: string, ctx: GateContext): string {
  return repo === ctx.self ? `#${n}` : `${repo}#${n}`;
}

async function mergedPr(io: GateIO, n: number, repo: string, ctx: GateContext): Promise<PrState | string> {
  const p = await io.pr(n, repo);
  if (!p) return `PR ${ref(n, repo, ctx)} not found`;
  if (p.state !== "MERGED" || !p.mergedAt) return `PR ${ref(n, repo, ctx)} is not merged (${p.state})`;
  return p;
}

async function evaluate(c: DoneCheck, io: GateIO, ctx: GateContext): Promise<CheckResult> {
  const o = c as Record<string, any>;
  switch (c.type) {
    case "pr-merged": {
      const repo = repoOf(o, ctx);
      const p = await mergedPr(io, o.pr, repo, ctx);
      return typeof p === "string" ? { pass: false, reason: p } : { pass: true, reason: `PR ${ref(o.pr, repo, ctx)} merged` };
    }
    case "prod-includes": {
      const repo = repoOf(o, ctx);
      const p = await mergedPr(io, o.pr, repo, ctx);
      if (typeof p === "string") return { pass: false, reason: p };
      if (!p.mergeCommit) return { pass: false, reason: `PR ${ref(o.pr, repo, ctx)} has no merge commit` };
      const where = repo === ctx.self ? "prod" : `${repo} prod`;
      const prod = await io.prodCommit(repo);
      if (!prod) return { pass: false, reason: `${where} gave no commit` };
      return (await io.isAncestor(p.mergeCommit, prod, repo))
        ? { pass: true, reason: `${where} ${prod.slice(0, 8)} includes PR ${ref(o.pr, repo, ctx)}` }
        : { pass: false, reason: `${where} ${prod.slice(0, 8)} does not include PR ${ref(o.pr, repo, ctx)} yet` };
    }
    case "issue-closed": {
      const repo = repoOf(o, ctx);
      const s = await io.issueState(o.issue, repo);
      if (!s) return { pass: false, reason: `issue ${ref(o.issue, repo, ctx)} not found` };
      return s === "CLOSED"
        ? { pass: true, reason: `issue ${ref(o.issue, repo, ctx)} closed` }
        : { pass: false, reason: `issue ${ref(o.issue, repo, ctx)} is ${s}` };
    }
    case "doc-contains": {
      const body = await io.docOnMain(o.file);
      if (body === null) return { pass: false, reason: `${o.file} is not on main` };
      // Text inside an HTML comment is not evidence: log files carry `<!-- e.g. … -->` examples
      // that quote the gate text (2026-11-05: G0 auto-ticked off the credits log's example).
      return body.replace(/<!--[\s\S]*?-->/g, "").includes(o.text)
        ? { pass: true, reason: `${o.file} records "${o.text}"` }
        : { pass: false, reason: `${o.file} does not yet record "${o.text}"` };
    }
  }
  if (ctx.extraTypes.includes(c.type)) {
    const r = await io.extra(o);
    // The repo command must answer exactly {pass: boolean, reason: string}; anything else fails closed.
    if (!r || typeof r.pass !== "boolean") return { pass: false, reason: `${c.type}: the repo's gate check gave no verdict` };
    return { pass: r.pass === true, reason: String(r.reason ?? "") || `${c.type}: ${r.pass ? "passed" : "not yet"}` };
  }
  return { pass: false, reason: `${c.type}: not a check this repo knows` };
}

/** Evaluate one check. Any thrown error becomes a fail, never a pass. */
export async function evaluateCheck(c: DoneCheck, io: GateIO, ctx: GateContext = NO_CONTEXT): Promise<CheckResult> {
  try {
    return await evaluate(c, io, ctx);
  } catch (err) {
    return { pass: false, reason: `${c.type}: could not read the evidence (${(err as Error).message})` };
  }
}

export interface GateTask {
  id: string;
  title: string;
  status: string;
  deps?: string[];
  human_gate?: boolean;
  kind?: string;
  done_when?: DoneWhen;
  notes?: string;
  updatedAt?: string | null;
  [k: string]: unknown;
}

export interface GateLedger {
  feature: { slug: string; [k: string]: unknown };
  tasks: GateTask[];
  [k: string]: unknown;
}

export interface GatePlan {
  /** the ledger with the passing gates ticked (input is not mutated) */
  ledger: GateLedger;
  ticked: { id: string; reasons: string[] }[];
  /** gates whose deps are done but whose checks don't pass yet — Matt's to-do */
  waiting: { id: string; reasons: string[] }[];
  /** gates with no valid done_when — Ralph must add one on the next ledger refresh */
  noCheck: string[];
}

export function isGate(t: { human_gate?: unknown; kind?: unknown }): boolean {
  return t.human_gate === true || t.kind === "decision";
}

/**
 * Tick every not-done gate whose deps are done AND whose checks all pass.
 * Repeats until nothing changes, so a chain (HG-2 after HG-1) ticks in one run.
 */
export async function planGateTicks(
  input: GateLedger,
  io: GateIO,
  today: string,
  ctx: GateContext = NO_CONTEXT,
): Promise<GatePlan> {
  const ledger = structuredClone(input) as GateLedger;
  const done = new Set(ledger.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const ticked: GatePlan["ticked"] = [];
  const lastReasons = new Map<string, string[]>();
  const noCheck: string[] = [];

  for (const t of ledger.tasks) {
    if (isGate(t) && !isClosed(t) && validateDoneWhen(t.done_when, ctx).length > 0) noCheck.push(t.id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const t of ledger.tasks) {
      if (!isGate(t) || isClosed(t) || noCheck.includes(t.id)) continue;
      // A dep on a batched task waits on its host (ledger-status.ts).
      if ((t.deps ?? []).some((d) => !done.has(resolveHost(d, ledger.tasks)))) continue;
      const checks = Array.isArray(t.done_when) ? t.done_when : [t.done_when!];
      const results = [];
      for (const c of checks) results.push(await evaluateCheck(c, io, ctx));
      const reasons = results.map((r) => r.reason);
      if (results.every((r) => r.pass)) {
        t.status = "done";
        t.updatedAt = today;
        const note = `auto-ticked by Ralph ${today}: ${reasons.join("; ")}`;
        t.notes = t.notes ? `${t.notes} · ${note}` : note;
        done.add(t.id);
        ticked.push({ id: t.id, reasons });
        lastReasons.delete(t.id);
        changed = true;
      } else {
        lastReasons.set(t.id, results.filter((r) => !r.pass).map((r) => r.reason));
      }
    }
  }

  const waiting = [...lastReasons].map(([id, reasons]) => ({ id, reasons }));
  return { ledger, ticked, waiting, noCheck };
}
