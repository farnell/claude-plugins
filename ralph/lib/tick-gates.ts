// Ralph TICK-GATES — tick the human gates whose `done_when` evidence now exists.
//
//   node <ralph>/lib/tick-gates.ts <ledger.json>           # dry run: print the plan
//   node <ralph>/lib/tick-gates.ts <ledger.json> --apply   # tick via an auto-merged PR
//
// The ralph-loop workflow runs `--apply` once at the start of every run, so a
// gate Matt has finished (merged, deployed, shipped, decided) is ticked
// without anyone touching the ledger, and the work queued behind it runs in the
// same run. The decisions are `gate-checks.ts` (pure, tested); this file reads
// the real evidence — all of it read-only — and lands the tick the same way a
// task PR does: on origin/main, through a squash-merged PR.
//
// How prod is read, and which repo-provided check types exist, come from the
// repo's adapter (`.claude/ralph.json`, `adapter.ts`).
//
// It reads the ledger from origin/main, never the local checkout, and edits it
// in a throwaway detached worktree, so the caller's checkout is never touched.
// Prints one JSON object on stdout.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAdapter, type Adapter } from "./adapter.ts";
import { realRunCheck, runExtraCheck, type RunCheck } from "./repo-check.ts";
import { contextFrom, planGateTicks, type CheckResult, type GateContext, type GateIO, type GateLedger, type GatePlan } from "./gate-checks.ts";
import { ledgerMdPath, renderLedgerMd } from "./render-ledger.ts";
import { isEntryPoint } from "./is-entry-point.ts";

export type Exec = (cmd: string, args: string[]) => string;
export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
const realExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });

/** How many recent GitHub Deployments to scan for the latest successful one. */
const DEPLOYMENT_SCAN = 10;

/**
 * The real evidence readers — `gh`, `git`, public HTTPS reads, and the repo's
 * own gate-check command for repo-provided types.
 *
 * Prod commit (adapter `prod`, per repo):
 *   - github-deployment: the newest GitHub Deployment in that environment whose
 *     latest status is `success` (e.g. Vercel Production).
 *   - health-url: the `commit` field of a public JSON endpoint.
 * Ancestry:
 *   - this repo: local `git merge-base --is-ancestor` (after `git fetch`).
 *   - another repo: `gh api repos/<repo>/compare/<a>...<b>` — status `ahead` or
 *     `identical` means `a` is contained in `b`.
 */
