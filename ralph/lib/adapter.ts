// The per-repo adapter: everything Ralph's core needs to know about ONE repo.
//
// Ralph's core (this plugin) is the same for every repo. What differs — which
// commands prove a change, what a merge to main does, which extra gate checks
// exist, which commands a non-gated task may never name — lives in the repo, in
// `.claude/ralph.json`. Every helper loads it with `loadAdapter()` from the git
// top level of its cwd; the preflight prints it so the workflow can build its
// prompts from it (the Workflow runtime cannot read files).
//
// Only `node:` imports, so every helper runs with plain `node` and no install.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ADAPTER_PATH = ".claude/ralph.json";

/** How `prod-includes` reads what commit a repo's prod is running. */
export type ProdReader =
  /** the newest GitHub Deployment in `environment` whose latest status is `success` (e.g. Vercel) */
  | { kind: "github-deployment"; environment: string }
  /** a public JSON endpoint whose `commit` field is the deployed commit */
  | { kind: "health-url"; url: string };

export interface Adapter {
  /** "owner/name" of this repo. A gate check with no `repo` reads here. */
  repo: string;
  /** Repo-specific policy every stage reads after the core policy (repo-relative path). */
  addendum: string;
  /** The known-flakes list (repo-relative). */
  knownFlakes: string;
  /** Shell commands a stage runs first in its fresh worktree (install, env symlinks). */
  worktreeSetup: string[];
  /** Preflight: a command that proves the install works with no terminal. "" = skip. */
  installProbe: string;
  commands: {
    /** the type check, e.g. "pnpm typecheck" */
    typecheck: string;
    /** run named test files: the files are appended, e.g. "pnpm vitest run" */
    testFiles: string;
    /** the merge gate's full test run, e.g. "pnpm test" */
    mergeGate: string;
  };
  merge: {
    /** One or two plain sentences: what merging to main does in this repo (deploys, migrations). */
    note: string;
    /** Optional guard run before the gate; `{pr}` is replaced. Prints JSON `{ok, reasons}`; ok=false parks the PR. */
    guard: string;
    /** Optional prefix the full test run goes through (e.g. a machine-wide lock). */
    gateWrapper: string;
    /** Exit code of `gateWrapper` meaning "busy, try later" (0 = none). */
    busyExitCode: number;
    /** Minutes the scripted merge waits on a busy wrapper before reporting `busy`. */
    busyWaitMinutes: number;
    /** Wait for the PR's GitHub checks to pass before merging. */
    waitForCi: boolean;
    /** Minutes to wait for CI before handing the PR to the merge agent. */
    ciTimeoutMinutes: number;
    /** The merge gate is vitest: add a JSON reporter to learn the failing files. */
    vitestJson: boolean;
    /** Directory + regex of migration files a PR may add (reported as migrationAdded). */
    migrations: { dir: string; pattern: string };
    /** After a merge that added a migration: keep grinding, or stop the run. */
    afterMigration: "continue" | "stop";
    /** What the run says when it stops (or logs when it continues) after a merged migration. */
    migrationMessage: string;
    /** The lockfile whose change after catching up with main needs `install`. "" = never. */
    lockfile: string;
    /** Reinstall after a lockfile change. */
    install: string;
  };
  /** Repos whose prod `prod-includes` can read, by "owner/name". */
  prod: Record<string, ProdReader>;
  /** Extra `done_when` check types this repo provides, and the command that judges them. */
  gateChecks: { types: string[]; command: string };
  /** Regex sources: commands a NON-gated task may never name (apply/deploy). Case-insensitive. */
  forbiddenCommands: string[];
  /** Free disk a run needs, in GB. */
  minFreeGb: number;
}

