import { describe, expect, it } from "vitest";

import {
  evaluateCheck,
  planGateTicks,
  validateDoneWhen,
  type GateContext,
  type GateIO,
  type GateLedger,
} from "../../lib/gate-checks.ts";

// The repo the checks run in, and another repo it can wait on (both have a prod reader).
const SELF_REPO = "acme/app";
const API_REPO = "acme/api";
const CTX: GateContext = { self: SELF_REPO, prodRepos: [SELF_REPO, API_REPO], extraTypes: [] };

// A fake world: every fact a check can read, all settable per test. This repo
// has PR 100 merged (aaa) and 200 open; the API repo has PR 100 merged (bbb)
// and PR 300 open. Prod: app at app-prod (includes aaa), API at api-prod
// (includes bbb).
function io(over: Partial<GateIO> = {}): GateIO {
  return {
    pr: async (n, repo) => {
      if (repo === SELF_REPO) {
        if (n === 100) return { state: "MERGED", mergedAt: "2026-10-05T00:00:00Z", mergeCommit: "aaa" };
        if (n === 200) return { state: "OPEN", mergedAt: null, mergeCommit: null };
      }
      if (repo === API_REPO) {
        if (n === 100) return { state: "MERGED", mergedAt: "2026-10-04T00:00:00Z", mergeCommit: "bbb" };
        if (n === 300) return { state: "OPEN", mergedAt: null, mergeCommit: null };
      }
      return null;
    },
    prodCommit: async (repo) => (repo === SELF_REPO ? "app-prod" : repo === API_REPO ? "api-prod" : null),
    isAncestor: async (a, b, repo) =>
      (repo === SELF_REPO && a === "aaa" && b === "app-prod") || (repo === API_REPO && a === "bbb" && b === "api-prod"),
    issueState: async (n, repo) =>
      repo === SELF_REPO ? (n === 7 ? "CLOSED" : n === 8 ? "OPEN" : null) : repo === API_REPO && n === 9 ? "CLOSED" : null,
    docOnMain: async (f) => (f === "docs/x.md" ? "intro\nDecision: keep LinkedIn-only\n" : null),
    extra: async () => ({ pass: false, reason: "no repo checks in this fake" }),
    ...over,
  };
}

describe("evaluateCheck — each check type, anchored", () => {
  it("pr-merged passes only on a merged PR", async () => {
    expect((await evaluateCheck({ type: "pr-merged", pr: 100 }, io(), CTX)).pass).toBe(true);
    expect((await evaluateCheck({ type: "pr-merged", pr: 200 }, io(), CTX)).pass).toBe(false);
    expect((await evaluateCheck({ type: "pr-merged", pr: 999 }, io(), CTX)).pass).toBe(false);
  });

  it("prod-includes passes when prod's commit contains the PR's merge commit", async () => {
    expect((await evaluateCheck({ type: "prod-includes", pr: 100 }, io(), CTX)).pass).toBe(true);
    // prod is on an older commit
    const old = io({ isAncestor: async () => false });
    expect((await evaluateCheck({ type: "prod-includes", pr: 100 }, old, CTX)).pass).toBe(false);
    // an unmerged PR can never be on prod
    expect((await evaluateCheck({ type: "prod-includes", pr: 200 }, io(), CTX)).pass).toBe(false);
    // prod unreachable → not done
    const down = io({ prodCommit: async () => null });
    expect((await evaluateCheck({ type: "prod-includes", pr: 100 }, down, CTX)).pass).toBe(false);
  });

  it("doc-contains ignores text inside an HTML comment", async () => {
    const body = '<!-- e.g. "- G0 — API part 1 on staging: …" -->\n\n- D1 — Decision: x';
    const docIo = { ...io(), docOnMain: async () => body };
    expect((await evaluateCheck({ type: "doc-contains", file: "docs/x.md", text: "G0 — API part 1 on staging" }, docIo, CTX)).pass).toBe(false);
    expect((await evaluateCheck({ type: "doc-contains", file: "docs/x.md", text: "D1 — Decision:" }, docIo, CTX)).pass).toBe(true);
  });

  it("issue-closed, doc-contains", async () => {
    expect((await evaluateCheck({ type: "issue-closed", issue: 7 }, io(), CTX)).pass).toBe(true);
    expect((await evaluateCheck({ type: "issue-closed", issue: 8 }, io(), CTX)).pass).toBe(false);
    expect((await evaluateCheck({ type: "doc-contains", file: "docs/x.md", text: "Decision: keep" }, io(), CTX)).pass).toBe(true);
    expect((await evaluateCheck({ type: "doc-contains", file: "docs/x.md", text: "Decision: drop" }, io(), CTX)).pass).toBe(false);
  });

  it("fails closed when reading the evidence throws", async () => {
    const broken = io({ prodCommit: async () => { throw new Error("vercel down"); } });
    const r = await evaluateCheck({ type: "prod-includes", pr: 100 }, broken, CTX);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/vercel down/);
  });
});

