import { describe, it, expect } from "vitest";
import {
  parseWorktreePorcelain,
  decideRemoval,
  removeStageWorktree,
  sweepStageWorktrees,
  splitStatus,
  isRegenerableIgnored,
  type RemovalFacts,
  type Exec,
} from "../../lib/worktrees.ts";

const MAIN = "/repo";
const STAGE = "/repo/.claude/worktrees/wf_faed6250-c6c-10";

const PORCELAIN = [
  `worktree ${MAIN}\nHEAD aaa\nbranch refs/heads/main`,
  `worktree ${STAGE}\nHEAD bbb\ndetached`,
  `worktree /repo/.claude/worktrees/wf_faed6250-c6c-12\nHEAD ccc\ndetached\nlocked`,
  `worktree /repo/.claude/worktrees/agent-123\nHEAD ddd\ndetached`,
].join("\n\n") + "\n";

function facts(over: Partial<RemovalFacts> = {}, entry: Partial<RemovalFacts["entry"]> = {}): RemovalFacts {
  return {
    mainPath: MAIN,
    entry: { path: STAGE, head: "bbb", detached: true, branch: "", locked: false, bare: false, ...entry },
    status: "",
    ignored: [],
    unpushedCount: 0,
    headOnGitHub: false,
    ageHours: 100,
    ...over,
  };
}

describe("parseWorktreePorcelain", () => {
  it("reads path, HEAD, detached, branch and locked", () => {
    const got = parseWorktreePorcelain(PORCELAIN);
    expect(got.map((e) => e.path)).toEqual([MAIN, STAGE, "/repo/.claude/worktrees/wf_faed6250-c6c-12", "/repo/.claude/worktrees/agent-123"]);
    expect(got[0]).toMatchObject({ branch: "refs/heads/main", detached: false });
    expect(got[1]).toMatchObject({ head: "bbb", detached: true, locked: false });
    expect(got[2]!.locked).toBe(true);
  });
});

describe("decideRemoval — removes only what cannot hold work", () => {
  it("removes a clean, pushed stage worktree", () => {
    expect(decideRemoval(facts())).toEqual({ remove: true });
  });

  it("removes a clean worktree whose commits are only on GitHub (squash-merged, branch deleted)", () => {
    expect(decideRemoval(facts({ unpushedCount: 2, headOnGitHub: true }))).toEqual({ remove: true });
  });

  it.each<[string, RemovalFacts]>([
    ["dirty", facts({ status: " M src/x.ts\n" })],
    ["untracked file", facts({ status: "?? notes.txt\n" })],
    ["unpushed commits", facts({ unpushedCount: 1, headOnGitHub: false })],
    ["results in an ignored dir", facts({ ignored: ["node_modules/", "tmp/"] })],
    ["ignored eval output", facts({ ignored: ["eval/results/"] })],
    ["locked", facts({}, { locked: true })],
    ["the main checkout", facts({}, { path: MAIN })],
    ["not a wf_ worktree", facts({}, { path: "/repo/.claude/worktrees/agent-123" })],
    ["outside .claude/worktrees", facts({}, { path: "/elsewhere/wf_x" })],
    ["nested deeper", facts({}, { path: "/repo/.claude/worktrees/x/wf_y" })],
  ])("keeps a %s worktree", (_label, f) => {
    expect(decideRemoval(f).remove).toBe(false);
  });

  it("removes one whose only ignored files are regenerable (node_modules, .env symlinks, build output)", () => {
    expect(decideRemoval(facts({ ignored: ["node_modules/", ".env", ".env.deploy", "dist/", "tsconfig.tsbuildinfo"] }))).toEqual({ remove: true });
  });

  it("names the ignored files it is keeping for", () => {
    expect(decideRemoval(facts({ ignored: ["tmp/", "data/"] }))).toEqual({
      remove: false,
      reason: "holds ignored files that may be results (tmp/, data/)",
    });
  });

  it("the sweep's age floor keeps a recently touched worktree (a stage still running)", () => {
    expect(decideRemoval(facts({ ageHours: 2 }), 24)).toMatchObject({ remove: false });
    expect(decideRemoval(facts({ ageHours: 30 }), 24)).toEqual({ remove: true });
  });
});

