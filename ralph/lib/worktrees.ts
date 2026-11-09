// Ralph STAGE-WORKTREE cleanup — "remove each stage's worktree when it ends".
//
// Every Ralph stage runs in a fresh git worktree (`isolation: 'worktree'`, named
// `.claude/worktrees/wf_<run>-<n>`). The harness only auto-removes a worktree
// it sees as unchanged, and a stage that pushed a commit is never unchanged, so
// they piled up: 228 of them, ~1 GB each, 143 GB, until a test failed for lack
// of disk and blocked a merge (embeddings-v2 follow-ups run, 2026-10-12).
//
// All Ralph state lives on GitHub (marker comments) and origin/main (the
// ledger), so a stage's worktree holds nothing once the stage is over — PROVIDED
// it is clean and its HEAD is pushed. This module decides that and removes it.
//
//   remove <path>        — the workflow calls this right after each stage, on
//                          the path the stage reported. Removes it only if safe.
//   sweep [--older-than-hours N]
//                        — the preflight calls this: every `wf_*` worktree that
//                          is safe AND untouched for N hours (default 24), so a
//                          stage of another run still in flight is never hit.
//
// "Safe" (decideRemoval): under <repo>/.claude/worktrees/, basename `wf_*`, not
// the main worktree, not locked, `git status --porcelain` empty, no ignored
// file except the regenerable ones (node_modules, .env symlinks, build output —
// `git worktree remove --force` deletes EVERY ignored file, so a result left in
// an ignored dir like tmp/ or data/ keeps the worktree), and HEAD pushed — either every commit is on
// a remote-tracking ref, or GitHub itself has the HEAD commit (a squash-merged
// branch is deleted and pruned, but GitHub keeps the PR's head commit).
// Anything else is KEPT and the reason is printed: a dirty or unpushed worktree
// is exactly the one that might hold work.
//
// Only `node:` imports, so `node <ralph>/lib/worktrees.ts` runs without
// node_modules (Node's native type stripping) — the preflight that checks the
// install must not itself depend on the install.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isEntryPoint } from "./is-entry-point.ts";

export const STAGE_WORKTREE_PREFIX = "wf_";
export const DEFAULT_SWEEP_AGE_HOURS = 24;

/**
 * Ignored paths that `--force` may delete: rebuilt by `pnpm install` / a build,
 * or a symlink to a file that lives elsewhere. Any OTHER ignored path keeps the
 * worktree. Measured 2026-10-12: every wf_* worktree on the laptop held only
 * `.env`, `.env.deploy` and `node_modules/`.
 */
export function isRegenerableIgnored(path: string): boolean {
  const p = path.replace(/\/$/, "");
  const segs = p.split("/");
  const name = segs[segs.length - 1] ?? "";
  if (segs.includes("node_modules")) return true;
  if (segs.length === 1 && (name === ".env" || name.startsWith(".env."))) return true;
  if (segs.length === 1 && (name === "dist" || name === "coverage")) return true;
  // Next.js build output (`next build` / `next dev`).
  if (segs.length === 1 && name === ".next") return true;
  return name.endsWith(".tsbuildinfo") || name.endsWith(".log");
}

/** Split `git status --porcelain --ignored` into changes and ignored paths. */
export function splitStatus(porcelain: string): { status: string; ignored: string[] } {
  const changes: string[] = [];
  const ignored: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("!! ")) ignored.push(line.slice(3));
    else if (line.trim() !== "") changes.push(line);
  }
  return { status: changes.join("\n"), ignored };
}

export interface WorktreeEntry {
  path: string;
  head: string;
  detached: boolean;
  branch: string;
  locked: boolean;
  bare: boolean;
}

/** Parse `git worktree list --porcelain`. The first entry is the main worktree. */
export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const wt = lines.find((l) => l.startsWith("worktree "));
    if (!wt) continue;
    const e: WorktreeEntry = { path: wt.slice("worktree ".length), head: "", detached: false, branch: "", locked: false, bare: false };
    for (const l of lines) {
      if (l.startsWith("HEAD ")) e.head = l.slice(5);
      else if (l === "detached") e.detached = true;
      else if (l.startsWith("branch ")) e.branch = l.slice(7);
      else if (l === "locked" || l.startsWith("locked ")) e.locked = true;
      else if (l === "bare") e.bare = true;
    }
    out.push(e);
  }
  return out;
}

