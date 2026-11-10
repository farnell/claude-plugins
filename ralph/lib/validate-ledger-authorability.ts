// Ralph ledger AUTHORABILITY validator.
//
// The dep validator (validate-ledger-deps.ts) checks the task graph is
// well-formed. This one checks the tasks are AUTHORABLE — that the loop has a
// real, honest "done" signal for every task it will try to grind.
//
// The failure mode this exists to catch: a task with no machine-checkable
// "done" can only be SELF-GRADED. That is the single most-documented Ralph
// failure — the agent "ticks the checkbox, confidently wrong." The default
// verify gate (`tsc --noEmit` + `pnpm test`) is TOOTHLESS on a doc/prose task
// (it passes trivially), so "the feature has a gate" is not enough. We make an
// insufficient spec FAIL LOUD at derivation, instead of discovering it as a
// shallow pass mid-run.
//
// Two severities (see docs/ralph/authoring-guide.md):
//   errors[]   — HARD BLOCK. Deterministic, low-false-positive:
//                · a non-gated task with no `verify` declaration,
//                · `verify:"gate"` under a feature with no real gate,
//                · a malformed task (no title / no pointer),
//                · a runnable task with a missing/unknown `kind`, a non-gated
//                  `decision`, `code` + "manual", or `docs`/`measure` + "gate",
//                · an unambiguous apply/deploy command in a non-gated task,
//                · an open gate without a valid `done_when` (gate-checks.ts),
//                  or a `done_when` on a task that is not a gate,
//                · an unbatched same-file pair: two runnable code tasks, at
//                  least one small, that share a path in `files` and where one
//                  depends on the other (directly or transitively) — merge
//                  them into one task, or justify with `unbatched: "<reason>"`.
//   warnings[] — ADVISORY. Heuristic / false-positive-prone (never blocks):
//                · a task whose slice spans many lines (likely an and-joined
//                  mega-task worth splitting),
//                · soft prod-touching wording that should probably be gated,
//                · a runnable small code task with no `files` (the batching
//                  check can't compare it with its neighbours).
//
// Wired into the same two points as the dep validator: the /ralph skill
// (derivation time) and the ralph-loop workflow preflight.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { loadAdapter, type Adapter } from "./adapter.ts";
import { realRunCheck, validateExtraCheck, type RunCheck } from "./repo-check.ts";
import { checkTypes, contextFrom, extraChecks, NO_CONTEXT, validateDoneWhen, type GateContext } from "./gate-checks.ts";
import { isEntryPoint } from "./is-entry-point.ts";
import { SIZES } from "./next-step.ts";

// `verify` sentinels (see the loop / policy §5):
//   "manual" — no machine check; the agent does the work, commits it, sets the
//              task to `awaiting_review`, and it PARKS for a human to confirm
//              (never auto-`done`).
//   "gate"   — the feature-level `verifyCmds` fully verify this task (the normal
//              case for a code task covered by tsc + test).
export const VERIFY_MANUAL = "manual";
export const VERIFY_GATE = "gate";