describe("evaluateCheck — the repo field (cross-repo gates)", () => {
  it("no repo reads this repo; repo reads the named one", async () => {
    const seen: string[] = [];
    const spy = io({ pr: async (n, repo) => (seen.push(`${repo}#${n}`), null) });
    await evaluateCheck({ type: "pr-merged", pr: 5 }, spy, CTX);
    await evaluateCheck({ type: "pr-merged", pr: 6, repo: API_REPO }, spy, CTX);
    expect(seen).toEqual([`${SELF_REPO}#5`, `${API_REPO}#6`]);
  });

  it("cross-repo pr-merged: API PR 100 merged, API PR 300 open, and the app's PR 200 is not the API's", async () => {
    expect((await evaluateCheck({ type: "pr-merged", pr: 100, repo: API_REPO }, io(), CTX))).toEqual({
      pass: true,
      reason: `PR ${API_REPO}#100 merged`,
    });
    expect((await evaluateCheck({ type: "pr-merged", pr: 300, repo: API_REPO }, io(), CTX)).pass).toBe(false);
    expect((await evaluateCheck({ type: "pr-merged", pr: 200, repo: API_REPO }, io(), CTX)).pass).toBe(false);
  });

  it("cross-repo prod-includes reads the API's prod commit and checks ancestry in the API repo", async () => {
    const calls: string[] = [];
    const spy = io({
      prodCommit: async (repo) => (calls.push(`prod:${repo}`), repo === API_REPO ? "api-prod" : "app-prod"),
      isAncestor: async (a, b, repo) => (calls.push(`anc:${repo}:${a}..${b}`), repo === API_REPO && a === "bbb"),
    });
    const r = await evaluateCheck({ type: "prod-includes", pr: 100, repo: API_REPO }, spy, CTX);
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/acme\/api prod api-prod/);
    expect(calls).toEqual([`prod:${API_REPO}`, `anc:${API_REPO}:bbb..api-prod`]);
  });

  it("cross-repo prod-includes fails when API prod is behind, or unreachable", async () => {
    const behind = io({ isAncestor: async () => false });
    expect((await evaluateCheck({ type: "prod-includes", pr: 100, repo: API_REPO }, behind, CTX)).reason).toMatch(/does not include/);
    const down = io({ prodCommit: async (repo) => (repo === API_REPO ? null : "app-prod") });
    expect((await evaluateCheck({ type: "prod-includes", pr: 100, repo: API_REPO }, down, CTX)).pass).toBe(false);
  });

  it("cross-repo issue-closed", async () => {
    expect((await evaluateCheck({ type: "issue-closed", issue: 9, repo: API_REPO }, io(), CTX)).pass).toBe(true);
    expect((await evaluateCheck({ type: "issue-closed", issue: 7, repo: API_REPO }, io(), CTX)).pass).toBe(false);
  });
});

