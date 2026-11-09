import { describe, it, expect } from "vitest";
import { loadAndDecide, type Exec } from "../../lib/next-step.ts";

// The CLI plumbing, driven by a fake exec: which git/gh calls it makes and how it
// turns their output into PrFacts.
const ledgerJson = JSON.stringify({
  feature: { slug: "feat" },
  tasks: [
    { id: "A", title: "a", pointer: "p", status: "done", kind: "code", verify: "gate" },
    { id: "B", title: "b", pointer: "p", status: "todo", kind: "code", verify: "gate" },
  ],
});

function fakeExec(prsByBranch: Record<string, unknown[]>) {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "show") return ledgerJson;
    if (cmd === "git") return "";
    const branch = args[args.indexOf("--head") + 1] ?? "";
    return JSON.stringify(prsByBranch[branch] ?? []);
  };
  return { exec, calls };
}

describe("loadAndDecide", () => {
  it("reads the ledger from origin/main and queries PRs per not-done task branch", () => {
    const { exec, calls } = fakeExec({});
    const got = loadAndDecide("docs/ralph/feat-LEDGER.json", new Set(), exec);
    expect(calls).toContainEqual(["git", "show", "origin/main:docs/ralph/feat-LEDGER.json"]);
    const ghHeads = calls.filter((c) => c[0] === "gh").map((c) => c[c.indexOf("--head") + 1]);
    expect(ghHeads).toEqual(["ralph/feat/B"]);
    expect(got).toMatchObject({ hasNext: true, next: { taskId: "B", stage: "red" } });
  });

  it("orders comments by createdAt before reading markers, and drops PRs for other branches", () => {
    const { exec } = fakeExec({
      "ralph/feat/B": [
        {
          number: 5, state: "OPEN", headRefName: "ralph/feat/B", headRefOid: "x", url: "u",
          comments: [
            { body: "<!-- ralph:implemented sha=x -->", createdAt: "2026-10-10T02:00:00Z" },
            { body: "<!-- ralph:red -->", createdAt: "2026-10-10T01:00:00Z" },
          ],
        },
        { number: 6, state: "OPEN", headRefName: "ralph/feat/B-other", headRefOid: "y", url: "u", comments: [] },
      ],
    });
    expect(loadAndDecide("l.json", new Set(), exec)).toMatchObject({
      next: { taskId: "B", stage: "check", prNumber: 5, markerCount: 2 },
    });
  });

  it("returns an error string for a ledger without a slug", () => {
    const exec: Exec = (cmd, args) => (cmd === "git" && args[0] === "show" ? "{}" : "[]");
    expect(typeof loadAndDecide("l.json", new Set(), exec)).toBe("string");
  });
});
