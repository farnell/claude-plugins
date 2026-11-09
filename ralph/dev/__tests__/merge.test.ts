// The scripted merge stage (lib/merge.ts): every git/gh call and adapter command is faked,
// so these tests pin WHICH calls it makes in each case, and what it hands back.
import { describe, it, expect } from "vitest";

import { parseAdapter } from "../../lib/adapter.ts";
import {
  BUSY_POLL_MS,
  CI_NONE_AFTER_MS,
  CI_POLL_MS,
  failedFilesFromVitestJson,
  formatLedgerLike,
  parseArgs,
  reapplyTaskTick,
  runMerge,
  type MergeDeps,
  type RunOut,
} from "../../lib/merge.ts";

const OK: RunOut = { code: 0, stdout: "", stderr: "" };
const FAIL: RunOut = { code: 1, stdout: "", stderr: "boom" };
const LEDGER = "docs/ralph/feat-LEDGER.json";
const TARGET = { pr: 42, branch: "ralph/feat/T2", ledger: LEDGER, task: "T2" };

const ledgerText = (t1: string, t2: string) =>
  formatLedgerLike(
    {
      feature: { slug: "feat", title: "Feat", featureMd: "docs/feat.md" },
      tasks: [
        { id: "T1", title: "one", status: t1, attempts: 0, notes: "", updatedAt: null },
        { id: "T2", title: "two", status: t2, attempts: 0, notes: "", updatedAt: null },
      ],
    },
    "",
  );

interface FakeOpts {
  behind?: boolean; // origin/main is not an ancestor of the branch
  mergeConflict?: string[] | null; // conflicted files when the catch-up merge fails
  lockChanged?: boolean;
  migrations?: string;
  typecheck?: RunOut;
  /** successive results of the full gate command (the last one repeats) */
  gate?: RunOut[];
  report?: string | null;
  guard?: RunOut;
  ghMerge?: RunOut;
  prState?: string;
  /** successive `gh pr checks --json` stdouts (the last one repeats) */
  checks?: string[];
  headOid?: string;
  mainLedger?: string;
  branchLedger?: string;
  adapter?: Record<string, unknown>;
}

const BASE_ADAPTER = {
  repo: "acme/app",
  addendum: "docs/ralph/repo-policy.md",
  commands: { typecheck: "pnpm typecheck", testFiles: "pnpm vitest run", mergeGate: "pnpm run test" },
  merge: { note: "deploys to staging" },
};

function fake(o: FakeOpts = {}) {
  const calls: string[] = [];
  const sh: string[] = [];
  const written: Record<string, string> = {};
  const slept: number[] = [];
  let clock = 0;
  let lockReads = 0;
  let gateRuns = 0;
  let checkReads = 0;
  const adapter = parseAdapter({
    ...BASE_ADAPTER,
    ...(o.adapter ?? {}),
    merge: { ...BASE_ADAPTER.merge, ...((o.adapter?.merge as object) ?? {}) },
  });
  const deps: MergeDeps = {
    run(cmd, args) {
      const c = `${cmd} ${args.join(" ")}`;
      calls.push(c);
      if (c === "git rev-parse HEAD:pnpm-lock.yaml") return { ...OK, stdout: o.lockChanged && lockReads++ > 0 ? "lock-b\n" : "lock-a\n" };
      if (c === "git rev-parse HEAD") return { ...OK, stdout: "headsha\n" };
      if (c.startsWith("git merge-base --is-ancestor")) return o.behind ? FAIL : OK;
      if (c === "git merge --no-edit origin/main") return o.mergeConflict ? FAIL : OK;
      if (c === "git diff --name-only --diff-filter=U") return { ...OK, stdout: (o.mergeConflict ?? []).join("\n") };
      if (c.startsWith("git diff --name-only --diff-filter=A")) return { ...OK, stdout: o.migrations ?? "" };
      if (c === `git show origin/main:${LEDGER}`) return { ...OK, stdout: o.mainLedger ?? "" };
      if (c === `git show headsha:${LEDGER}`) return { ...OK, stdout: o.branchLedger ?? "" };
      if (c.startsWith("gh pr merge")) return o.ghMerge ?? OK;
      if (c.startsWith("gh pr view 42 --json headRefOid")) return { ...OK, stdout: `${o.headOid ?? "headsha"}\n` };
      if (c.startsWith("gh pr view")) return { ...OK, stdout: `${o.prState ?? "OPEN"}\n` };
      if (c.startsWith("gh pr checks")) {
        const list = o.checks ?? ["[]"];
        return { code: 8, stdout: list[Math.min(checkReads++, list.length - 1)]!, stderr: "" };
      }
      return OK;
    },
    sh(command) {
      sh.push(command);
      calls.push(`sh ${command}`);
      if (command === adapter.commands.typecheck) return o.typecheck ?? OK;
      if (command.includes(adapter.commands.mergeGate)) {
        const list = o.gate ?? [OK];
        return list[Math.min(gateRuns++, list.length - 1)]!;
      }
      if (adapter.merge.guard && command.startsWith(adapter.merge.guard.split(" ")[0]!)) return o.guard ?? { ...OK, stdout: '{"ok":true,"reasons":[]}' };
      return OK;
    },
    writeFile(p, t) {
      written[p] = t;
    },
    readFile: () => (o.report === undefined ? null : o.report),
    reportPath: () => "/tmp/r/vitest.json",
    repoRoot: () => "/repo",
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    adapter,
  };
  return { deps, calls, sh, written, slept, gateRuns: () => gateRuns };
}