export interface RemovalFacts {
  /** Absolute path of the main checkout (the first porcelain entry). */
  mainPath: string;
  entry: WorktreeEntry;
  /** `git status --porcelain` output inside the worktree ("" = clean). */
  status: string;
  /** Ignored paths in the worktree (`!!` lines of `git status --ignored`). */
  ignored: string[];
  /** Commits on HEAD that no remote-tracking ref contains. */
  unpushedCount: number;
  /** GitHub has the HEAD commit (a PR head survives the branch delete). */
  headOnGitHub: boolean;
  /** Hours since the worktree was last touched. */
  ageHours: number;
}

export type RemovalDecision = { remove: true } | { remove: false; reason: string };

/** The pure safety decision. `minAgeHours` is 0 for the post-stage remove. */
export function decideRemoval(f: RemovalFacts, minAgeHours = 0): RemovalDecision {
  const root = resolve(f.mainPath, ".claude", "worktrees") + sep;
  const p = resolve(f.entry.path);
  if (p === resolve(f.mainPath)) return { remove: false, reason: "is the main checkout" };
  if (!p.startsWith(root)) return { remove: false, reason: "not under .claude/worktrees/" };
  if (dirname(p) + sep !== root) return { remove: false, reason: "not a direct child of .claude/worktrees/" };
  if (!basename(p).startsWith(STAGE_WORKTREE_PREFIX)) return { remove: false, reason: "not a workflow stage worktree (wf_*)" };
  if (f.entry.bare) return { remove: false, reason: "bare" };
  if (f.entry.locked) return { remove: false, reason: "locked" };
  if (f.status.trim() !== "") return { remove: false, reason: "has uncommitted or untracked changes" };
  const keep = f.ignored.filter((p) => !isRegenerableIgnored(p));
  if (keep.length > 0) {
    const shown = keep.slice(0, 3).join(", ") + (keep.length > 3 ? `, +${keep.length - 3} more` : "");
    return { remove: false, reason: `holds ignored files that may be results (${shown})` };
  }
  if (f.unpushedCount > 0 && !f.headOnGitHub) {
    return { remove: false, reason: `${f.unpushedCount} commit(s) not pushed anywhere` };
  }
  if (f.ageHours < minAgeHours) return { remove: false, reason: `touched ${f.ageHours.toFixed(1)}h ago (< ${minAgeHours}h)` };
  return { remove: true };
}

// ---------------------------------------------------------------------------
// Plumbing: gather the facts with git/gh, then act. `exec` is injectable.
// ---------------------------------------------------------------------------
export type Exec = (cmd: string, args: string[], cwd?: string) => string;

const realExec: Exec = (cmd, args, cwd) =>
  execFileSync(cmd, args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });

function safe(exec: Exec, cmd: string, args: string[], cwd?: string): string | null {
  try {
    return exec(cmd, args, cwd);
  } catch {
    return null;
  }
}

/** Hours since the worktree's admin files (HEAD / index) last changed. */
function defaultAgeHours(exec: Exec, path: string, nowMs: number): number {
  const gitDir = safe(exec, "git", ["rev-parse", "--absolute-git-dir"], path)?.trim();
  let latest = 0;
  for (const f of gitDir ? [join(gitDir, "HEAD"), join(gitDir, "index")] : [path]) {
    try {
      latest = Math.max(latest, statSync(f).mtimeMs);
    } catch {
      // missing index is fine
    }
  }
  return latest === 0 ? Infinity : (nowMs - latest) / 3_600_000;
}

export interface Deps {
  exec?: Exec;
  nowMs?: number;
  ageHours?: (path: string) => number;
}