const DEFAULTS = {
  knownFlakes: "docs/ralph/known-flakes.md",
  worktreeSetup: [] as string[],
  installProbe: "",
  merge: {
    guard: "",
    gateWrapper: "",
    busyExitCode: 0,
    busyWaitMinutes: 4,
    waitForCi: false,
    ciTimeoutMinutes: 8,
    vitestJson: true,
    migrations: { dir: "drizzle", pattern: "\\.sql$" },
    afterMigration: "continue" as const,
    migrationMessage: "",
    lockfile: "pnpm-lock.yaml",
    install: "pnpm install --frozen-lockfile --prefer-offline",
  },
  prod: {} as Record<string, ProdReader>,
  gateChecks: { types: [] as string[], command: "" },
  forbiddenCommands: [] as string[],
  minFreeGb: 25,
};

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Validate a parsed adapter and fill in defaults. Throws one message listing every problem. */
export function parseAdapter(raw: unknown): Adapter {
  const errs: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const need = (path: string, v: unknown) => {
    if (!isStr(v) || v.trim() === "") errs.push(`"${path}" must be a non-empty string`);
  };
  need("repo", o.repo);
  if (isStr(o.repo) && !REPO_RE.test(o.repo)) errs.push(`"repo" must be "owner/name"`);
  need("addendum", o.addendum);
  const c = (o.commands ?? {}) as Record<string, unknown>;
  need("commands.typecheck", c.typecheck);
  need("commands.testFiles", c.testFiles);
  need("commands.mergeGate", c.mergeGate);
  const m = { ...DEFAULTS.merge, ...((o.merge ?? {}) as Record<string, unknown>) } as Record<string, any>;
  need("merge.note", m.note);
  if (m.afterMigration !== "continue" && m.afterMigration !== "stop") errs.push(`"merge.afterMigration" must be "continue" or "stop"`);
  for (const k of ["guard", "gateWrapper", "migrationMessage", "lockfile", "install"]) {
    if (!isStr(m[k])) errs.push(`"merge.${k}" must be a string`);
  }
  for (const k of ["busyExitCode", "busyWaitMinutes", "ciTimeoutMinutes"]) {
    if (typeof m[k] !== "number" || m[k] < 0) errs.push(`"merge.${k}" must be a number >= 0`);
  }
  if (!m.migrations || !isStr(m.migrations.dir) || !isStr(m.migrations.pattern)) {
    errs.push(`"merge.migrations" must be { dir, pattern }`);
  }
  const prod = (o.prod ?? DEFAULTS.prod) as Record<string, any>;
  for (const [repo, r] of Object.entries(prod)) {
    if (!REPO_RE.test(repo)) errs.push(`"prod" key "${repo}" must be "owner/name"`);
    const ok =
      (r?.kind === "github-deployment" && isStr(r.environment) && r.environment !== "") ||
      (r?.kind === "health-url" && isStr(r.url) && /^https?:\/\//.test(r.url));
    if (!ok) errs.push(`"prod.${repo}" must be {kind:"github-deployment",environment} or {kind:"health-url",url}`);
  }
  const g = { ...DEFAULTS.gateChecks, ...((o.gateChecks ?? {}) as Record<string, unknown>) } as Record<string, any>;
  if (!isStrArr(g.types)) errs.push(`"gateChecks.types" must be a string array`);
  if (!isStr(g.command)) errs.push(`"gateChecks.command" must be a string`);
  if (isStrArr(g.types) && g.types.length > 0 && !g.command) errs.push(`"gateChecks.command" is required when gateChecks.types is set`);
  for (const k of ["worktreeSetup", "forbiddenCommands"]) {
    if (o[k] !== undefined && !isStrArr(o[k])) errs.push(`"${k}" must be a string array`);
  }
  for (const src of (isStrArr(o.forbiddenCommands) ? o.forbiddenCommands : [])) {
    try {
      new RegExp(src, "i");
    } catch {
      errs.push(`"forbiddenCommands" has an invalid regex: ${src}`);
    }
  }
  if (errs.length) throw new Error(`${ADAPTER_PATH} is invalid:\n- ${errs.join("\n- ")}`);
  return {
    repo: o.repo,
    addendum: o.addendum,
    knownFlakes: isStr(o.knownFlakes) && o.knownFlakes ? o.knownFlakes : DEFAULTS.knownFlakes,
    worktreeSetup: o.worktreeSetup ?? DEFAULTS.worktreeSetup,
    installProbe: isStr(o.installProbe) ? o.installProbe : DEFAULTS.installProbe,
    commands: { typecheck: c.typecheck as string, testFiles: c.testFiles as string, mergeGate: c.mergeGate as string },
    merge: m as Adapter["merge"],
    prod: prod as Record<string, ProdReader>,
    gateChecks: g as Adapter["gateChecks"],
    forbiddenCommands: o.forbiddenCommands ?? DEFAULTS.forbiddenCommands,
    minFreeGb: typeof o.minFreeGb === "number" && o.minFreeGb > 0 ? o.minFreeGb : DEFAULTS.minFreeGb,
  };
}

/** The git top level of `cwd` (a worktree's own top level, which has the same tracked adapter). */
export function repoRoot(cwd: string = process.cwd()): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}

/** Load `.claude/ralph.json` from the repo holding `cwd`. Throws a plain message when it is missing or invalid. */
export function loadAdapter(cwd: string = process.cwd()): Adapter {
  const root = repoRoot(cwd);
  const file = join(root, ADAPTER_PATH);
  if (!existsSync(file)) {
    throw new Error(`${file} is missing: this repo has no Ralph adapter. See the ralph plugin's docs/adapter.md.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  return parseAdapter(raw);
}