// `kind` routes a task through the PR pipeline (docs/ralph/ralph-policy.md):
//   code     — red tests → implement → check → review → merge. Proven by its
//              red tests + the gate, so verify:"manual" is refused (split the
//              unmeasurable part into a `measure` task). With size:"small":
//              implement → review → merge (no red, no check stage).
//   docs     — implement → review → merge (review does the check duties). Proven by an artifact check
//              command (or "manual"); verify:"gate" proves nothing about prose.
//   measure  — implement (run the measurement, record the numbers) → check →
//              review; a "manual" one parks for Matt instead of merging.
//   decision — always a human's: must be human_gate.
export const TASK_KINDS = ["code", "docs", "measure", "decision"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface AuthorabilityTaskLike {
  id?: unknown;
  title?: unknown;
  pointer?: unknown;
  human_gate?: unknown;
  verify?: unknown;
  kind?: unknown;
  status?: unknown;
  done_when?: unknown;
  blind_check?: unknown;
  size?: unknown;
  deps?: unknown;
  /** Repo-relative paths the task expects to edit (code tasks; feeds the batching check). */
  files?: unknown;
  /** Why this task must stay a separate PR from a same-file neighbour (escape hatch for the batching check). */
  unbatched?: unknown;
}

export interface AuthorabilityLedgerLike {
  feature?: unknown;
  tasks?: unknown;
}

export interface AuthorabilityResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// A feature-level gate is "real" if it declares at least one non-trivial
// command. A doc/roadmap feature typically has no real gate (or a placeholder
// like ["true"]), so its tasks cannot hide behind verify:"gate".
const TRIVIAL_CMDS = new Set(["true", ":", ""]);

function hasRealFeatureGate(ledger: AuthorabilityLedgerLike): boolean {
  const feature = ledger?.feature;
  if (typeof feature !== "object" || feature === null) return false;
  const cmds = (feature as { verifyCmds?: unknown }).verifyCmds;
  if (!Array.isArray(cmds)) return false;
  return cmds.some((c) => typeof c === "string" && !TRIVIAL_CMDS.has(c.trim()));
}

// Unambiguous apply/deploy invocations — an ERROR in a non-gated task. Kept
// deliberately narrow (specific command names, not bare "migration"/"deploy")
// so the hard-block tier stays low-false-positive. The softer signals below are
// warnings. Note: the /ralph skill's full-doc scan + the runtime self-block
// (policy §2) are the primary gating layers; this is a cheap extra net on the
// derived ledger, which only sees a task's title + pointer.
// The core list: apply commands every repo shares. A repo adds its own deploy /
// data-change commands through its adapter (`forbiddenCommands`).
export const CORE_HARD_PATTERNS: RegExp[] = [
  /\bdb:migrate\b/i,
  /\bdrizzle-kit\s+migrate\b/i,
  /--dangerously-skip-permissions/i,
];

const SOFT_PROD_PATTERNS: RegExp[] = [
  /\bapply\b[^.]*\bmigration\b/i,
  /\bmigration\b[^.]*\bapply\b/i,
  /\bdeploy\b/i,
  /\bcutover\b/i,
  /\bflip\b[^.]*\bflag\b/i,
  /\bproduction\b/i,
  /\blive\s+db\b/i,
];

/**
 * Validate a Ralph ledger for authorability. Pure and side-effect-free. See the
 * file header for the two severity tiers. `errors` being non-empty ⇒ `ok:false`
 * (hard block); `warnings` never affect `ok`.
 */
export interface AuthorabilityOptions {
  /**
   * Does `path` exist on origin/main? Enables the "evidence nobody creates"
   * warning on doc-contains gate checks. Omitted → that check is skipped.
   */
  fileExistsOnMain?: (path: string) => boolean;
  /** This repo's gate context (its prod readers and repo-provided check types). Omitted → core checks only. */
  ctx?: GateContext;
  /** The repo's extra apply/deploy commands (adapter `forbiddenCommands`), hard-blocked in a non-gated task. */
  forbidden?: RegExp[];
  /** Shape errors for one repo-provided check (the repo's `gateChecks.command validate`). */
  validateExtra?: (check: Record<string, unknown>) => string[];
}

/** The repo-bound options, from its adapter: ctx, forbidden commands, and the repo check validator. */
export function adapterOptions(adapter: Adapter, run: RunCheck = realRunCheck): AuthorabilityOptions {
  return {
    ctx: contextFrom(adapter),
    forbidden: adapter.forbiddenCommands.map((src) => new RegExp(src, "i")),
    validateExtra: (check) => validateExtraCheck(adapter, check, run),
  };
}

/** Every `file` a gate's doc-contains check reads. */
function docContainsFiles(doneWhen: unknown): string[] {
  const checks = Array.isArray(doneWhen) ? doneWhen : [doneWhen];
  return checks
    .filter((c): c is { type: string; file: string } => {
      const o = c as { type?: unknown; file?: unknown } | null;
      return o !== null && typeof o === "object" && o.type === "doc-contains" && typeof o.file === "string";
    })
    .map((c) => c.file.trim())
    .filter(Boolean);
}

export function validateLedgerAuthorability(
  ledger: AuthorabilityLedgerLike,
  opts: AuthorabilityOptions = {},
): AuthorabilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const rawTasks = ledger?.tasks;
  if (!Array.isArray(rawTasks)) {
    return { ok: false, errors: ['ledger has no "tasks" array'], warnings };
  }

  const realGate = hasRealFeatureGate(ledger);
  // What the ledger's own tasks say they write: a file named in any non-gate
  // task's title / pointer / verify / notes counts as "created by a task".
  const taskText = rawTasks
    .filter((t) => (t as AuthorabilityTaskLike)?.human_gate !== true && (t as AuthorabilityTaskLike)?.kind !== "decision")
    .map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      return ["title", "pointer", "verify", "notes"].map((k) => (typeof o[k] === "string" ? o[k] : "")).join(" ");
    })
    .join("\n");

  rawTasks.forEach((t, index) => {
    const obj = (t ?? {}) as AuthorabilityTaskLike;
    const id = typeof obj.id === "string" && obj.id !== "" ? obj.id : "";
    const label = id !== "" ? `task "${id}"` : `task at index ${index}`;

    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    if (title === "") errors.push(`${label} has a missing or empty "title"`);

    const pointer = typeof obj.pointer === "string" ? obj.pointer.trim() : "";
    if (pointer === "") {
      errors.push(
        `${label} has a missing or empty "pointer" — an iteration can't locate its slice without one`,
      );
    }

    const gated = obj.human_gate === true;
    const searchText = `${title} ${pointer}`;

    // ---- kind (routes the task through the PR pipeline) ----
    // Required on every task the loop could still run; a done task (old
    // ledgers) or a human gate may omit it.
    const runnable = !gated && obj.status !== "done";
    const kind = obj.kind;
    if (kind === undefined || kind === null) {
      if (runnable) {
        errors.push(
          `${label} has no "kind" — declare one of ${TASK_KINDS.join(" | ")} (it decides whether the task gets a red-test stage and how it is verified).`,
        );
      }
    } else if (typeof kind !== "string" || !(TASK_KINDS as readonly string[]).includes(kind)) {
      errors.push(
        `${label} has an unknown "kind" (${String(kind)}) — use one of ${TASK_KINDS.join(" | ")}.`,
      );
    } else if (kind === "decision" && !gated) {
      errors.push(
        `${label} is a decision task but not human_gate — a decision is always Matt's; set human_gate:true.`,
      );
    } else if (!gated && typeof obj.verify === "string") {
      const v = obj.verify.trim();
      if (kind === "code" && v === VERIFY_MANUAL) {
        errors.push(
          `${label} is a code task with verify:"manual" — code is proven by its red tests + the gate. If part of it can only be judged by eye or measured on a live box, split that part into its own "measure" task.`,
        );
      } else if ((kind === "docs" || kind === "measure") && v === VERIFY_GATE) {
        errors.push(
          `${label} is a ${kind} task with verify:"gate" — tsc + tests prove nothing about ${kind === "docs" ? "a doc" : "recorded numbers"}; give it an artifact check (test -f … && grep -q …) or "manual".`,
        );
      }
    }

    // ---- done_when (gates only) ----
    // A gate is never run; tick-gates.ts ticks it from this evidence check. An
    // open gate without one could only be ticked by hand, which is the chore
    // this exists to remove. A non-gate is proven by its own PR, so a done_when
    // there is a mistake.
    const isGateTask = gated || obj.kind === "decision";
    if (isGateTask && obj.status !== "done") {
      const ctx = opts.ctx ?? NO_CONTEXT;
      const shapeErrors = validateDoneWhen(obj.done_when, ctx);
      // Repo-provided checks: the repo's own command judges their shape.
      if (shapeErrors.length === 0 && opts.validateExtra) {
        extraChecks(obj.done_when, ctx).forEach((c) => shapeErrors.push(...opts.validateExtra!(c)));
      }
      for (const e of shapeErrors) {
        errors.push(
          `${label} is a human gate with an invalid "done_when" (${e}) — give it one of the fixed checks (${checkTypes(ctx).join(" | ")}), anchored to the PR / issue / file it waits on (pr-merged, prod-includes and issue-closed take an optional "repo": "owner/name"), so Ralph can tick it itself.`,
        );
      }
    } else if (!isGateTask && obj.done_when !== undefined && obj.done_when !== null) {
      errors.push(`${label} has a "done_when" but is not a human gate — only gates carry one; drop it.`);
    }

    // ---- evidence nobody creates (warn) ----
    // 2026-10-12: gates waited on doc-contains in a log file that did not exist
    // and that no task wrote, so Matt would have hand-written the evidence.
    if (isGateTask && obj.status !== "done" && opts.fileExistsOnMain) {
      for (const file of docContainsFiles(obj.done_when)) {
        if (!opts.fileExistsOnMain(file) && !taskText.includes(file)) {
          warnings.push(
            `${label} waits on doc-contains in "${file}", which does not exist on origin/main and no task writes it — nobody will create that evidence, so Matt would hand-write it. Prefer evidence that appears by itself (pr-merged, prod-includes, issue-closed, or a repo check on a table the measurement writes), or have a task write that file.`,
          );
        }
      }
    }

    // ---- blind_check (measure only) ----
    if (obj.blind_check !== undefined && obj.blind_check !== false) {
      if (obj.blind_check !== true) {
        errors.push(`${label} has a non-boolean "blind_check" — use true or omit it.`);
      } else if (kind !== "measure") {
        errors.push(
          `${label} has blind_check:true but is a ${String(kind)} task — only a measure task gets the independent blind-check stage.`,
        );
      }
    }

    // ---- size (code only) ----
    if (obj.size !== undefined) {
      if (typeof obj.size !== "string" || !(SIZES as readonly string[]).includes(obj.size)) {
        errors.push(`${label} has an unknown "size" (${String(obj.size)}) — use one of ${SIZES.join(" | ")}, or omit it (= standard).`);
      } else if (obj.size === "small" && kind !== "code") {
        errors.push(
          `${label} has size:"small" but is a ${String(kind)} task — only a code task has a red and a check stage to drop.`,
        );
      }
    }

    // ---- files / unbatched (shape; the batching check runs after the loop) ----
    if (obj.files !== undefined && !isStringArray(obj.files)) {
      errors.push(
        `${label} has a malformed "files" (${describeType(obj.files)}) — use an array of repo-relative paths the task edits.`,
      );
    }
    if (obj.unbatched !== undefined && typeof obj.unbatched !== "string") {
      errors.push(
        `${label} has a non-string "unbatched" (${describeType(obj.unbatched)}) — use a reason string, or omit it.`,
      );
    }
    if (runnable && kind === "code" && obj.size === "small" && filesOf(obj).length === 0) {
      warnings.push(
        `${label} is a small code task with no "files" — list the repo paths it edits so the batching check can compare it with its same-file neighbours.`,
      );
    }

    // ---- verify declaration (the core authorability check) ----
    const verify = obj.verify;
    if (gated) {
      // Gated tasks are surfaced, never auto-run — a verify is not required.
    } else if (verify === null || verify === undefined) {
      errors.push(
        `${label} is not human-gated and has no "verify" — declare a concrete check command, "manual" (parks for human review), or "gate" (the feature verifyCmds fully verify it). A task with no machine-checkable "done" can only be self-graded.`,
      );
    } else if (typeof verify !== "string") {
      errors.push(
        `${label} has a non-string "verify" (${describeType(verify)}) — use a command string, "manual", or "gate".`,
      );
    } else {
      const v = verify.trim();
      if (v === "") {
        errors.push(
          `${label} has an empty "verify" string — use a command, "manual", or "gate".`,
        );
      } else if (v === VERIFY_GATE && !realGate) {
        errors.push(
          `${label} declares verify:"gate" but the feature has no real verifyCmds (only trivial/empty) — give this task a concrete check command or mark it "manual".`,
        );
      }
      // v === VERIFY_MANUAL, v === VERIFY_GATE (with real gate), or a concrete
      // command are all valid.
    }

    // ---- prod-vocabulary safety net (non-gated only) ----
    if (!gated) {
      const hardHit = [...CORE_HARD_PATTERNS, ...(opts.forbidden ?? [])].find((re) => re.test(searchText));
      if (hardHit) {
        errors.push(
          `${label} looks like an apply/deploy step ("${matchText(searchText, hardHit)}") but is not human_gate — set human_gate:true. Writing the code is fine; applying/deploying is a human's deliberate step.`,
        );
      } else {
        const softHit = SOFT_PROD_PATTERNS.find((re) => re.test(searchText));
        if (softHit) {
          warnings.push(
            `${label} mentions prod-touching wording ("${matchText(searchText, softHit)}") but is not human_gate — confirm it only WRITES code; if it applies/deploys/mutates prod, set human_gate:true.`,
          );
        }
      }
    }

    // ---- mega-task heuristic (warn) ----
    const span = pointerLineSpan(pointer);
    if (span !== null && span > MEGA_TASK_LINE_SPAN) {
      warnings.push(
        `${label} spans ~${span} lines (${pointer}) — likely more than one context-window of work; consider splitting it into smaller tasks.`,
      );
    }
  });

  errors.push(...batchingErrors(rawTasks as AuthorabilityTaskLike[]));

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Batching: tiny same-file neighbours are one task, not a chain of PRs.
//
// 2026-11-10: a derived ledger left "remove the Usage tab" and a small "remove
// a chip" — both in the same component, the second depending on the first — as
// two PRs. Every task costs ~3–5 fresh agents, each starting with ~40k tokens
// of fixed context, so a small task chained behind a same-file neighbour is
// waste the skill's advice ("batch tiny neighbours") didn't prevent. This makes
// it mechanical.
//
// The rule: two runnable (not done, not gated) `code` tasks, at least one of
// them `size: "small"`, that share a path in `files`, where one reaches the
// other through `deps` (direct or transitive) → error. A dep path that runs
// through a human gate / decision is not counted: the gate has to happen
// between them, so they can't be one PR. Escape hatch: either task carries a
// non-empty `unbatched` reason.
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** A task's `files`, normalised (trimmed, no leading "./", empties dropped). */
function filesOf(t: AuthorabilityTaskLike): string[] {
  if (!isStringArray(t.files)) return [];
  return t.files.map((f) => f.trim().replace(/^\.\//, "")).filter(Boolean);
}

function hasUnbatchedReason(t: AuthorabilityTaskLike): boolean {
  return typeof t.unbatched === "string" && t.unbatched.trim() !== "";
}

function isGateLike(t: AuthorabilityTaskLike): boolean {
  return t.human_gate === true || t.kind === "decision";
}

function batchingErrors(tasks: AuthorabilityTaskLike[]): string[] {
  const errors: string[] = [];
  const byId = new Map<string, AuthorabilityTaskLike>();
  for (const t of tasks) {
    if (t && typeof t.id === "string" && t.id !== "" && !byId.has(t.id)) byId.set(t.id, t);
  }
  const depsOf = (t: AuthorabilityTaskLike): string[] =>
    Array.isArray(t.deps) ? t.deps.filter((d): d is string => typeof d === "string") : [];
  const candidate = (t: AuthorabilityTaskLike | undefined): t is AuthorabilityTaskLike =>
    !!t && t.kind === "code" && t.status !== "done" && !isGateLike(t);

  for (const later of byId.values()) {
    if (!candidate(later)) continue;
    const laterFiles = filesOf(later);
    if (laterFiles.length === 0) continue;

    // Every task `later` reaches through deps, not walking through a gate.
    const seen = new Set<string>([later.id as string]);
    const stack = depsOf(later);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const earlier = byId.get(id);
      if (!earlier || isGateLike(earlier)) continue;
      stack.push(...depsOf(earlier));

      if (!candidate(earlier)) continue;
      if (later.size !== "small" && earlier.size !== "small") continue;
      const earlierFiles = new Set(filesOf(earlier));
      const shared = [...new Set(laterFiles)].filter((f) => earlierFiles.has(f));
      if (shared.length === 0) continue;
      if (hasUnbatchedReason(later) || hasUnbatchedReason(earlier)) continue;

      const emptyReason =
        later.unbatched !== undefined || earlier.unbatched !== undefined
          ? ' An empty "unbatched" is not a reason.'
          : "";
      errors.push(
        `tasks "${earlier.id}" and "${later.id}" both edit ${shared.map((f) => `"${f}"`).join(", ")} and "${later.id}" depends on "${earlier.id}", with at least one of them size:"small" — merge them into one task (one PR; its pointer can list both sections), or add "unbatched": "<reason>" to say why they must be separate PRs.${emptyReason}`,
      );
    }
  }
  return errors;
}

// A slice bigger than this many lines probably bundles more than one unit of
// work. Conservative on purpose — this is a warning, not a block.
const MEGA_TASK_LINE_SPAN = 150;

/**
 * Parse the `lines A,B` / `lines A-B` hints out of a pointer → total span, or
 * null when there is none. A multi-section pointer
 * (`<doc> §S12 — lines 10,20; §S13 — lines 40,55`) sums its ranges: the task
 * covers every listed section, so its size is all of them together.
 */
export function pointerLineSpan(pointer: string): number | null {
  let total: number | null = null;
  for (const m of pointer.matchAll(/lines?\s+(\d+)\s*[,\-–]\s*(\d+)/gi)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    total = (total ?? 0) + Math.abs(b - a);
  }
  return total;
}

/** The matched substring for a nicer error/warning message. */
function matchText(text: string, re: RegExp): string {
  return (text.match(re)?.[0] ?? "").trim();
}

/** Human-readable type label (distinguishes null/array from typeof). */
function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ---------------------------------------------------------------------------
// CLI wrapper: `tsx src/ralph/validate-ledger-authorability.ts <ledger.json>`
// Prints each error and warning to stderr. Exits 1 if there are errors; exits 0
// otherwise (warnings alone do NOT fail — they are advisory).
// ---------------------------------------------------------------------------
/** `git cat-file -e origin/main:<path>` — true when the file is on main. Fails open (no warning) when git can't answer. */
export function fileExistsOnMain(path: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `origin/main:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    try {
      // No origin/main ref at all (fresh clone without fetch): don't warn.
      execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  }
}

export function runCli(argv: string[], repoOptions: () => AuthorabilityOptions = () => adapterOptions(loadAdapter())): number {
  const path = argv[2];
  if (!path) {
    console.error(
      "usage: node <ralph>/lib/validate-ledger-authorability.ts <ledger.json>",
    );
    return 1;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`cannot read ledger file "${path}": ${(err as Error).message}`);
    return 1;
  }

  let ledger: unknown;
  try {
    ledger = JSON.parse(raw);
  } catch (err) {
    console.error(`ledger "${path}" is not valid JSON: ${(err as Error).message}`);
    return 1;
  }

  if (
    typeof ledger !== "object" ||
    ledger === null ||
    !Array.isArray((ledger as AuthorabilityLedgerLike).tasks)
  ) {
    console.error(`ledger "${path}" has no "tasks" array`);
    return 1;
  }

  let repoOpts: AuthorabilityOptions;
  try {
    repoOpts = repoOptions();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const result = validateLedgerAuthorability(ledger as AuthorabilityLedgerLike, { ...repoOpts, fileExistsOnMain });
  for (const w of result.warnings) console.error(`ledger authorability warning: ${w}`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`ledger authorability error: ${e}`);
    console.error(
      `ledger not authorable: ${result.errors.length} error(s) in "${path}"`,
    );
    return 1;
  }

  const n = ((ledger as AuthorabilityLedgerLike).tasks as unknown[]).length;
  const wtail = result.warnings.length
    ? ` (${result.warnings.length} warning(s))`
    : "";
  console.log(`ledger ok: ${n} tasks, authorable${wtail}`);
  return 0;
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) {
  process.exit(runCli(process.argv));
}