describe("runMerge — the green path needs no agent", () => {
  it("up to date + green → type check, then the gate with a JSON reporter, then squash-merge", async () => {
    const f = fake();
    const r = await runMerge(TARGET, f.deps);
    expect(r).toMatchObject({ status: "merged", sha: "headsha", migrationAdded: "", afterMigration: "continue" });
    expect(f.sh).toEqual([
      "pnpm typecheck",
      "pnpm run test --reporter=default --reporter=json --outputFile.json=/tmp/r/vitest.json",
    ]);
    expect(f.calls).toContain("gh pr merge 42 --squash --delete-branch");
    expect(f.calls).not.toContain("git merge --no-edit origin/main");
  });

  it("behind main → merges origin/main and pushes the catch-up before the gate", async () => {
    const f = fake({ behind: true });
    expect((await runMerge(TARGET, f.deps)).status).toBe("merged");
    const push = f.calls.indexOf("git push origin HEAD:ralph/feat/T2");
    expect(push).toBeGreaterThan(f.calls.indexOf("git merge --no-edit origin/main"));
    expect(push).toBeLessThan(f.calls.indexOf("sh pnpm typecheck"));
  });

  it("re-installs (the adapter's install) only when the lockfile changed", async () => {
    const a = fake({ behind: true, lockChanged: true });
    await runMerge(TARGET, a.deps);
    expect(a.sh).toContain("pnpm install --frozen-lockfile --prefer-offline");
    const b = fake({ behind: true });
    await runMerge(TARGET, b.deps);
    expect(b.sh).not.toContain("pnpm install --frozen-lockfile --prefer-offline");
  });

  it("reports added migrations from the adapter's migrations dir + pattern", async () => {
    const f = fake({ migrations: "drizzle/0210_x.sql\ndrizzle/meta/_journal.json\n" });
    expect((await runMerge(TARGET, f.deps)).migrationAdded).toBe("drizzle/0210_x.sql");
    expect(f.calls).toContain("git diff --name-only --diff-filter=A origin/main...HEAD -- drizzle");
  });

  it("a --delete-branch failure after GitHub merged it still counts as merged", async () => {
    const f = fake({ ghMerge: FAIL, prState: "MERGED" });
    expect((await runMerge(TARGET, f.deps)).status).toBe("merged");
  });

  it("a gh merge that really failed is an error", async () => {
    const f = fake({ ghMerge: FAIL, prState: "OPEN" });
    expect((await runMerge(TARGET, f.deps)).status).toBe("error");
  });

  it("vitestJson:false runs the gate command exactly as written", async () => {
    const f = fake({ adapter: { merge: { vitestJson: false } } });
    await runMerge(TARGET, f.deps);
    expect(f.sh).toEqual(["pnpm typecheck", "pnpm run test"]);
  });
});

