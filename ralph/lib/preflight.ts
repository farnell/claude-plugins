// Ralph RUN PREFLIGHT — the environment checks that stop a run with a plain
// message BEFORE any stage spends tokens.
//
// Two failures from the first real run (embeddings-v2 follow-ups, 2026-10-10..12)
// that this exists for:
//
//   1. DISK. Stage worktrees (~1 GB each) piled up to 143 GB; free disk fell low
//      enough that a test failed and blocked a merge. The preflight first sweeps
//      stale stage worktrees (worktrees.ts), THEN requires a free-disk floor.
//   2. A BROKEN INSTALL LOOKED LIKE A MYSTERY. `pnpm --silent tsx
//      src/ralph/next-step.ts` exited 1 with NO output: pnpm wanted to purge and
//      reinstall node_modules, could not ask without a terminal
//      (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY), and `--silent` swallowed
//      the reason. The preflight runs the repo's install probe (adapter
//      `installProbe`, e.g. `pnpm exec vitest --version`) with no TTY, keeps
//      stdout AND stderr (pnpm prints its own errors on stdout), and translates
//      the known codes into an instruction. (Ralph's own helpers no longer need
//      the install: they run on plain node. The stages' tests still do.)
//   3. A MISSING OR BROKEN ADAPTER (`.claude/ralph.json`) stops the run here,
//      with the adapter's own error list, before any prompt is built from it.
//
// Only `node:` imports (and `.ts` siblings), so `node <ralph>/lib/preflight.ts`
// runs on Node's native type stripping with NO node_modules — the check for a
// broken install cannot itself need the install.
//
// CLI: `node <ralph>/lib/preflight.ts` → prints one JSON {ok, error, warnings, adapter,
// freeGb, sweep}; exit 0 when ok, 1 otherwise. Env: RALPH_MIN_FREE_GB (default:
// the adapter's minFreeGb, else 25), RALPH_SWEEP_AGE_HOURS (default 24).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadAdapter, type Adapter } from "./adapter.ts";
import { freeBytesAt } from "./free-bytes.ts";
import { sweepStageWorktrees, DEFAULT_SWEEP_AGE_HOURS, type CleanupRow } from "./worktrees.ts";
import { isEntryPoint } from "./is-entry-point.ts";

const GB = 1024 ** 3;

/**
 * Free disk a run needs. A run creates one ~1 GB worktree per stage (removed at
 * the stage's end since 2026-10-12, but a crashed stage can leave one) and the
 * check and merge stages run the repo's tests there. A repo sets its own floor
 * (adapter `minFreeGb`); `RALPH_MIN_FREE_GB` overrides both.
 */
export const DEFAULT_MIN_FREE_GB = 25;

export interface Verdict {
  ok: boolean;
  error: string;
}

export function diskVerdict(freeBytes: number, minFreeGb: number, path: string): Verdict {
  const freeGb = freeBytes / GB;
  if (freeGb >= minFreeGb) return { ok: true, error: "" };
  return {
    ok: false,
    error:
      `Not enough free disk: ${freeGb.toFixed(1)} GB free on ${path}, Ralph needs at least ${minFreeGb} GB ` +
      `(each stage makes a ~1 GB worktree and the check and merge stages run the tests in it). ` +
      `Free some space — list leftover worktrees with \`git worktree list\` and remove old ones with ` +
      `\`git worktree remove <path>\`, or run \`node <ralph>/lib/worktrees.ts sweep --older-than-hours 1\` ` +
      `to remove every clean, pushed stage worktree — then re-run /ralph.`,
  };
}

export interface ProbeResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Last `n` non-empty lines of a stream, for an error message that stays short. */
export function tail(text: string, n = 15): string {
  return text.split("\n").filter((l) => l.trim() !== "").slice(-n).join("\n");
}