describe("validateDoneWhen — only the fixed, anchored check types", () => {
  it("accepts one check or a list", () => {
    expect(validateDoneWhen({ type: "prod-includes", pr: 1 }, CTX)).toEqual([]);
    expect(validateDoneWhen([{ type: "pr-merged", pr: 1 }, { type: "issue-closed", issue: 2 }], CTX)).toEqual([]);
  });

  it("rejects unknown types, missing anchors and empty lists", () => {
    expect(validateDoneWhen({ type: "shipped-recently" }, CTX)).not.toEqual([]);
    expect(validateDoneWhen({ type: "prod-includes" }, CTX)).not.toEqual([]);
    expect(validateDoneWhen({ type: "issue-closed" }, CTX)).not.toEqual([]);
    expect(validateDoneWhen({ type: "doc-contains", file: "x.md" }, CTX)).not.toEqual([]);
    expect(validateDoneWhen([], CTX)).not.toEqual([]);
    expect(validateDoneWhen(undefined, CTX)).not.toEqual([]);
  });

  it.each([
    { type: "migration-applied", migration: "0179" },
    { type: "built-after", pr: 2 },
    { type: "loaded-after", source: "pdl", pr: 2 },
    { type: "sql-true", query: "SELECT true" },
  ])("rejects a repo-provided type ($type) in a repo that does not provide it", (c) => {
    const errs = validateDoneWhen(c, CTX);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/unknown type/);
  });

  it("accepts a repo-provided type by name where the adapter declares it (its shape is the repo's to judge)", () => {
    const withSql: GateContext = { ...CTX, extraTypes: ["sql-true"] };
    expect(validateDoneWhen({ type: "sql-true", query: "SELECT true" }, withSql)).toEqual([]);
    expect(validateDoneWhen({ type: "sql-true" }, withSql)).toEqual([]);
    expect(validateDoneWhen({ type: "built-after", pr: 2 }, withSql)).not.toEqual([]);
  });

  it("prod-includes with no repo needs a prod reader for THIS repo", () => {
    const noProd: GateContext = { self: SELF_REPO, prodRepos: [API_REPO], extraTypes: [] };
    expect(validateDoneWhen({ type: "prod-includes", pr: 1 }, noProd).join(" ")).toMatch(/can only read prod for acme\/api/);
    expect(validateDoneWhen({ type: "prod-includes", pr: 1, repo: API_REPO }, noProd)).toEqual([]);
  });

  it("accepts a repo on pr-merged / prod-includes / issue-closed", () => {
    expect(validateDoneWhen({ type: "pr-merged", pr: 1, repo: API_REPO }, CTX)).toEqual([]);
    expect(validateDoneWhen({ type: "prod-includes", pr: 1, repo: API_REPO }, CTX)).toEqual([]);
    expect(validateDoneWhen({ type: "prod-includes", pr: 1, repo: SELF_REPO }, CTX)).toEqual([]);
    expect(validateDoneWhen({ type: "issue-closed", issue: 1, repo: "acme/ds" }, CTX)).toEqual([]);
  });

  it("rejects a malformed repo, a repo on doc-contains, and prod-includes for a repo with no known prod", () => {
    expect(validateDoneWhen({ type: "pr-merged", pr: 1, repo: "api" }, CTX)).not.toEqual([]);
    expect(validateDoneWhen({ type: "pr-merged", pr: 1, repo: 7 }, CTX)).not.toEqual([]);
    expect(validateDoneWhen({ type: "doc-contains", file: "x.md", text: "y", repo: API_REPO }, CTX)).not.toEqual([]);
    expect(validateDoneWhen({ type: "prod-includes", pr: 1, repo: "acme/ds" }, CTX)).not.toEqual([]);
  });
});