describe("runMerge — anything needing judgement goes back to the agent", () => {
  it("a red gate returns the failing files (from vitest's JSON report) and never merges", async () => {
    const report = JSON.stringify({ testResults: [{ name: "/repo/src/a.test.ts", status: "failed" }] });
    const f = fake({ gate: [{ code: 1, stdout: "x", stderr: "" }], report });
    const r = await runMerge(TARGET, f.deps);
    expect(r).toMatchObject({ status: "red", typecheckFailed: false, failedFiles: ["src/a.test.ts"], sha: "headsha" });
    expect(r.message).toBe("pnpm run test failed in 1 file(s)");
    expect(f.calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
  });

  it("a type-check failure returns red without running the tests", async () => {
    const f = fake({ typecheck: FAIL });
    const r = await runMerge(TARGET, f.deps);
    expect(r).toMatchObject({ status: "red", typecheckFailed: true });
    expect(f.gateRuns()).toBe(0);
  });

  it("a conflict outside the ledger aborts the merge and hands it back", async () => {
    const f = fake({ behind: true, mergeConflict: ["src/x.ts", LEDGER] });
    const r = await runMerge(TARGET, f.deps);
    expect(r.status).toBe("conflict");
    expect(r.message).toMatch(/src\/x\.ts/);
    expect(f.calls).toContain("git merge --abort");
    expect(f.sh).toEqual([]);
  });
});

describe("runMerge — the merge guard (adapter merge.guard, policy §merge step 0)", () => {
  const guarded = { merge: { guard: "node src/ralph/migration-additive.ts --pr {pr}" } };

  it("runs first, with the PR number, and a pass carries on to the merge", async () => {
    const f = fake({ adapter: guarded });
    expect((await runMerge(TARGET, f.deps)).status).toBe("merged");
    expect(f.sh[0]).toBe("node src/ralph/migration-additive.ts --pr 42");
  });

  it("a refusal parks the PR with its reasons and touches nothing (no fetch, no push, no gate)", async () => {
    const guard = { ...OK, stdout: '{"ok":false,"reasons":["drizzle/0011_x.sql: DROP COLUMN"]}' };
    const f = fake({ adapter: guarded, guard, behind: true });
    const r = await runMerge(TARGET, f.deps);
    expect(r).toMatchObject({ status: "guardrail", guardReasons: ["drizzle/0011_x.sql: DROP COLUMN"] });
    expect(f.calls.filter((c) => !c.startsWith("sh node src/ralph/migration-additive"))).toEqual([]);
  });

  it("a guard that crashes or prints no verdict parks too (the default is park)", async () => {
    for (const guard of [{ code: 1, stdout: "", stderr: "boom" }, { ...OK, stdout: "not json" }]) {
      const f = fake({ adapter: guarded, guard });
      expect((await runMerge(TARGET, f.deps)).status).toBe("guardrail");
      expect(f.calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
    }
  });
});

describe("runMerge — a gate wrapper (adapter merge.gateWrapper, e.g. a machine-wide lock)", () => {
  const locked = { merge: { gateWrapper: "pnpm --silent heavy-job run --job ralph-gate --", busyExitCode: 75, busyWaitMinutes: 1, vitestJson: false } };
  const BUSY: RunOut = { code: 75, stdout: "", stderr: "build (pid 9) holds the heavy-job lock" };

  it("runs the full gate through the wrapper", async () => {
    const f = fake({ adapter: locked });
    expect((await runMerge(TARGET, f.deps)).status).toBe("merged");
    expect(f.sh).toContain("pnpm --silent heavy-job run --job ralph-gate -- pnpm run test");
  });

  it("retries while the wrapper says busy, and merges once it runs", async () => {
    const f = fake({ adapter: locked, gate: [BUSY, BUSY, OK] });
    expect((await runMerge(TARGET, f.deps)).status).toBe("merged");
    expect(f.gateRuns()).toBe(3);
    expect(f.slept).toEqual([BUSY_POLL_MS, BUSY_POLL_MS]);
  });

  it("returns busy, naming the holder, when the wait runs out — never a red", async () => {
    const f = fake({ adapter: locked, gate: [BUSY] });
    const r = await runMerge(TARGET, f.deps);
    expect(r.status).toBe("busy");
    expect(r.message).toMatch(/build \(pid 9\)/);
    expect(f.calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
  });

  it("without a wrapper, exit 75 is just a red gate", async () => {
    const f = fake({ gate: [BUSY] });
    expect((await runMerge(TARGET, f.deps)).status).toBe("red");
  });
});

describe("runMerge — waiting for the PR's CI (adapter merge.waitForCi)", () => {
  const ci = { merge: { waitForCi: true, ciTimeoutMinutes: 2 } };
  const rows = (...r: [string, string][]) => JSON.stringify(r.map(([name, bucket]) => ({ name, bucket })));

  it("waits while checks are pending, then merges when all pass", async () => {
    const f = fake({ adapter: ci, checks: [rows(["ci", "pending"]), rows(["ci", "pass"], ["vercel", "skipping"])] });
    expect((await runMerge(TARGET, f.deps)).status).toBe("merged");
    expect(f.slept).toEqual([CI_POLL_MS]);
  });

  it("a failed check is red (ciFailed), naming it, and never merges", async () => {
    const f = fake({ adapter: ci, checks: [rows(["ci", "fail"], ["vercel", "pass"])] });
    const r = await runMerge(TARGET, f.deps);
    expect(r).toMatchObject({ status: "red", ciFailed: true });
    expect(r.message).toMatch(/ci/);
    expect(f.calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
  });

  it("checks still running at the timeout hand the PR to the agent (error), never merge", async () => {
    const f = fake({ adapter: ci, checks: [rows(["ci", "pending"])] });
    const r = await runMerge(TARGET, f.deps);
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/still running/);
  });

  it("ignores checks from an older head, and treats a head with no checks for 2 min as no CI", async () => {
    const f = fake({ adapter: ci, headOid: "headsha", checks: ["[]"] });
    expect((await runMerge(TARGET, f.deps)).status).toBe("merged");
    expect(f.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(CI_NONE_AFTER_MS);
    const old = fake({ adapter: ci, headOid: "oldsha", checks: [rows(["ci", "fail"])] });
    expect((await runMerge(TARGET, old.deps)).status).toBe("error");
  });

  it("does not wait for CI at all when the adapter does not ask", async () => {
    const f = fake({ checks: [rows(["ci", "fail"])] });
    expect((await runMerge(TARGET, f.deps)).status).toBe("merged");
    expect(f.calls.some((c) => c.startsWith("gh pr checks"))).toBe(false);
  });
});

describe("runMerge — the routine ledger-only conflict is resolved per the policy", () => {
  it("takes main's ledger, re-applies only this task's tick, re-renders the .md, commits", async () => {
    // main ticked T1 since; the branch ticked T2 (and still has T1 todo).
    const f = fake({
      behind: true,
      mergeConflict: [LEDGER, "docs/ralph/feat-LEDGER.md"],
      mainLedger: ledgerText("done", "todo"),
      branchLedger: ledgerText("todo", "done"),
    });
    const r = await runMerge(TARGET, f.deps);
    expect(r.status).toBe("merged");
    const resolved = JSON.parse(f.written[LEDGER]!);
    expect(resolved.tasks.map((t: { status: string }) => t.status)).toEqual(["done", "done"]);
    expect(f.written["docs/ralph/feat-LEDGER.md"]).toMatch(/\[x\] \*\*T1\*\*[\s\S]*\[x\] \*\*T2\*\*/);
    expect(f.calls).toContain("git commit --no-edit");
    expect(f.calls).not.toContain("git merge --abort");
  });
});

describe("reapplyTaskTick / formatLedgerLike", () => {
  it("copies only the tick fields of the named task", () => {
    const main = ledgerText("done", "todo");
    const branch = JSON.parse(ledgerText("todo", "done"));
    branch.tasks[1].title = "renamed on the branch";
    branch.tasks[1].notes = "PR #42";
    const out = JSON.parse(reapplyTaskTick(main, JSON.stringify(branch), "T2"));
    expect(out.tasks[1]).toMatchObject({ title: "two", status: "done", notes: "PR #42" });
    expect(out.tasks[0].status).toBe("done");
  });
  it("throws when the task is missing", () => {
    expect(() => reapplyTaskTick(ledgerText("a", "b"), ledgerText("a", "b"), "T9")).toThrow(/T9/);
  });
  it("keeps the file's non-ASCII style: escaped stays escaped, raw stays raw", () => {
    expect(formatLedgerLike({ p: "§S0 — x" }, '{"p": "\\u00a7"}')).toBe('{\n  "p": "\\u00a7S0 \\u2014 x"\n}\n');
    expect(formatLedgerLike({ p: "§S0" }, '{"p": "§"}')).toBe('{\n  "p": "§S0"\n}\n');
  });
});

describe("failedFilesFromVitestJson", () => {
  it("lists failed files, repo-relative, sorted, de-duplicated", () => {
    const json = JSON.stringify({
      testResults: [
        { name: "/repo/src/b.test.ts", status: "failed" },
        { name: "/repo/src/a.test.ts", status: "passed" },
        { name: "/repo/src/c.test.ts", status: "failed" },
        { name: "/repo/src/b.test.ts", status: "failed" },
      ],
    });
    expect(failedFilesFromVitestJson(json, "/repo")).toEqual(["src/b.test.ts", "src/c.test.ts"]);
  });
  it("an unreadable report gives no files (the caller still reports red)", () => {
    expect(failedFilesFromVitestJson("", "/repo")).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("reads the flags", () => {
    expect(parseArgs(["--pr", "42", "--branch", "ralph/feat/T2", "--ledger", LEDGER, "--task", "T2"])).toEqual(TARGET);
  });
  it("refuses a missing or malformed flag", () => {
    expect(typeof parseArgs([])).toBe("string");
    expect(typeof parseArgs(["--pr", "42", "--branch", "main", "--ledger", LEDGER, "--task", "T2"])).toBe("string");
    expect(typeof parseArgs(["--pr", "42", "--branch", "ralph/feat/T2", "--ledger", "x.json", "--task", "T2"])).toBe("string");
  });
});
