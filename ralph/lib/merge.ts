// Ralph SCRIPTED MERGE — the merge stage's happy path, with no LLM in it.
//
// Before 2026-11-02 every merge was a Sonnet agent doing a fixed recipe: catch
// the branch up with origin/main, run the type check + the full gate, squash-merge.
// Each agent started with ~40k tokens of fixed context (CLAUDE.md + the policy)
// for a job with no judgement in it when the gate is green. This script does
// that recipe. Anything that DOES need judgement — a merge conflict, a red gate
// (flake procedure + attribution, policy §merge step 2), a refused guard, a
// plumbing error — comes back as a status, and the loop hands it to the merge
// agent with what the script already found, so the gate is never run twice for
// nothing.
//
// Every repo-specific part comes from the adapter (`.claude/ralph.json`):
//   - `merge.guard` runs first (the app's additive-migration check); ok=false →
//     `guardrail`, nothing pushed, the agent parks the PR.
//   - `commands.typecheck` then `commands.mergeGate` — the gate goes through
//     `merge.gateWrapper` when set (e.g. a machine-wide lock shared with other heavy jobs). The
//     wrapper's `busyExitCode` means "another heavy job holds it": the script
//     retries until `busyWaitMinutes`, then returns `busy` (the loop skips the
//     task this run). It never runs the gate beside another heavy job.
//   - `merge.waitForCi` waits for the PR's GitHub checks (a red check is red).
//
// CLI (run from the stage worktree; prints ONE JSON MergeResult, exit 0 whenever
// it printed one, 1 on a usage error):
//   node <ralph>/lib/merge.ts --pr <n> --branch <ralph/...> --ledger <json> --task <id>
//
// The one conflict it resolves itself is the routine one (policy §"Ledger
// conflicts"): only the ledger JSON and its rendered .md conflict → take
// origin/main's ledger, re-apply this task's own fields, re-render the .md.
//
// Only `node:` imports.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAdapter, type Adapter } from "./adapter.ts";
import { isEntryPoint } from "./is-entry-point.ts";
import { ledgerMdPath, renderLedgerMd } from "./render-ledger.ts";
import { lastJson } from "./repo-check.ts";

export type MergeStatus = "merged" | "conflict" | "red" | "busy" | "guardrail" | "error";

export interface MergeResult {
  status: MergeStatus;
  /** Branch head the gate ran on (after catching up with origin/main), "" if none. */
  sha: string;
  /** Migration files this PR adds (adapter merge.migrations), comma-separated, "" if none. */
  migrationAdded: string;
  /** red only: true when the type check failed (no test run happened). */
  typecheckFailed: boolean;
  /** red only: true when the local gate passed but the PR's CI did not. */
  ciFailed: boolean;
  /** red only: test files with a failure, repo-relative, sorted. */
  failedFiles: string[];
  /** guardrail only: why the guard refused. */
  guardReasons: string[];
  /** The adapter's merge.afterMigration, read from .claude/ralph.json by this script, so the
   *  workflow's stop-after-migration never depends on an agent copying the adapter. */
  afterMigration: "continue" | "stop";
  /** Plain one-line explanation for the run log and the fallback agent. */
  message: string;
  /** Tail of the failing command's output (red / error), "" otherwise. */
  detail: string;
}

export interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program with args (git, gh). */
export type Run = (cmd: string, args: string[]) => RunOut;
/** Run a shell command line (the adapter's commands). */
export type Sh = (command: string) => RunOut;