describe("splitStatus / isRegenerableIgnored", () => {
  it("separates changes from !! ignored lines", () => {
    expect(splitStatus(" M src/x.ts\n?? notes.txt\n!! node_modules/\n!! tmp/\n")).toEqual({
      status: " M src/x.ts\n?? notes.txt",
      ignored: ["node_modules/", "tmp/"],
    });
    expect(splitStatus("!! .env\n")).toEqual({ status: "", ignored: [".env"] });
  });

  it.each([
    ["node_modules/", true],
    ["packages/a/node_modules/", true],
    [".next/", true],
    ["src/.next/", false],
    [".env", true],
    [".env.deploy", true],
    ["dist/", true],
    ["x.log", true],
    ["tmp/", false],
    ["data/", false],
    ["eval/results/", false],
    ["backups/", false],
    ["src/.env", false],
    [".claude/settings.local.json", false],
  ] as const)("%s regenerable = %s", (p, want) => {
    expect(isRegenerableIgnored(p)).toBe(want);
  });
});

function fakeGit(over: { status?: Record<string, string>; unpushed?: Record<string, string> } = {}) {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args, cwd) => {
    calls.push([cwd ?? "", cmd, ...args]);
    if (cmd === "git" && args[0] === "worktree" && args[1] === "list") return PORCELAIN;
    if (cmd === "git" && args.includes("status")) return over.status?.[cwd ?? ""] ?? "";
    if (cmd === "git" && args[0] === "rev-list") return over.unpushed?.[cwd ?? ""] ?? "0";
    if (cmd === "gh") throw new Error("404");
    return "";
  };
  return { exec, calls };
}

describe("removeStageWorktree (the post-stage remove)", () => {
  it("removes the stage's own worktree from the main checkout, with --force for ignored files only", () => {
    const { exec, calls } = fakeGit();
    const r = removeStageWorktree(STAGE, MAIN, { exec, ageHours: () => 0 });
    expect(r).toMatchObject({ removed: true });
    expect(calls).toContainEqual([MAIN, "git", "worktree", "remove", "--force", STAGE]);
  });

  it("keeps a dirty one and says why", () => {
    const { exec, calls } = fakeGit({ status: { [STAGE]: " M x.ts\n" } });
    const r = removeStageWorktree(STAGE, MAIN, { exec, ageHours: () => 0 });
    expect(r).toMatchObject({ removed: false, reason: expect.stringMatching(/uncommitted/) });
    expect(calls.some((c) => c.includes("remove"))).toBe(false);
  });

  it("measures age BEFORE git status, and status can't write the index (a refresh would make it look just touched)", () => {
    const { exec, calls } = fakeGit();
    const order: string[] = [];
    const tracing: Exec = (cmd, args, cwd) => {
      if (args.includes("status")) order.push("status");
      return exec(cmd, args, cwd);
    };
    removeStageWorktree(STAGE, MAIN, {
      exec: tracing,
      ageHours: () => {
        order.push("age");
        return 0;
      },
    });
    expect(order).toEqual(["age", "status"]);
    expect(calls).toContainEqual([STAGE, "git", "--no-optional-locks", "status", "--porcelain", "--ignored"]);
  });

  it("keeps one holding ignored results, and never runs the remove", () => {
    const { exec, calls } = fakeGit({ status: { [STAGE]: "!! node_modules/\n!! tmp/\n" } });
    const r = removeStageWorktree(STAGE, MAIN, { exec, ageHours: () => 0 });
    expect(r).toMatchObject({ removed: false, reason: expect.stringMatching(/tmp\//) });
    expect(calls.some((c) => c.includes("remove"))).toBe(false);
  });

  it("keeps one with unpushed commits GitHub does not have", () => {
    const { exec } = fakeGit({ unpushed: { [STAGE]: "3" } });
    expect(removeStageWorktree(STAGE, MAIN, { exec, ageHours: () => 0 })).toMatchObject({ removed: false });
  });

  it("is a no-op for a path that is not a registered worktree", () => {
    const { exec } = fakeGit();
    expect(removeStageWorktree("/repo/.claude/worktrees/wf_gone", MAIN, { exec })).toMatchObject({ removed: false });
  });
});

describe("sweepStageWorktrees (the preflight sweep)", () => {
  it("removes stale safe wf_ worktrees only, never agent-* or locked ones, then prunes", () => {
    const { exec, calls } = fakeGit();
    const rows = sweepStageWorktrees(MAIN, 24, { exec, ageHours: () => 48 });
    expect(rows.filter((r) => r.removed).map((r) => r.path)).toEqual([STAGE]);
    expect(rows.find((r) => r.path.endsWith("c6c-12"))).toMatchObject({ removed: false, reason: "locked" });
    expect(rows.some((r) => r.path.includes("agent-123"))).toBe(false);
    expect(calls).toContainEqual([MAIN, "git", "worktree", "prune"]);
  });

  it("removes nothing that was touched inside the age floor", () => {
    const { exec } = fakeGit();
    expect(sweepStageWorktrees(MAIN, 24, { exec, ageHours: () => 1 }).every((r) => !r.removed)).toBe(true);
  });
});