describe("planGateTicks — which gates Ralph ticks itself", () => {
  const ledger = (): GateLedger => ({
    feature: { slug: "f" },
    tasks: [
      { id: "W1", title: "code", status: "done" },
      { id: "HG-1", title: "deploy", status: "todo", human_gate: true, deps: ["W1"], done_when: { type: "prod-includes", pr: 100 } },
      {
        id: "HG-2",
        title: "API ship",
        status: "todo",
        human_gate: true,
        deps: ["HG-1"],
        done_when: { type: "prod-includes", pr: 100, repo: API_REPO },
      },
      { id: "HG-3", title: "decide", status: "todo", kind: "decision", human_gate: true, done_when: { type: "issue-closed", issue: 8 } },
      { id: "HG-4", title: "old gate", status: "todo", human_gate: true },
    ],
  });

  it("ticks every gate whose checks pass, including a chain in one pass", async () => {
    const plan = await planGateTicks(ledger(), io(), "2026-10-10", CTX);
    expect(plan.ticked.map((t) => t.id)).toEqual(["HG-1", "HG-2"]);
    expect(plan.waiting.map((t) => t.id)).toEqual(["HG-3"]);
    expect(plan.noCheck).toEqual(["HG-4"]);
    const hg1 = plan.ledger.tasks.find((t) => t.id === "HG-1")!;
    expect(hg1.status).toBe("done");
    expect(hg1.updatedAt).toBe("2026-10-10");
    expect(String(hg1.notes)).toMatch(/auto-ticked/);
  });

  it("never ticks a gate whose deps are not done, even if its evidence exists", async () => {
    const l = ledger();
    l.tasks[0]!.status = "todo"; // W1 not done
    const plan = await planGateTicks(l, io(), "2026-10-10", CTX);
    expect(plan.ticked).toEqual([]);
  });

  it("every check in a list must pass", async () => {
    const l = ledger();
    l.tasks[1]!.done_when = [{ type: "prod-includes", pr: 100 }, { type: "pr-merged", pr: 300, repo: API_REPO }];
    const plan = await planGateTicks(l, io(), "2026-10-10", CTX);
    expect(plan.ticked).toEqual([]);
    expect(plan.waiting.find((w) => w.id === "HG-1")!.reasons.join(" ")).toMatch(/acme\/api#300/);
  });

  it("a gate using a check type this repo does not provide is reported as having no valid check", async () => {
    const l = ledger();
    l.tasks[1]!.done_when = { type: "built-after", pr: 100 } as never;
    const plan = await planGateTicks(l, io(), "2026-10-10", CTX);
    expect(plan.noCheck).toContain("HG-1");
    expect(plan.ticked).toEqual([]);
  });

  it("a repo-provided check is judged by the repo's command (io.extra), and a non-verdict fails closed", async () => {
    const withSql: GateContext = { ...CTX, extraTypes: ["sql-true"] };
    const l = ledger();
    l.tasks[1]!.done_when = { type: "sql-true", query: "SELECT true" } as never;
    const seen: unknown[] = [];
    const yes = io({ extra: async (c) => (seen.push(c), { pass: true, reason: "warehouse check returned true" }) });
    const plan = await planGateTicks(l, yes, "2026-10-10", withSql);
    expect(plan.ticked.map((t) => t.id)).toContain("HG-1");
    expect(seen).toEqual([{ type: "sql-true", query: "SELECT true" }]);
    expect(plan.ticked.find((t) => t.id === "HG-1")!.reasons).toEqual(["warehouse check returned true"]);

    const junk = io({ extra: async () => ({}) as never });
    const plan2 = await planGateTicks(ledger() && l, junk, "2026-10-10", withSql);
    expect(plan2.ticked.map((t) => t.id)).not.toContain("HG-1");
    const thrown = io({ extra: async () => { throw new Error("db down"); } });
    expect((await evaluateCheck({ type: "sql-true", query: "SELECT 1" }, thrown, withSql)).reason).toMatch(/db down/);
  });

  it("does not mutate the input ledger", async () => {
    const l = ledger();
    await planGateTicks(l, io(), "2026-10-10", CTX);
    expect(l.tasks[1]!.status).toBe("todo");
  });
});
