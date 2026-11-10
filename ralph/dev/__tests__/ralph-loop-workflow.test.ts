// Drives workflows/ralph-loop.js with a fake `agent()` — the workflow is
// plumbing, but the plumbing is what the 2026-10-12 lessons were about: fresh
// agents (no parent conversation), stage-worktree removal, unsilenced helpers.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../../workflows/ralph-loop.js", import.meta.url)), "utf8");
const ROOT = "/plugins/ralph";

type Opts = { label?: string; agentType?: string; isolation?: string; model?: string };
type Call = { prompt: string; opts: Opts };

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...v: unknown[]) => Promise<unknown>;

const EMPTY_NEXT = {
  taskId: "", title: "", pointer: "", kind: "", verify: "", model: "", size: "", stage: "", branch: "",
  prNumber: 0, prUrl: "", reviewRound: 0, checkFailures: 0, lastEvent: "none", markerCount: 0,
  redSha: "", prevRedSha: "", redFiles: [] as string[],
};

type PlanScript =
  | { stage: string; kind?: string; size?: string; lastEvent?: string; redSha?: string; prevRedSha?: string; redFiles?: string[]; remaining?: number; batched?: number }
  | { raw: Record<string, unknown> }
  // A planner that refused or failed: ran nothing, so it reports no cleanup.
  | { refused: string }
  | { nothing: true };

const parkedN = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `P${i}`, reason: "human_gate" }));

/** What the preflight relays: the repo's adapter (lib/adapter.ts). This one is an app-like repo. */
const ADAPTER = {
  repo: "acme/app",
  addendum: "docs/ralph/repo-policy.md",
  knownFlakes: "docs/ralph/known-flakes.md",
  worktreeSetup: ["pnpm install --frozen-lockfile --prefer-offline"],
  commands: { typecheck: "pnpm typecheck", testFiles: "pnpm vitest run", mergeGate: "pnpm run test" },
  merge: {
    note: "it deploys to staging; prod moves only at release.",
    guard: "node src/ralph/migration-additive.ts --pr {pr}",
    gateWrapper: "",
    migrationMessage: "on staging now; prod at the next release.",
    afterMigration: "continue",
    waitForCi: true,
  },
};

interface RunOpts {
  stageExtra?: Record<string, unknown>;
  cleanupLine?: string;
  /** What the scripted-merge relay returns (default: it failed, so the merge agent runs). */
  scriptedMerge?: Record<string, unknown> | null;
  /** Overrides on the relayed adapter (merge fields merge into ADAPTER.merge). */
  adapter?: Record<string, unknown>;
  /** The whole preflight answer, instead of a healthy one. */
  preflight?: Record<string, unknown> | null;
  args?: Record<string, unknown>;
}

/** Run the workflow body with scripted planner answers; stages always succeed. */
async function runWorkflow(plans: PlanScript[], o: RunOpts = {}) {
  const cleanupLine = o.cleanupLine ?? '{"removed":true,"reason":"clean and pushed"}';
  const adapter = { ...ADAPTER, ...(o.adapter ?? {}), merge: { ...ADAPTER.merge, ...((o.adapter?.merge as object) ?? {}) } };
  const body = SRC.replace(/^export const meta/m, "const meta");
  const fn = new AsyncFunction("args", "agent", "phase", "log", body);
  const calls: Call[] = [];
  let planIdx = 0;
  const agent = async (prompt: string, opts: Opts = {}) => {
    calls.push({ prompt, opts });
    const label = opts.label ?? "";
    if (label === "ralph:preflight") return o.preflight !== undefined ? o.preflight : { ok: true, error: "", warnings: "", adapter };
    if (label === "ralph:gates") return { ok: true, error: "", ticked: [], waiting: [], noCheck: [], prUrl: "" };
    if (label.startsWith("ralph:plan:")) {
      const p = plans[planIdx++];
      const cleanup = /worktrees\.ts" remove/.test(prompt) ? cleanupLine : "";
      // Scripts run out → the one task is left parked (a consistent "nothing runnable").
      if (!p) return { ok: true, error: "", cleanup, hasNext: false, next: EMPTY_NEXT, parked: parkedN(1), remaining: 1 };
      if ("nothing" in p) return null;
      if ("refused" in p) return { ok: false, error: p.refused, cleanup: "", hasNext: false, next: EMPTY_NEXT, parked: [], remaining: -1 };
      if ("raw" in p) return { ok: true, error: "", cleanup, hasNext: false, next: EMPTY_NEXT, parked: [], remaining: 0, ...p.raw };
      return {
        ok: true, error: "", cleanup, hasNext: true, parked: [], remaining: p.remaining ?? 1, batched: p.batched ?? 0,
        next: { ...EMPTY_NEXT, taskId: "T1", title: "t", pointer: "p", kind: p.kind ?? "code", size: p.size ?? "standard", verify: "gate", stage: p.stage, lastEvent: p.lastEvent ?? "none", branch: "ralph/f/T1", markerCount: planIdx, redSha: p.redSha ?? "", prevRedSha: p.prevRedSha ?? "", redFiles: p.redFiles ?? [] },
      };
    }
    if (label === "ralph:cleanup" || label.endsWith(":script-cleanup")) return { output: cleanupLine };
    if (label.endsWith(":merge:script")) {
      return {
        ok: false, error: "exit 1", status: "", sha: "", migrationAdded: "", typecheckFailed: false, ciFailed: false, failedFiles: [], guardReasons: [], message: "", detail: "",
        worktreePath: `/repo/.claude/worktrees/wf_script-${calls.length}`,
        ...(o.scriptedMerge ?? {}),
      };
    }
    return { outcome: "done", prNumber: 5, summary: "ok", worktreePath: `/repo/.claude/worktrees/wf_x-${calls.length}`, ...(o.stageExtra ?? {}) };
  };
  const args = o.args ?? { ralphRoot: ROOT, ledgerPath: "docs/ralph/f-LEDGER.json" };
  const result = (await fn(args, agent, () => {}, () => {})) as Record<string, unknown>;
  return { calls, result };
}