export function realGateIO(
  exec: Exec,
  adapter: Adapter,
  fetchFn: Fetch = fetch,
  run: RunCheck = realRunCheck,
): GateIO & { close(): Promise<void> } {
  const self = adapter.repo;
  /** `--repo` args for gh: none for this repo (gh reads the checkout's remote), else the named repo. */
  const ghRepo = (repo: string): string[] => (repo === self ? [] : ["--repo", repo]);
  return {
    async pr(n, repo) {
      const raw = JSON.parse(
        exec("gh", ["pr", "view", String(n), ...ghRepo(repo), "--json", "state,mergedAt,mergeCommit"]),
      ) as {
        state: string;
        mergedAt: string | null;
        mergeCommit: { oid: string } | null;
      };
      return { state: raw.state, mergedAt: raw.mergedAt || null, mergeCommit: raw.mergeCommit?.oid ?? null };
    },
    async prodCommit(repo) {
      const reader = adapter.prod[repo];
      if (!reader) throw new Error(`no known prod for ${repo} (the adapter's "prod")`);
      if (reader.kind === "health-url") {
        const res = await fetchFn(reader.url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        const body = (await res.json()) as { commit?: unknown };
        return typeof body.commit === "string" && body.commit !== "" ? body.commit : null;
      }
      const env = encodeURIComponent(reader.environment);
      const deployments = JSON.parse(
        exec("gh", ["api", `repos/${repo}/deployments?environment=${env}&per_page=${DEPLOYMENT_SCAN}`]),
      ) as { id: number; sha: string }[];
      for (const d of deployments) {
        const statuses = JSON.parse(exec("gh", ["api", `repos/${repo}/deployments/${d.id}/statuses?per_page=1`])) as {
          state: string;
        }[];
        if (statuses[0]?.state === "success") return d.sha;
      }
      return null;
    },
    async isAncestor(a, b, repo) {
      if (repo !== self) {
        const status = exec("gh", ["api", `repos/${repo}/compare/${a}...${b}`, "--jq", ".status"]).trim();
        return status === "ahead" || status === "identical";
      }
      try {
        exec("git", ["merge-base", "--is-ancestor", a, b]);
        return true;
      } catch (err) {
        // exit 1 = "not an ancestor"; anything else (unknown commit) is an error → fail closed
        if ((err as { status?: number }).status === 1) return false;
        throw err;
      }
    },
    async issueState(n, repo) {
      return (JSON.parse(exec("gh", ["issue", "view", String(n), ...ghRepo(repo), "--json", "state"])) as { state: string })
        .state;
    },
    async extra(check) {
      return runExtraCheck(adapter, check, run);
    },
    async docOnMain(file) {
      try {
        return exec("git", ["show", `origin/main:${file}`]);
      } catch {
        return null;
      }
    },
    async close() {
      // nothing to close: a repo check opens (and closes) its own connections
    },
  };
}

export interface TickResult {
  ticked: GatePlan["ticked"];
  waiting: GatePlan["waiting"];
  noCheck: string[];
  prUrl: string;
}

/** Commit the ticked ledger in a throwaway worktree, open a PR, squash-merge it. Returns the PR URL. */
export function landTicks(ledgerPath: string, plan: GatePlan, exec: Exec, scratch: string): string {
  const slug = plan.ledger.feature.slug;
  const ids = plan.ticked.map((t) => t.id).join(", ");
  const dir = mkdtempSync(join(scratch, "ralph-gates-"));
  exec("git", ["worktree", "add", "--detach", dir, "origin/main"]);
  try {
    writeFileSync(join(dir, ledgerPath), `${JSON.stringify(plan.ledger, null, 2)}\n`);
    writeFileSync(join(dir, ledgerMdPath(ledgerPath)), renderLedgerMd(plan.ledger, ledgerPath));
    exec("git", ["-C", dir, "add", ledgerPath, ledgerMdPath(ledgerPath)]);
    const body = plan.ticked.map((t) => `- ${t.id}: ${t.reasons.join("; ")}`).join("\n");
    exec("git", ["-C", dir, "commit", "-m", `ralph(${slug}): auto-tick ${ids} [gates]\n\n${body}`]);
    const branch = `ralph-gates/${slug}-${Date.now()}`;
    exec("git", ["-C", dir, "push", "origin", `HEAD:refs/heads/${branch}`]);
    const url = exec("gh", [
      "pr", "create", "--base", "main", "--head", branch,
      "--title", `ralph(${slug}): auto-tick ${ids} [gates]`,
      "--body", `Ralph found the evidence that these human gates are done and ticked them:\n\n${body}\n\nLedger-only change (Ralph tick-gates).`,
    ]).trim();
    exec("gh", ["pr", "merge", url, "--squash", "--delete-branch"]);
    return url;
  } finally {
    try {
      exec("git", ["worktree", "remove", "--force", dir]);
    } catch {
      // best effort; a leftover temp worktree is harmless and `git worktree prune` clears it
    }
  }
}

export async function runTickGates(
  ledgerPath: string,
  apply: boolean,
  deps: { exec: Exec; io: GateIO; today: string; scratch: string; ctx?: GateContext },
): Promise<TickResult> {
  deps.exec("git", ["fetch", "origin", "main", "--quiet"]);
  const ledger = JSON.parse(deps.exec("git", ["show", `origin/main:${ledgerPath}`])) as GateLedger;
  const plan = await planGateTicks(ledger, deps.io, deps.today, deps.ctx);
  let prUrl = "";
  if (apply && plan.ticked.length > 0) prUrl = landTicks(ledgerPath, plan, deps.exec, deps.scratch);
  return { ticked: plan.ticked, waiting: plan.waiting, noCheck: plan.noCheck, prUrl };
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) {
  const ledgerPath = process.argv[2];
  if (!ledgerPath) {
    console.error("usage: node <ralph>/lib/tick-gates.ts <ledger.json> [--apply]");
    process.exit(1);
  }
  const adapter = loadAdapter();
  const io = realGateIO(realExec, adapter);
  const scratch = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir();
  runTickGates(ledgerPath, process.argv.includes("--apply"), {
    exec: realExec,
    io,
    today: new Date().toISOString().slice(0, 10),
    scratch,
    ctx: contextFrom(adapter),
  })
    .then(async (r) => {
      await io.close();
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch(async (err) => {
      await io.close();
      console.error(String((err as Error).stack ?? err));
      process.exit(1);
    });
}