function gather(entry: WorktreeEntry, mainPath: string, deps: Deps): RemovalFacts | { error: string } {
  const exec = deps.exec ?? realExec;
  // Age FIRST: a plain `git status` may rewrite the index (refreshing stat
  // info), which would make a stale worktree look just touched. Status also
  // runs with --no-optional-locks so it never writes the index at all.
  const ageHours = deps.ageHours ? deps.ageHours(entry.path) : defaultAgeHours(exec, entry.path, deps.nowMs ?? Date.now());
  const porcelain = safe(exec, "git", ["--no-optional-locks", "status", "--porcelain", "--ignored"], entry.path);
  if (porcelain === null) return { error: "git status failed (worktree missing or broken)" };
  const { status, ignored } = splitStatus(porcelain);
  const unpushed = safe(exec, "git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], entry.path);
  const unpushedCount = unpushed === null ? Number.POSITIVE_INFINITY : Number(unpushed.trim()) || 0;
  let headOnGitHub = false;
  if (unpushedCount > 0 && entry.head) {
    const got = safe(exec, "gh", ["api", `repos/{owner}/{repo}/commits/${entry.head}`, "--jq", ".sha"], mainPath);
    headOnGitHub = (got ?? "").trim() === entry.head;
  }
  return { mainPath, entry, status, ignored, unpushedCount, headOnGitHub, ageHours };
}

export interface CleanupRow {
  path: string;
  removed: boolean;
  reason: string;
}

function listWorktrees(exec: Exec, cwd: string): WorktreeEntry[] {
  return parseWorktreePorcelain(exec("git", ["worktree", "list", "--porcelain"], cwd));
}

function removeOne(exec: Exec, mainPath: string, path: string): string | null {
  // --force deletes every IGNORED file. decideRemoval already proved there are
  // no tracked/untracked changes and no ignored file outside the regenerable set.
  try {
    exec("git", ["worktree", "remove", "--force", path], mainPath);
    return null;
  } catch (err) {
    return (err as Error).message.split("\n")[0] ?? "git worktree remove failed";
  }
}

/** Remove one worktree (by path) if decideRemoval allows it. */
export function removeStageWorktree(path: string, cwd: string, deps: Deps = {}): CleanupRow {
  const exec = deps.exec ?? realExec;
  const all = listWorktrees(exec, cwd);
  const mainPath = all[0]?.path ?? cwd;
  const entry = all.find((e) => resolve(e.path) === resolve(path));
  if (!entry) return { path, removed: false, reason: "not a registered worktree (already removed?)" };
  const facts = gather(entry, mainPath, deps);
  if ("error" in facts) return { path, removed: false, reason: facts.error };
  const d = decideRemoval(facts, 0);
  if (!d.remove) return { path, removed: false, reason: d.reason };
  const err = removeOne(exec, mainPath, entry.path);
  return { path, removed: err === null, reason: err ?? "clean and pushed" };
}

/** Remove every stale, safe `wf_*` worktree. Never touches anything else. */
export function sweepStageWorktrees(cwd: string, minAgeHours = DEFAULT_SWEEP_AGE_HOURS, deps: Deps = {}): CleanupRow[] {
  const exec = deps.exec ?? realExec;
  const all = listWorktrees(exec, cwd);
  const mainPath = all[0]?.path ?? cwd;
  const rows: CleanupRow[] = [];
  for (const entry of all.slice(1)) {
    if (!basename(entry.path).startsWith(STAGE_WORKTREE_PREFIX)) continue;
    const facts = gather(entry, mainPath, deps);
    if ("error" in facts) {
      rows.push({ path: entry.path, removed: false, reason: facts.error });
      continue;
    }
    const d = decideRemoval(facts, minAgeHours);
    if (!d.remove) {
      rows.push({ path: entry.path, removed: false, reason: d.reason });
      continue;
    }
    const err = removeOne(exec, mainPath, entry.path);
    rows.push({ path: entry.path, removed: err === null, reason: err ?? "clean, pushed, stale" });
  }
  if (rows.some((r) => r.removed)) safe(exec, "git", ["worktree", "prune"], mainPath);
  return rows;
}

// ---------------------------------------------------------------------------
// CLI: `node <ralph>/lib/worktrees.ts remove <path>` | `sweep [--older-than-hours N]`
// Prints one JSON line; always exits 0 (cleanup must never stop a run).
// ---------------------------------------------------------------------------
export function runCli(argv: string[], deps: Deps = {}): number {
  const [cmd, arg] = [argv[2], argv[3]];
  const cwd = process.cwd();
  if (cmd === "remove" && arg) {
    console.log(JSON.stringify(removeStageWorktree(arg, cwd, deps)));
    return 0;
  }
  if (cmd === "sweep") {
    const i = argv.indexOf("--older-than-hours");
    const hours = i > 0 ? Number(argv[i + 1]) : DEFAULT_SWEEP_AGE_HOURS;
    const rows = sweepStageWorktrees(cwd, Number.isFinite(hours) ? hours : DEFAULT_SWEEP_AGE_HOURS, deps);
    console.log(JSON.stringify({ removed: rows.filter((r) => r.removed).length, kept: rows.filter((r) => !r.removed) }));
    return 0;
  }
  console.error("usage: node <ralph>/lib/worktrees.ts remove <path> | sweep [--older-than-hours N]");
  return 1;
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) process.exit(runCli(process.argv));