describe("ralph-loop workflow plumbing (2026-10-12 lessons)", () => {
  it("every agent is a fresh general-purpose agent, never one that inherits the parent conversation (lesson 7)", async () => {
    const { calls } = await runWorkflow([{ stage: "red" }, { stage: "implement" }]);
    expect(calls.length).toBeGreaterThan(4);
    for (const c of calls) expect(c.opts.agentType).toBe("general-purpose");
    const stages = calls.filter((c) => c.opts.isolation === "worktree");
    expect(stages).toHaveLength(2);
    for (const s of stages) expect(s.prompt).toMatch(/no conversation with Matt or anyone else/);
  });

  it("removes each stage's worktree on the next planner call, and the last one at report (lesson 1)", async () => {
    const { calls, result } = await runWorkflow([{ stage: "red" }, { stage: "implement" }]);
    const plans = calls.filter((c) => c.opts.label?.startsWith("ralph:plan:"));
    expect(plans[0]!.prompt).not.toMatch(/worktrees\.ts" remove/);
    const firstStage = calls.find((c) => c.opts.isolation === "worktree")!;
    const firstPath = `/repo/.claude/worktrees/wf_x-${calls.indexOf(firstStage) + 1}`;
    expect(plans[1]!.prompt).toContain(`node "${ROOT}/lib/worktrees.ts" remove "${firstPath}"`);
    // The final planner call (nothing left) still removes the last stage's worktree.
    expect(plans[2]!.prompt).toMatch(/worktrees\.ts" remove "\/repo\/\.claude\/worktrees\/wf_x-/);
    expect(calls.some((c) => c.opts.label === "ralph:cleanup")).toBe(false);
    expect(result.keptWorktrees).toEqual([]);
  });

  it("when the loop stops right after a stage (stuck), the report step removes that worktree", async () => {
    const { calls, result } = await runWorkflow([{ stage: "red" }, { stage: "implement" }, { stage: "check" }], { stageExtra: { outcome: "failed" } });
    expect(result.status).toBe("stuck");
    expect(calls.find((c) => c.opts.label === "ralph:cleanup")?.prompt).toMatch(/worktrees\.ts" remove "\/repo\/\.claude\/worktrees\/wf_x-/);
  });

  it("a worktree the cleanup kept is reported, not silently dropped", async () => {
    const { result } = await runWorkflow([{ stage: "red" }], { stageExtra: {}, cleanupLine: '{"removed":false,"reason":"has uncommitted or untracked changes"}' });
    expect(result.keptWorktrees).toEqual([{ path: expect.stringMatching(/wf_x-/), reason: "has uncommitted or untracked changes" }]);
  });

  it("the preflight runs the node-native preflight before anything that needs the install (lessons 1, 2)", async () => {
    const { calls } = await runWorkflow([]);
    const pf = calls.find((c) => c.opts.label === "ralph:preflight")!;
    expect(pf.prompt).toContain(`\`node "${ROOT}/lib/preflight.ts"\``);
    expect(pf.prompt.indexOf("preflight.ts")).toBeLessThan(pf.prompt.indexOf("validate-ledger-deps"));
  });

  it("helper commands keep stderr and stdout; nothing runs pnpm --silent (lesson 2)", async () => {
    const { calls } = await runWorkflow([{ stage: "red" }]);
    for (const c of calls) expect(c.prompt).not.toMatch(/--silent/);
    const plan = calls.find((c) => c.opts.label === "ralph:plan:1")!;
    expect(plan.prompt).toMatch(/2>"\$T\/err"/);
    expect(plan.prompt).toMatch(/--- stderr ---/);
    expect(plan.prompt).toMatch(/--- stdout ---/);
  });

  it("a code review may send a bad red test back to red; a docs review may not", async () => {
    const { calls } = await runWorkflow([{ stage: "review", kind: "code" }, { stage: "review", kind: "docs" }]);
    const stages = calls.filter((c) => c.opts.isolation === "worktree");
    expect(stages[0]!.prompt).toMatch(/verdict=approve\|changes\|redo-red/);
    expect(stages[1]!.prompt).not.toMatch(/redo-red/);
  });

  it("a red redo rewrites only the tests the review named, from the branch head", async () => {
    const { calls } = await runWorkflow([{ stage: "red", lastEvent: "review-redo-red" }]);
    const red = calls.find((c) => c.opts.isolation === "worktree")!;
    expect(red.prompt).toMatch(/REDO/);
    expect(red.prompt).toMatch(/latest `ralph:review`/);
    expect(red.prompt).toMatch(/origin\/<branch>/);
  });

  it("implement after a red redo is told the red tests changed", async () => {
    const { calls } = await runWorkflow([{ stage: "implement", lastEvent: "red-redone" }]);
    const impl = calls.find((c) => c.opts.isolation === "worktree")!;
    expect(impl.prompt).toMatch(/red stage REWROTE/);
  });

  it("red records its commit and test files on its marker, first time and on a redo", async () => {
    const { calls } = await runWorkflow([{ stage: "red" }, { stage: "red", lastEvent: "review-redo-red" }]);
    const reds = calls.filter((c) => c.opts.isolation === "worktree");
    for (const red of reds) expect(red.prompt).toMatch(/ralph:red sha=<sha> files=</);
  });

  it("check gets red's baseline as exact git commands, not a search", async () => {
    const { calls } = await runWorkflow([
      { stage: "check", redSha: "r2", prevRedSha: "r1", redFiles: ["a.test.ts", "b.test.ts"] },
    ]);
    const check = calls.find((c) => c.opts.isolation === "worktree")!;
    expect(check.prompt).toContain("git merge-base --is-ancestor r2 HEAD");
    expect(check.prompt).toContain("git diff r2..HEAD -- a.test.ts b.test.ts");
    expect(check.prompt).toContain("git diff r1..r2 -- a.test.ts b.test.ts");
    expect(check.prompt).not.toMatch(/--grep/);
  });

  it("check without a redo gets no redo-scope diff", async () => {
    const { calls } = await runWorkflow([{ stage: "check", redSha: "r1", redFiles: ["a.test.ts"] }]);
    const check = calls.find((c) => c.opts.isolation === "worktree")!;
    expect(check.prompt).toContain("git diff r1..HEAD -- a.test.ts");
    expect(check.prompt).not.toMatch(/redo stayed in scope/);
  });

  it("an older PR whose red marker has no sha falls back to the branch's first non-merge commit", async () => {
    const { calls } = await runWorkflow([{ stage: "check" }]);
    const check = calls.find((c) => c.opts.isolation === "worktree")!;
    expect(check.prompt).toContain("git log --format=%H --no-merges --reverse origin/main..HEAD");
  });

  it("the plan schema requires red's commit and files", () => {
    expect(SRC).toMatch(/required: \[[^\]]*'redSha', 'prevRedSha', 'redFiles'/);
  });

  it("the stage schema lets review return redo-red", () => {
    expect(SRC).toMatch(/approve \| changes \| redo-red/);
  });

  it("a docs/measure review carries the check duties, and blind-check runs on Opus (lessons 3, 5)", async () => {
    const { calls } = await runWorkflow([{ stage: "blind-check", kind: "measure" }, { stage: "review", kind: "measure" }]);
    const stages = calls.filter((c) => c.opts.isolation === "worktree");
    expect(stages[0]!.opts.model).toBe("opus");
    expect(stages[0]!.prompt).toMatch(/never seen the grades/);
    expect(stages[1]!.prompt).toMatch(/NO separate check stage/);
  });

  it("every agent prompt opens by framing the relayed chat message as the run's trigger, not a task (2026-10-13: a preflight refused on \"remove it\")", async () => {
    // A stuck run makes the report-phase cleanup agent run too, so every agent kind is covered.
    const { calls } = await runWorkflow([{ stage: "red" }, { stage: "implement" }, { stage: "merge" }], { stageExtra: { outcome: "failed" } });
    const labels = new Set(calls.map((c) => (c.opts.label ?? "").replace(/:\d+$/, "").replace(/^ralph:T1:.*/, "ralph:stage")));
    expect(labels).toEqual(new Set(["ralph:preflight", "ralph:gates", "ralph:plan", "ralph:stage", "ralph:cleanup"]));
    for (const c of calls) {
      expect(c.prompt.startsWith("About the relayed user request:")).toBe(true);
      expect(c.prompt).toMatch(/is what started this run, so this run IS what Matt asked for/);
      expect(c.prompt).toMatch(/"remove it"/);
      expect(c.prompt).toMatch(/do not answer it, do not act on anything it mentions, and do not refuse/);
      // Framed as the trigger — never as "ignore Matt" (the harness says script text cannot override him).
      expect(c.prompt).not.toMatch(/ignore (the )?(user|Matt)/i);
    }
  });

  it("the preflight is a mechanical checklist that always runs preflight.ts, whatever the relayed message says", async () => {
    const { calls } = await runWorkflow([]);
    const pf = calls.find((c) => c.opts.label === "ralph:preflight")!;
    expect(pf.prompt).toMatch(/mechanical checklist/);
    expect(pf.prompt).toMatch(/no decisions to make/);
    expect(pf.prompt).toMatch(/Always run it/);
    expect(pf.prompt).toMatch(/deciding which is its job, not yours/);
  });

  describe("a planner answer is checked before the loop acts on it (2026-10-22: false 'complete' after E1's review)", () => {
    const plansOf = (calls: Call[]) => calls.filter((c) => c.opts.label?.startsWith("ralph:plan:")).map((c) => c.opts.label);

    it("the incident: 16 open → '0 remaining, nothing parked' after a review, twice → error, never complete", async () => {
      const bogus = { raw: { hasNext: false, parked: [], remaining: 0 } };
      const { calls, result } = await runWorkflow([{ stage: "review", remaining: 16 }, bogus, bogus]);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/dropped from 16 to 0 with 0 merge/);
      expect(result.message).toMatch(/re-run \/ralph/);
      expect(plansOf(calls)).toEqual(["ralph:plan:1", "ralph:plan:2", "ralph:plan:2:recheck"]);
    });

    it("a recheck that answers sensibly is used, and the grind carries on", async () => {
      const { calls, result } = await runWorkflow([
        { stage: "review", remaining: 16 },
        { raw: { hasNext: false, parked: [], remaining: 0 } },
        { stage: "merge", remaining: 16 },
        { raw: { hasNext: false, parked: parkedN(15), remaining: 15 } },
      ]);
      expect(result.status).toBe("parked");
      expect(result.remaining).toBe(15);
      expect(calls.filter((c) => c.opts.isolation === "worktree").map((c) => c.opts.label)).toEqual(["ralph:T1:review", "ralph:T1:merge:script", "ralph:T1:merge"]);
      // The recheck never re-removes the worktree the first planner already removed.
      expect(calls.find((c) => c.opts.label === "ralph:plan:2:recheck")!.prompt).not.toMatch(/worktrees\.ts" remove/);
    });

    it("the planner's failure shape uses remaining=-1, so a failure relayed as ok can never read as done", async () => {
      const { calls, result } = await runWorkflow([{ raw: { hasNext: false, parked: [], remaining: -1 } }, { raw: { hasNext: false, parked: [], remaining: -1 } }]);
      expect(calls.find((c) => c.opts.label === "ralph:plan:1")!.prompt).toMatch(/remaining=-1/);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/failed command as ok/);
    });

    it("'nothing runnable' must park every open task", async () => {
      const bad = { raw: { hasNext: false, parked: parkedN(2), remaining: 5 } };
      const { result } = await runWorkflow([bad, bad]);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/parks 2 of 5 open task/);
    });

    it("a mid-run fold (rows kept as status batched) is accounted for, not an unexplained drop (2026-11-10)", async () => {
      const { calls, result } = await runWorkflow([
        { stage: "review", remaining: 13, batched: 0 },
        { stage: "implement", remaining: 11, batched: 2 },
        { raw: { hasNext: false, parked: parkedN(11), remaining: 11, batched: 2 } },
      ]);
      expect(plansOf(calls)).not.toContain("ralph:plan:2:recheck");
      expect(calls.filter((c) => c.opts.isolation === "worktree").map((c) => c.opts.label)).toEqual(["ralph:T1:review", "ralph:T1:implement"]);
      expect(result.status).toBe("parked");
    });

    it("a fold and a merge in the same step are both accounted for", async () => {
      const { calls } = await runWorkflow([
        { stage: "merge", remaining: 13, batched: 0 },
        { stage: "red", remaining: 10, batched: 2 },
      ]);
      expect(plansOf(calls)).not.toContain("ralph:plan:2:recheck");
    });

    it("rows that vanish (deleted, not folded) still stop the run", async () => {
      const deleted = { stage: "implement", remaining: 11, batched: 0 };
      const { result } = await runWorkflow([{ stage: "review", remaining: 13, batched: 0 }, deleted, deleted]);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/dropped from 13 to 11 with 0 merge\(s\) and 0 fold\(s\)/);
    });

    it("a fold explains only as many rows as it batched", async () => {
      const partly = { stage: "implement", remaining: 10, batched: 2 };
      const { result } = await runWorkflow([{ stage: "review", remaining: 13, batched: 0 }, partly, partly]);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/with 0 merge\(s\) and 2 fold\(s\)/);
    });

    it("the plan schema requires the batched count, and the failure shape sets it to 0", async () => {
      expect(SRC).toMatch(/required: \[[^\]]*'remaining', 'batched'\]/);
      const { calls } = await runWorkflow([]);
      expect(calls.find((c) => c.opts.label === "ralph:plan:1")!.prompt).toMatch(/batched=0/);
    });

    it("a real finish still completes: the last merge takes open tasks from 1 to 0", async () => {
      const { calls, result } = await runWorkflow([{ stage: "merge", remaining: 1 }, { raw: { hasNext: false, parked: [], remaining: 0 } }]);
      expect(result.status).toBe("complete");
      expect(plansOf(calls)).not.toContain("ralph:plan:2:recheck");
    });

    it("a planner that refuses or fails is asked once more, and the grind carries on (2026-11-09: a Haiku planner refused outright)", async () => {
      const { calls, result } = await runWorkflow([
        { refused: "Not run yet: the cleanup step has not been executed. Stopping before both commands." },
        { stage: "red" },
      ]);
      expect(plansOf(calls).slice(0, 2)).toEqual(["ralph:plan:1", "ralph:plan:1:recheck"]);
      expect(calls.filter((c) => c.opts.isolation === "worktree").map((c) => c.opts.label)).toEqual(["ralph:T1:red"]);
      expect(result.status).toBe("parked");
    });

    it("a planner that returns nothing is asked once more too", async () => {
      const { calls, result } = await runWorkflow([{ nothing: true }, { stage: "red" }]);
      expect(plansOf(calls).slice(0, 2)).toEqual(["ralph:plan:1", "ralph:plan:1:recheck"]);
      expect(result.status).toBe("parked");
    });

    it("two failed planner answers stop as an error that says nothing was lost", async () => {
      const { calls, result } = await runWorkflow([{ refused: "exit 1\n--- stderr ---\nboom" }, { refused: "exit 1\n--- stderr ---\nboom again" }]);
      expect(plansOf(calls)).toEqual(["ralph:plan:1", "ralph:plan:1:recheck"]);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/boom; then next-step failed: exit 1/);
      expect(result.message).toMatch(/Nothing was lost: re-run \/ralph/);
    });

    it("a refused planner that never ran the cleanup hands the same worktree to the recheck, so it is not lost", async () => {
      const { calls, result } = await runWorkflow([{ stage: "red" }, { refused: "refused" }]);
      const plan2 = calls.find((c) => c.opts.label === "ralph:plan:2")!;
      const recheck = calls.find((c) => c.opts.label === "ralph:plan:2:recheck")!;
      const path = /worktrees\.ts" remove "([^"]+)"/.exec(plan2.prompt)![1];
      expect(recheck.prompt).toContain(`node "${ROOT}/lib/worktrees.ts" remove "${path}"`);
      expect(result.keptWorktrees).toEqual([]);
    });

    it("a recheck after a planner that DID run the cleanup does not remove it again", async () => {
      const { calls } = await runWorkflow([{ stage: "red" }, { raw: { ok: false, error: "exit 1", remaining: -1 } }]);
      expect(calls.find((c) => c.opts.label === "ralph:plan:2:recheck")!.prompt).not.toMatch(/worktrees\.ts" remove/);
    });

    it("the planner and every helper agent run on Sonnet, not Haiku", async () => {
      const { calls } = await runWorkflow([{ stage: "red" }, { stage: "implement" }, { stage: "check" }], { stageExtra: { outcome: "failed" } });
      const helpers = calls.filter((c) => c.opts.isolation !== "worktree");
      expect(new Set(helpers.map((c) => (c.opts.label ?? "").replace(/:\d+.*$/, "")))).toEqual(new Set(["ralph:preflight", "ralph:gates", "ralph:plan", "ralph:cleanup"]));
      for (const c of helpers) expect(c.opts.model, c.opts.label).toBe("sonnet");
    });

    it("the planner is told to always run the commands itself", async () => {
      const { calls } = await runWorkflow([]);
      expect(calls.find((c) => c.opts.label === "ralph:plan:1")!.prompt).toMatch(/Never answer without running them/);
    });

    it("a fresh run whose first answer is 'complete' is trusted (nothing to compare against)", async () => {
      const { result } = await runWorkflow([{ raw: { hasNext: false, parked: [], remaining: 0 } }]);
      expect(result.status).toBe("complete");
    });
  });

  it("the merge stage is pointed at the known-flakes list (lesson 9)", async () => {
    const { calls } = await runWorkflow([{ stage: "merge" }]);
    expect(calls.find((c) => c.opts.label === "ralph:T1:merge")!.prompt).toMatch(/docs\/ralph\/known-flakes\.md/);
  });

  it("the merge stage never records flakes on the task branch, and needs a FULL re-run to call one (PR #1164 review)", async () => {
    const { calls } = await runWorkflow([{ stage: "merge" }]);
    const prompt = calls.find((c) => c.opts.label === "ralph:T1:merge")!.prompt;
    expect(prompt).not.toMatch(/record a flake there/);
    expect(prompt).not.toMatch(/commit[^.]*task branch/i);
    expect(prompt).toMatch(/NEVER go on the task branch/);
    expect(prompt).toMatch(/`ralph\/known-flakes` branch/);
    expect(prompt).toMatch(/FULL re-run/);
    expect(prompt).toMatch(/known-flakes\.ts decide/);
  });

  it("the merge agent's gate, guard, CI wait and deploy note all come from the adapter", async () => {
    const { calls } = await runWorkflow([{ stage: "merge" }]);
    const prompt = calls.find((c) => c.opts.label === "ralph:T1:merge")!.prompt;
    expect(prompt).toContain("MERGE GATE (TYPECHECK + `pnpm run test`)");
    expect(prompt).toContain("TYPECHECK: `pnpm typecheck`");
    expect(prompt).toContain("`node src/ralph/migration-additive.ts --pr <n>`");
    expect(prompt).toMatch(/ok=false \(or fails\), do NOT merge/);
    expect(prompt).toMatch(/--reason guardrail/);
    expect(prompt).toContain("What a merge does in this repo: it deploys to staging; prod moves only at release.");
    expect(prompt).toMatch(/gh pr checks <n> --watch/);
  });

  it("an adapter with no guard and no CI wait says neither", async () => {
    const { calls } = await runWorkflow([{ stage: "merge" }], { adapter: { merge: { guard: "", waitForCi: false } } });
    const prompt = calls.find((c) => c.opts.label === "ralph:T1:merge")!.prompt;
    expect(prompt).not.toMatch(/merge guard/);
    expect(prompt).not.toMatch(/gh pr checks/);
  });

  it("afterMigration:continue — a merged migration is reported and the grind carries on", async () => {
    const { calls, result } = await runWorkflow([{ stage: "merge", remaining: 2 }, { stage: "red", remaining: 1 }], { stageExtra: { migrationAdded: "drizzle/0010_x.sql" } });
    expect(result.status).toBe("parked");
    expect(calls.filter((c) => c.opts.isolation === "worktree").map((c) => c.opts.label)).toEqual(["ralph:T1:merge:script", "ralph:T1:merge", "ralph:T1:red"]);
    // Only a merge counts as a merged migration, not the red stage that also reported one.
    expect(result.migrationsMerged).toEqual([{ task: "T1", files: "drizzle/0010_x.sql" }]);
  });

  it("afterMigration:stop — a merged migration stops the run with the adapter's message", async () => {
    const { result } = await runWorkflow([{ stage: "merge", remaining: 2 }, { stage: "red", remaining: 1 }], {
      stageExtra: { migrationAdded: "drizzle/0210_x.sql" },
      adapter: { merge: { afterMigration: "stop", migrationMessage: "apply it (pnpm db:migrate), then re-run /ralph" } },
    });
    expect(result.status).toBe("migration-pending");
    expect(result.message).toBe("T1 merged migration drizzle/0210_x.sql: apply it (pnpm db:migrate), then re-run /ralph");
  });

  it("a scripted merge that read afterMigration:stop stops the run even if the preflight copy said continue", async () => {
    const { result } = await runWorkflow([{ stage: "merge", remaining: 2 }, { stage: "red", remaining: 1 }], {
      scriptedMerge: { ok: true, error: "", status: "merged", sha: "abc", migrationAdded: "drizzle/0210_x.sql", afterMigration: "stop", message: "PR #5 squash-merged" },
    });
    expect(result.status).toBe("migration-pending");
  });

  it("the workflow itself names no repo: every repo fact comes from the adapter", () => {
    expect(SRC).not.toMatch(/datadingo|farnell|Vercel|Neon|drizzle|pnpm release|test:release|ship\.sh|warehouse|heavy-job/i);
    expect(SRC).not.toMatch(/src\/ralph/);
  });

  it("every helper runs as plain node from the plugin root", async () => {
    const { calls } = await runWorkflow([{ stage: "red" }, { stage: "merge" }], { stageExtra: { outcome: "failed" } });
    const cmds = calls.flatMap((c) => [...c.prompt.matchAll(/node "([^"]+)"/g)].map((m) => m[1]!));
    expect(cmds.length).toBeGreaterThan(4);
    for (const c of cmds) expect(c.startsWith(`${ROOT}/lib/`) || c === `${ROOT}/lib/<helper>.ts`, c).toBe(true);
    for (const c of calls) expect(c.prompt).not.toMatch(/pnpm tsx/);
  });

  describe("the adapter (relayed by the preflight)", () => {
    it("args without ralphRoot stop before any agent runs", async () => {
      const { calls, result } = await runWorkflow([], { args: { ledgerPath: "docs/ralph/f-LEDGER.json" } });
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/ralphRoot/);
      expect(calls).toEqual([]);
    });

    it("a preflight that relays no adapter, or one missing a field, fails the run before the grind", async () => {
      for (const adapter of [null, { ...ADAPTER, commands: { typecheck: "x", testFiles: "y" } }]) {
        const { calls, result } = await runWorkflow([{ stage: "red" }], { preflight: { ok: true, error: "", warnings: "", adapter } });
        expect(result.status).toBe("preflight-failed");
        expect(calls.map((c) => c.opts.label)).toEqual(["ralph:preflight"]);
      }
      const { result } = await runWorkflow([{ stage: "red" }], { preflight: { ok: true, error: "", warnings: "", adapter: { ...ADAPTER, commands: { typecheck: "x", testFiles: "y" } } } });
      expect(result.message).toMatch(/commands\.mergeGate/);
    });

    it("every stage reads the core policy from the plugin AND the repo's addendum, and gets the repo's commands", async () => {
      const { calls } = await runWorkflow([{ stage: "red" }]);
      const red = calls.find((c) => c.opts.label === "ralph:T1:red")!.prompt;
      expect(red).toContain(`${ROOT}/docs/ralph-policy.md`);
      expect(red).toContain("docs/ralph/repo-policy.md");
      expect(red).toContain("SETUP (first, in your fresh worktree): `pnpm install --frozen-lockfile --prefer-offline`");
      expect(red).toContain("TESTS <files>: `pnpm vitest run <files>`");
    });
  });

  describe("2026-11-02: scripted merge + small tasks", () => {
    const merged = { ok: true, error: "", status: "merged", sha: "abc", message: "PR #5 squash-merged at abc" };

    it("the merge stage first runs merge.ts through a Sonnet relay in a worktree, after the adapter's setup", async () => {
      const { calls } = await runWorkflow([{ stage: "merge" }], { scriptedMerge: merged });
      const relay = calls.find((c) => c.opts.label === "ralph:T1:merge:script")!;
      expect(relay.opts).toMatchObject({ model: "sonnet", isolation: "worktree", agentType: "general-purpose" });
      expect(relay.prompt).toContain(`node "${ROOT}/lib/merge.ts" --pr 0 --branch "ralph/f/T1" --ledger "docs/ralph/f-LEDGER.json" --task "T1"`);
      expect(relay.prompt).toContain("`pnpm install --frozen-lockfile --prefer-offline`");
      expect(relay.prompt).toMatch(/600000/);
    });

    it("a scripted merge that merged needs no merge agent, and counts as merged", async () => {
      const { calls, result } = await runWorkflow([{ stage: "merge" }], { scriptedMerge: merged });
      expect(calls.some((c) => c.opts.label === "ralph:T1:merge")).toBe(false);
      expect(result.merged).toEqual(["T1 #0"]);
    });

    it("a red gate hands the agent the first run's failures, so it does not re-run that gate", async () => {
      const red = { ok: true, error: "", status: "red", sha: "abc", failedFiles: ["src/a.test.ts"], message: "pnpm test failed in 1 file(s)", detail: "FAIL src/a.test.ts" };
      const { calls } = await runWorkflow([{ stage: "merge" }], { scriptedMerge: red });
      const agentPrompt = calls.find((c) => c.opts.label === "ralph:T1:merge")!.prompt;
      expect(agentPrompt).toMatch(/Do NOT re-run the first gate/);
      expect(agentPrompt).toContain("src/a.test.ts");
      expect(agentPrompt).toMatch(/known-flakes\.ts decide/);
      // The relay's worktree is removed before the agent gets its own.
      expect(calls.some((c) => c.opts.label === "ralph:T1:merge:script-cleanup")).toBe(true);
    });

    it("a red CI (local gate green) is handed over as a CI failure", async () => {
      const red = { ok: true, error: "", status: "red", sha: "abc", ciFailed: true, message: "the PR's CI failed: ci" };
      const { calls } = await runWorkflow([{ stage: "merge" }], { scriptedMerge: red });
      expect(calls.find((c) => c.opts.label === "ralph:T1:merge")!.prompt).toMatch(/local MERGE GATE passed but the PR's CI failed/);
    });

    it("a type-check failure goes straight back to implement, never through the flake procedure", async () => {
      const red = { ok: true, error: "", status: "red", sha: "abc", typecheckFailed: true, message: "pnpm typecheck failed" };
      const { calls } = await runWorkflow([{ stage: "merge" }], { scriptedMerge: red });
      const agentPrompt = calls.find((c) => c.opts.label === "ralph:T1:merge")!.prompt;
      expect(agentPrompt).toMatch(/never a flake/);
      expect(agentPrompt).toMatch(/result=fail stage=merge/);
    });

    it("a refused guard is handed over as a guardrail park, with its reasons", async () => {
      const g = { ok: true, error: "", status: "guardrail", guardReasons: ["drizzle/0011_x.sql: DROP COLUMN"], message: "the merge guard refused" };
      const { calls } = await runWorkflow([{ stage: "merge" }], { scriptedMerge: g });
      const agentPrompt = calls.find((c) => c.opts.label === "ralph:T1:merge")!.prompt;
      expect(agentPrompt).toMatch(/REFUSED: drizzle\/0011_x\.sql: DROP COLUMN/);
      expect(agentPrompt).toMatch(/Do NOT merge\. Post the blocked comment with `--reason guardrail`/);
    });

    it("a busy gate parks the task for this run without a merge agent or a failure", async () => {
      const busy = { ok: true, error: "", status: "busy", message: "the merge gate did not run: embed holds the heavy-job lock" };
      const { calls, result } = await runWorkflow([{ stage: "merge" }], { scriptedMerge: busy });
      expect(calls.some((c) => c.opts.label === "ralph:T1:merge")).toBe(false);
      expect(result.skippedThisRun).toEqual(["T1"]);
      expect((result.history as { outcome: string }[])[0]!.outcome).toBe("busy");
    });

    it("a relay that failed falls back to the full merge stage", async () => {
      const { calls } = await runWorkflow([{ stage: "merge" }]);
      expect(calls.find((c) => c.opts.label === "ralph:T1:merge")!.prompt).toMatch(/Do the whole merge stage yourself/);
    });

    it("a small code task's implement writes its own tests; its review does the check duties", async () => {
      const { calls } = await runWorkflow([{ stage: "implement", size: "small" }, { stage: "review", size: "small" }]);
      const impl = calls.find((c) => c.opts.label === "ralph:T1:implement")!.prompt;
      const review = calls.find((c) => c.opts.label === "ralph:T1:review")!.prompt;
      expect(impl).toMatch(/SMALL code task/);
      expect(impl).toMatch(/write the acceptance tests yourself/);
      expect(impl).toContain("size=small");
      expect(review).toMatch(/NO red and NO check stage/);
      expect(review).not.toMatch(/redo-red/);
    });

    it("a standard code review can still send a bad red test back", async () => {
      const { calls } = await runWorkflow([{ stage: "review" }]);
      expect(calls.find((c) => c.opts.label === "ralph:T1:review")!.prompt).toMatch(/redo-red/);
    });
  });
});