// Known install failures → what to do. Matched against stdout+stderr combined.
const KNOWN_INSTALL_ERRORS: { re: RegExp; say: string }[] = [
  {
    re: /ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY|ABORTED_REMOVE_MODULES_DIR/,
    say:
      "node_modules is out of step with pnpm's settings or lockfile, and pnpm wants to delete and reinstall it but cannot ask without a terminal",
  },
  { re: /ERR_PNPM_OUTDATED_LOCKFILE|lockfile.*(not up to date|out of date)/i, say: "pnpm-lock.yaml does not match package.json" },
  { re: /VERIFY_DEPS_BEFORE_RUN|ERR_PNPM_VERIFY_DEPS/i, say: "the installed packages do not match pnpm-lock.yaml" },
  { re: /Command "tsx" not found|tsx: (command )?not found|Cannot find (module|package) ['"]?tsx/i, say: "tsx is not installed" },
];

/** Turn a failed helper command into one plain sentence + the raw output. */
export function explainHelperFailure(cmd: string, r: ProbeResult, checkout: string): string {
  const raw = `${r.stdout}\n${r.stderr}`;
  const known = KNOWN_INSTALL_ERRORS.find((k) => k.re.test(raw));
  const head = known
    ? `The package install is broken: ${known.say}. Run \`pnpm install\` yourself in ${checkout} (answer its prompt), then re-run /ralph.`
    : `\`${cmd}\` failed (exit ${r.status}).`;
  const out = tail(raw);
  return out ? `${head}\n--- output ---\n${out}` : `${head} It printed nothing.`;
}

export function installVerdict(nodeModulesExists: boolean, probe: ProbeResult | null, checkout: string, probeCmd = "the install probe"): Verdict {
  if (!nodeModulesExists) {
    return {
      ok: false,
      error: `node_modules is missing in ${checkout}. Run \`pnpm install\` there, then re-run /ralph.`,
    };
  }
  if (probe && probe.status !== 0) {
    return { ok: false, error: explainHelperFailure(probeCmd, probe, checkout) };
  }
  return { ok: true, error: "" };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------
export interface PreflightDeps {
  cwd?: string;
  freeBytes?: (path: string) => number;
  nodeModulesExists?: (checkout: string) => boolean;
  /** Run the adapter's install probe with NO stdin (a TTY-less run, like a stage agent's). */
  probeInstall?: (checkout: string, command: string) => ProbeResult;
  sweep?: (checkout: string, hours: number) => CleanupRow[];
  env?: Record<string, string | undefined>;
  /** The repo's adapter; default: load `.claude/ralph.json` from `cwd`. */
  adapter?: () => Adapter;
}

const realProbe = (checkout: string, command: string): ProbeResult => {
  try {
    const stdout = execFileSync("sh", ["-c", command], {
      cwd: checkout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message ?? "") };
  }
};

export interface PreflightReport {
  ok: boolean;
  error: string;
  warnings: string;
  freeGb: number;
  sweep: { removed: number; kept: number };
  /** The repo's adapter (validated), so the workflow can build its prompts from it. null when it failed to load. */
  adapter: Adapter | null;
}

export function runPreflight(deps: PreflightDeps = {}): PreflightReport {
  const checkout = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  let adapter: Adapter;
  try {
    adapter = (deps.adapter ?? (() => loadAdapter(checkout)))();
  } catch (err) {
    return { ok: false, error: (err as Error).message, warnings: "", freeGb: 0, sweep: { removed: 0, kept: 0 }, adapter: null };
  }
  const floor = adapter.minFreeGb > 0 ? adapter.minFreeGb : DEFAULT_MIN_FREE_GB;
  const minFreeGb = Number(env.RALPH_MIN_FREE_GB) > 0 ? Number(env.RALPH_MIN_FREE_GB) : floor;
  const hours = Number(env.RALPH_SWEEP_AGE_HOURS) > 0 ? Number(env.RALPH_SWEEP_AGE_HOURS) : DEFAULT_SWEEP_AGE_HOURS;
  const warnings: string[] = [];

  // Sweep first, so the space it frees counts toward the floor.
  let rows: CleanupRow[] = [];
  try {
    rows = (deps.sweep ?? ((c, h) => sweepStageWorktrees(c, h)))(checkout, hours);
  } catch (err) {
    warnings.push(`stage-worktree sweep failed: ${(err as Error).message}`);
  }
  const removed = rows.filter((r) => r.removed).length;
  const kept = rows.length - removed;
  if (removed > 0) warnings.push(`removed ${removed} stale stage worktree(s)`);
  const unsafeKept = rows.filter((r) => !r.removed && !/touched .*h ago/.test(r.reason));
  if (unsafeKept.length > 0) {
    warnings.push(
      `${unsafeKept.length} stage worktree(s) kept because they may hold work (e.g. ${unsafeKept[0]!.path}: ${unsafeKept[0]!.reason})`,
    );
  }

  const freeBytes = (deps.freeBytes ?? freeBytesAt)(checkout);
  const freeGb = Math.round((freeBytes / GB) * 10) / 10;
  const report = (v: Verdict): PreflightReport => ({
    ok: v.ok,
    error: v.error,
    warnings: warnings.join("; "),
    freeGb,
    sweep: { removed, kept },
    adapter,
  });

  const disk = diskVerdict(freeBytes, minFreeGb, checkout);
  if (!disk.ok) return report(disk);

  // No probe configured: the repo has no install to check (or does not want one).
  if (!adapter.installProbe) return report({ ok: true, error: "" });
  const nmExists = (deps.nodeModulesExists ?? ((c) => existsSync(join(c, "node_modules"))))(checkout);
  const probe = nmExists ? (deps.probeInstall ?? realProbe)(checkout, adapter.installProbe) : null;
  return report(installVerdict(nmExists, probe, checkout, adapter.installProbe));
}

export function runCli(deps: PreflightDeps = {}): number {
  const r = runPreflight(deps);
  console.log(JSON.stringify(r));
  return r.ok ? 0 : 1;
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) process.exit(runCli());