export interface MergeDeps {
  run: Run;
  sh: Sh;
  writeFile(path: string, text: string): void;
  readFile(path: string): string | null;
  /** A fresh path for vitest's JSON report. */
  reportPath(): string;
  /** The repo root, to make vitest's absolute file names repo-relative. */
  repoRoot(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
  adapter: Adapter;
}

const tail = (s: string, n = 40) => s.split("\n").slice(-n).join("\n");
const both = (o: RunOut) => `${tail(o.stderr)}\n--- stdout ---\n${tail(o.stdout)}`;

function result(status: MergeStatus, fields: Partial<MergeResult>): MergeResult {
  return {
    status, sha: "", migrationAdded: "", typecheckFailed: false, ciFailed: false, failedFiles: [], guardReasons: [],
    // "stop" until runMerge stamps the adapter's real value: a result with no adapter behind it
    // (it failed to load) must never let a run carry on past a merged migration.
    afterMigration: "stop", message: "", detail: "", ...fields,
  };
}

/** Repo-relative test files with at least one failure, from vitest's JSON report. */
export function failedFilesFromVitestJson(json: string, repoRoot: string): string[] {
  let report: { testResults?: { name?: string; status?: string }[] };
  try {
    report = JSON.parse(json);
  } catch {
    return [];
  }
  const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  const files = (report.testResults ?? [])
    .filter((t) => t.status === "failed" && typeof t.name === "string")
    .map((t) => (t.name!.startsWith(root) ? t.name!.slice(root.length) : t.name!));
  return [...new Set(files)].sort();
}

/** The task fields a task PR may change in the ledger (policy §"Ledger hygiene"). */
export const TASK_TICK_FIELDS = ["status", "attempts", "notes", "updatedAt", "commit"] as const;

/**
 * Serialise a ledger the way the file on main is written (2-space JSON, trailing
 * newline; non-ASCII \u-escaped when the file on main has no raw non-ASCII), so
 * a resolution diff shows only the tick.
 */
export function formatLedgerLike(value: unknown, like: string): string {
  let text = JSON.stringify(value, null, 2);
  if (!/[^\x00-\x7e]/.test(like)) {
    text = text.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  return text + "\n";
}

/** origin/main's ledger with ONLY this task's tick fields taken from the branch's ledger. */
export function reapplyTaskTick(mainText: string, branchText: string, taskId: string): string {
  type T = Record<string, unknown> & { id?: string };
  const main = JSON.parse(mainText) as { tasks: T[] };
  const branch = JSON.parse(branchText) as { tasks: T[] };
  const mine = branch.tasks.find((t) => t.id === taskId);
  const target = main.tasks.find((t) => t.id === taskId);
  if (!mine || !target) throw new Error(`task ${taskId} is missing from the ${mine ? "main" : "branch"} ledger`);
  for (const k of TASK_TICK_FIELDS) if (k in mine) target[k] = mine[k];
  return formatLedgerLike(main, mainText);
}

/** The happy path, step by step. Every git/gh call goes through `deps.run`, every adapter command through `deps.sh`. */
export interface MergeTarget {
  pr: number;
  branch: string;
  ledger: string;
  task: string;
}

/** Poll intervals (ms). Exported so tests can see what the script waits on. */
export const BUSY_POLL_MS = 10_000;
export const CI_POLL_MS = 20_000;
/** A PR whose head has no checks after this long has no CI to wait for. */
export const CI_NONE_AFTER_MS = 120_000;

export async function runMerge(target: MergeTarget, deps: MergeDeps): Promise<MergeResult> {
  return { ...(await mergeOnce(target, deps)), afterMigration: deps.adapter.merge.afterMigration };
}

async function mergeOnce({ pr, branch, ledger, task }: MergeTarget, deps: MergeDeps): Promise<MergeResult> {
  const { run, sh, adapter } = deps;
  const m = adapter.merge;
  const must = (o: RunOut, what: string): MergeResult | null =>
    o.code === 0 ? null : result("error", { message: `${what} failed (exit ${o.code})`, detail: both(o) });

  // Policy §merge step 0: the repo's guard, before anything is pushed.
  if (m.guard) {
    const g = sh(m.guard.replaceAll("{pr}", String(pr)));
    const out = lastJson(g.stdout) as { ok?: unknown; reasons?: unknown } | null;
    if (!out || typeof out.ok !== "boolean") {
      return result("guardrail", {
        guardReasons: [`the merge guard did not answer (exit ${g.code})`],
        message: `the merge guard (${m.guard}) gave no verdict, so the PR parks`,
        detail: both(g),
      });
    }
    if (!out.ok) {
      const reasons = Array.isArray(out.reasons) ? out.reasons.map(String) : [];
      return result("guardrail", { guardReasons: reasons, message: `the merge guard refused: ${reasons.join("; ") || "no reason given"}` });
    }
  }

  let e = must(run("git", ["fetch", "origin", "main", branch, "--quiet"]), "git fetch");
  if (e) return e;
  e = must(run("git", ["switch", "--detach", `origin/${branch}`]), `checking out origin/${branch}`);
  if (e) return e;
  const lockAt = () => (m.lockfile ? run("git", ["rev-parse", `HEAD:${m.lockfile}`]).stdout.trim() : "");
  const lockBefore = lockAt();
  const branchHead = run("git", ["rev-parse", "HEAD"]).stdout.trim();

  // Catch up with origin/main (policy §merge step 1). A conflict needs judgement → the agent.
  if (run("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]).code !== 0) {
    const mg = run("git", ["merge", "--no-edit", "origin/main"]);
    if (mg.code !== 0) {
      const why = resolveLedgerOnlyConflict(run, deps.writeFile, ledger, task, branchHead);
      if (why !== "") {
        run("git", ["merge", "--abort"]);
        return result("conflict", { message: `merging origin/main into ${branch} conflicts: ${why}`, detail: both(mg) });
      }
    }
    e = must(run("git", ["push", "origin", `HEAD:${branch}`]), "pushing the catch-up merge");
    if (e) return e;
  }
  const sha = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (m.lockfile && m.install && lockAt() !== lockBefore) {
    e = must(sh(m.install), `${m.install} after a lockfile change`);
    if (e) return { ...e, sha };
  }
  const pattern = new RegExp(m.migrations.pattern);
  const migrationAdded = run("git", ["diff", "--name-only", "--diff-filter=A", "origin/main...HEAD", "--", m.migrations.dir])
    .stdout.split("\n")
    .filter((f) => f !== "" && f.startsWith(`${m.migrations.dir}/`) && pattern.test(f))
    .join(",");

  // The gate (policy §merge step 2).
  const tc = sh(adapter.commands.typecheck);
  if (tc.code !== 0) {
    return result("red", { sha, migrationAdded, typecheckFailed: true, message: `${adapter.commands.typecheck} failed`, detail: both(tc) });
  }
  const report = m.vitestJson ? deps.reportPath() : "";
  const gateCmd = [
    m.gateWrapper,
    adapter.commands.mergeGate,
    report ? `--reporter=default --reporter=json --outputFile.json=${report}` : "",
  ].filter(Boolean).join(" ");
  const deadline = deps.now() + m.busyWaitMinutes * 60_000;
  let gate: RunOut;
  for (;;) {
    gate = sh(gateCmd);
    if (!(m.gateWrapper && m.busyExitCode && gate.code === m.busyExitCode)) break;
    if (deps.now() >= deadline) {
      return result("busy", { sha, migrationAdded, message: `the merge gate did not run: ${tail(gate.stderr, 3).trim() || "its wrapper is busy"}` });
    }
    await deps.sleep(BUSY_POLL_MS);
  }
  if (gate.code !== 0) {
    const json = report ? deps.readFile(report) ?? "" : "";
    const files = failedFilesFromVitestJson(json, deps.repoRoot());
    const message = files.length
      ? `${adapter.commands.mergeGate} failed in ${files.length} file(s)`
      : `${adapter.commands.mergeGate} failed and reported no failing file (a crash or a setup error)`;
    return result("red", { sha, migrationAdded, failedFiles: files, message, detail: both(gate) });
  }

  // The PR's CI, when the repo gates on it too: a red check is red like a local failure.
  if (m.waitForCi) {
    const ci = await waitForChecks(pr, sha, deps);
    if (ci.state === "fail") {
      return result("red", { sha, migrationAdded, ciFailed: true, message: `the PR's CI failed: ${ci.failed.join(", ")}`, detail: ci.detail });
    }
    if (ci.state === "timeout") {
      return result("error", { sha, migrationAdded, message: `the PR's CI was still running after ${m.ciTimeoutMinutes} min: ${ci.pending.join(", ")}` });
    }
  }

  // Land it (policy §merge step 3). `gh pr ready` fails on a PR that is already ready: fine.
  run("gh", ["pr", "ready", String(pr)]);
  const mergeOut = run("gh", ["pr", "merge", String(pr), "--squash", "--delete-branch"]);
  if (mergeOut.code !== 0) {
    // --delete-branch can fail AFTER the merge landed (e.g. the local branch); trust GitHub.
    const state = run("gh", ["pr", "view", String(pr), "--json", "state", "--jq", ".state"]).stdout.trim();
    if (state !== "MERGED") return result("error", { sha, migrationAdded, message: `gh pr merge ${pr} failed (exit ${mergeOut.code})`, detail: both(mergeOut) });
  }
  return result("merged", { sha, migrationAdded, message: `PR #${pr} squash-merged at ${sha.slice(0, 8)}` });
}

interface CheckRow {
  name: string;
  bucket: string;
}

/**
 * Wait until every check on the PR's head is done. `bucket` is gh's summary:
 * pass | fail | pending | skipping | cancel. A head with no checks after
 * CI_NONE_AFTER_MS has no CI (pass).
 */
export async function waitForChecks(
  pr: number,
  sha: string,
  deps: Pick<MergeDeps, "run" | "sleep" | "now" | "adapter">,
): Promise<{ state: "pass" | "fail" | "timeout"; failed: string[]; pending: string[]; detail: string }> {
  const start = deps.now();
  const deadline = start + deps.adapter.merge.ciTimeoutMinutes * 60_000;
  let pending: string[] = [];
  for (;;) {
    // gh exits non-zero while checks are pending or failed; the JSON is what counts.
    const head = deps.run("gh", ["pr", "view", String(pr), "--json", "headRefOid", "--jq", ".headRefOid"]).stdout.trim();
    const o = deps.run("gh", ["pr", "checks", String(pr), "--json", "name,bucket"]);
    let rows: CheckRow[] = [];
    try {
      rows = JSON.parse(o.stdout) as CheckRow[];
    } catch {
      rows = [];
    }
    const onHead = head === "" || head === sha;
    if (onHead && rows.length > 0) {
      const failed = rows.filter((r) => r.bucket === "fail" || r.bucket === "cancel").map((r) => r.name);
      pending = rows.filter((r) => r.bucket === "pending").map((r) => r.name);
      if (failed.length) return { state: "fail", failed, pending, detail: tail(o.stdout) };
      if (pending.length === 0) return { state: "pass", failed: [], pending: [], detail: "" };
    } else if (onHead && deps.now() - start >= CI_NONE_AFTER_MS) {
      return { state: "pass", failed: [], pending: [], detail: "no checks on the PR" };
    }
    if (deps.now() >= deadline) return { state: "timeout", failed: [], pending, detail: "" };
    await deps.sleep(CI_POLL_MS);
  }
}

/**
 * After a conflicted `git merge`: if ONLY the ledger JSON and/or its .md conflict,
 * resolve them per the policy and commit the merge. Returns "" when resolved,
 * else why not (the caller aborts the merge and hands it to the agent).
 */
export function resolveLedgerOnlyConflict(
  run: Run,
  writeFile: (path: string, text: string) => void,
  ledger: string,
  task: string,
  branchHead: string,
): string {
  const md = ledgerMdPath(ledger);
  const conflicted = run("git", ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
  const others = conflicted.filter((f) => f !== ledger && f !== md);
  if (conflicted.length === 0) return "the merge failed without a conflicted file";
  if (others.length) return `files other than the ledger conflict (${others.join(", ")})`;
  const mainText = run("git", ["show", `origin/main:${ledger}`]);
  const branchText = run("git", ["show", `${branchHead}:${ledger}`]);
  if (mainText.code !== 0 || branchText.code !== 0) return "could not read both sides of the ledger";
  let text: string;
  try {
    text = reapplyTaskTick(mainText.stdout, branchText.stdout, task);
  } catch (e) {
    return (e as Error).message;
  }
  writeFile(ledger, text);
  writeFile(md, renderLedgerMd(JSON.parse(text), ledger));
  if (run("git", ["add", ledger, md]).code !== 0) return "git add of the resolved ledger failed";
  if (run("git", ["commit", "--no-edit"]).code !== 0) return "committing the resolved merge failed";
  return "";
}

// ---------------------------------------------------------------------------
// Real deps + CLI
// ---------------------------------------------------------------------------
const realRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 << 20 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
};
const realSh: Sh = (command) => realRun("sh", ["-c", command]);

export function parseArgs(argv: string[]): MergeTarget | string {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pr = Number(get("--pr"));
  const branch = get("--branch") ?? "";
  const ledger = get("--ledger") ?? "";
  const task = get("--task") ?? "";
  if (!Number.isInteger(pr) || pr <= 0) return "--pr <n> is required";
  if (!branch.startsWith("ralph/")) return "--branch must be a ralph/<slug>/<id> task branch";
  if (!ledger.endsWith("-LEDGER.json")) return "--ledger <docs/ralph/<slug>-LEDGER.json> is required";
  if (!task) return "--task <id> is required";
  return { pr, branch, ledger, task };
}

if (isEntryPoint(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (typeof a === "string") {
    console.error(`usage: node <ralph>/lib/merge.ts --pr <n> --branch <ralph/...> --ledger <json> --task <id>\n${a}`);
    process.exit(1);
  }
  let adapter: Adapter;
  try {
    adapter = loadAdapter();
  } catch (err) {
    console.log(JSON.stringify(result("error", { message: (err as Error).message }), null, 2));
    process.exit(0);
  }
  const deps: MergeDeps = {
    run: realRun,
    sh: realSh,
    writeFile: (p, t) => writeFileSync(p, t),
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null; // no report: a crash before vitest wrote it
      }
    },
    reportPath: () => join(mkdtempSync(join(tmpdir(), "ralph-gate-")), "vitest.json"),
    repoRoot: () => realRun("git", ["rev-parse", "--show-toplevel"]).stdout.trim(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    adapter,
  };
  runMerge(a, deps)
    .catch((e: unknown) => result("error", { message: "the merge script crashed", detail: String((e as Error)?.stack ?? e) }))
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    });
}
