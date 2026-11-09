import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAdapter } from "../../lib/adapter.ts";
import { contextFrom, evaluateCheck, type GateIO } from "../../lib/gate-checks.ts";
import { realGateIO, runTickGates, type Exec, type Fetch } from "../../lib/tick-gates.ts";

const LEDGER_PATH = "docs/ralph/f-LEDGER.json";
const LEDGER = {
  feature: { slug: "f", title: "F" },
  tasks: [
    { id: "HG-1", title: "ship", status: "todo", human_gate: true, done_when: { type: "issue-closed", issue: 1 } },
    { id: "HG-2", title: "later", status: "todo", human_gate: true, done_when: { type: "issue-closed", issue: 2 } },
  ],
};

const io = (closed: number[]): GateIO => ({
  pr: async () => null,
  prodCommit: async () => null,
  isAncestor: async () => false,
  issueState: async (n) => (closed.includes(n) ? "CLOSED" : "OPEN"),
  docOnMain: async () => null,
  extra: async () => ({ pass: false, reason: "none" }),
});

/** Records every command; plays git/gh well enough for the apply path. */
function fakeExec() {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "show") return JSON.stringify(LEDGER);
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
      // emulate the checkout: the ledger's directory must exist in the temp worktree
      const dir = args[3]!;
      mkdirSync(join(dir, "docs/ralph"), { recursive: true });
    }
    if (cmd === "gh" && args[1] === "create") return "https://github.com/o/r/pull/42\n";
    return "";
  };
  return { exec, calls };
}

const scratch = () => mkdtempSync(join(tmpdir(), "ralph-tick-"));

describe("runTickGates", () => {
  it("dry run reports the plan and changes nothing", async () => {
    const { exec, calls } = fakeExec();
    const r = await runTickGates(LEDGER_PATH, false, { exec, io: io([1]), today: "2026-10-10", scratch: scratch() });
    expect(r.ticked.map((t) => t.id)).toEqual(["HG-1"]);
    expect(r.waiting.map((t) => t.id)).toEqual(["HG-2"]);
    expect(r.prUrl).toBe("");
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
  });

  it("apply lands the tick through a squash-merged PR from a throwaway worktree, never main", async () => {
    const { exec, calls } = fakeExec();
    const r = await runTickGates(LEDGER_PATH, true, { exec, io: io([1]), today: "2026-10-10", scratch: scratch() });
    expect(r.prUrl).toBe("https://github.com/o/r/pull/42");

    const add = calls.find((c) => c[1] === "worktree" && c[2] === "add")!;
    const dir = add[4]!;
    expect(add).toEqual(["git", "worktree", "add", "--detach", dir, "origin/main"]);

    const written = JSON.parse(readFileSync(join(dir, LEDGER_PATH), "utf8"));
    expect(written.tasks[0].status).toBe("done");
    expect(written.tasks[1].status).toBe("todo");
    expect(readFileSync(join(dir, "docs/ralph/f-LEDGER.md"), "utf8")).toMatch(/\[x\] \*\*HG-1\*\*/);

    const push = calls.find((c) => c[0] === "git" && c.includes("push"))!;
    expect(push.at(-1)).toMatch(/^HEAD:refs\/heads\/ralph-gates\/f-\d+$/);
    expect(calls.some((c) => c.some((a) => a.endsWith("refs/heads/main")))).toBe(false);
    expect(calls).toContainEqual(["gh", "pr", "merge", "https://github.com/o/r/pull/42", "--squash", "--delete-branch"]);
    expect(calls.at(-1)).toEqual(["git", "worktree", "remove", "--force", dir]);
  });

  it("apply with nothing to tick opens no PR", async () => {
    const { exec, calls } = fakeExec();
    const r = await runTickGates(LEDGER_PATH, true, { exec, io: io([]), today: "2026-10-10", scratch: scratch() });
    expect(r.ticked).toEqual([]);
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
    expect(calls.some((c) => c[1] === "worktree")).toBe(false);
  });
});

describe("realGateIO — the evidence readers, with gh/git/fetch faked", () => {
  const APP = "acme/app";
  const API = "acme/api";
  // This repo's prod is a GitHub Deployment environment (Vercel); the other repo's is a /health URL.
  const ADAPTER = parseAdapter({
    repo: APP,
    addendum: "docs/ralph/repo-policy.md",
    commands: { typecheck: "tc", testFiles: "t", mergeGate: "g" },
    merge: { note: "deploys" },
    prod: {
      [APP]: { kind: "github-deployment", environment: "Production" },
      [API]: { kind: "health-url", url: "https://api.example.com/health" },
    },
  });

  function world(over: Record<string, string | Error> = {}) {
    const calls: string[] = [];
    const exec: Exec = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      for (const [k, v] of Object.entries(over)) {
        if (key.startsWith(k)) {
          if (v instanceof Error) throw v;
          return v;
        }
      }
      throw new Error(`unexpected: ${key}`);
    };
    return { exec, calls };
  }
  const noFetch: Fetch = async () => {
    throw new Error("fetch not expected");
  };

  it("pr: this repo passes no --repo; another repo passes --repo", async () => {
    const pr = JSON.stringify({ state: "MERGED", mergedAt: "2026-10-01T00:00:00Z", mergeCommit: { oid: "abc" } });
    const { exec, calls } = world({ "gh pr view": pr });
    const g = realGateIO(exec, ADAPTER, noFetch);
    expect(await g.pr(5, APP)).toEqual({ state: "MERGED", mergedAt: "2026-10-01T00:00:00Z", mergeCommit: "abc" });
    await g.pr(6, API);
    expect(calls).toEqual([
      "gh pr view 5 --json state,mergedAt,mergeCommit",
      `gh pr view 6 --repo ${API} --json state,mergedAt,mergeCommit`,
    ]);
  });

  it("issueState honours --repo the same way", async () => {
    const { exec, calls } = world({ "gh issue view": JSON.stringify({ state: "CLOSED" }) });
    expect(await realGateIO(exec, ADAPTER, noFetch).issueState(9, API)).toBe("CLOSED");
    expect(calls).toEqual([`gh issue view 9 --repo ${API} --json state`]);
  });

  it("prodCommit for the API reads /health's commit", async () => {
    const seen: string[] = [];
    const f: Fetch = async (url) => (seen.push(url), { ok: true, json: async () => ({ status: "ok", commit: "api-sha" }) });
    const { exec, calls } = world();
    expect(await realGateIO(exec, ADAPTER, f).prodCommit(API)).toBe("api-sha");
    expect(seen).toEqual(["https://api.example.com/health"]);
    expect(calls).toEqual([]);
  });

  it("prodCommit for the API is null when /health is down or has no commit", async () => {
    const { exec } = world();
    expect(await realGateIO(exec, ADAPTER, async () => ({ ok: false, json: async () => ({}) })).prodCommit(API)).toBeNull();
    expect(await realGateIO(exec, ADAPTER, async () => ({ ok: true, json: async () => ({ commit: "" }) })).prodCommit(API)).toBeNull();
  });

  it("prodCommit for this repo is the newest Vercel Production deployment whose status is success", async () => {
    const { exec, calls } = world({
      [`gh api repos/${APP}/deployments?environment=Production`]: JSON.stringify([
        { id: 3, sha: "failed-sha" },
        { id: 2, sha: "good-sha" },
        { id: 1, sha: "older-sha" },
      ]),
      [`gh api repos/${APP}/deployments/3/statuses`]: JSON.stringify([{ state: "failure" }]),
      [`gh api repos/${APP}/deployments/2/statuses`]: JSON.stringify([{ state: "success" }]),
    });
    expect(await realGateIO(exec, ADAPTER, noFetch).prodCommit(APP)).toBe("good-sha");
    expect(calls.some((c) => c.includes("deployments/1/"))).toBe(false);
  });

  it("prodCommit for this repo is null when no deployment succeeded", async () => {
    const { exec } = world({
      [`gh api repos/${APP}/deployments?environment=Production`]: JSON.stringify([{ id: 3, sha: "x" }]),
      [`gh api repos/${APP}/deployments/3/statuses`]: JSON.stringify([{ state: "in_progress" }]),
    });
    expect(await realGateIO(exec, ADAPTER, noFetch).prodCommit(APP)).toBeNull();
  });

  it("prodCommit refuses a repo with no known prod (fails closed upstream)", async () => {
    const { exec } = world();
    await expect(realGateIO(exec, ADAPTER, noFetch).prodCommit("acme/ds")).rejects.toThrow(/no known prod/);
  });

  it("isAncestor in another repo uses the compare API: ahead/identical = included", async () => {
    for (const [status, want] of [
      ["ahead", true],
      ["identical", true],
      ["behind", false],
      ["diverged", false],
    ] as const) {
      const { exec, calls } = world({ [`gh api repos/${API}/compare/bbb...prod`]: `${status}\n` });
      expect(await realGateIO(exec, ADAPTER, noFetch).isAncestor("bbb", "prod", API)).toBe(want);
      expect(calls).toEqual([`gh api repos/${API}/compare/bbb...prod --jq .status`]);
    }
  });

  it("isAncestor in this repo uses local git; exit 1 = not an ancestor, anything else throws", async () => {
    const yes = world({ "git merge-base --is-ancestor": "" });
    expect(await realGateIO(yes.exec, ADAPTER, noFetch).isAncestor("a", "b", APP)).toBe(true);
    const no = world({ "git merge-base": Object.assign(new Error("exit 1"), { status: 1 }) });
    expect(await realGateIO(no.exec, ADAPTER, noFetch).isAncestor("a", "b", APP)).toBe(false);
    const bad = world({ "git merge-base": Object.assign(new Error("bad object"), { status: 128 }) });
    await expect(realGateIO(bad.exec, ADAPTER, noFetch).isAncestor("a", "b", APP)).rejects.toThrow(/bad object/);
  });

  it("end to end: a cross-repo prod-includes gate ticks through the real readers", async () => {
    const pr = JSON.stringify({ state: "MERGED", mergedAt: "2026-10-01T00:00:00Z", mergeCommit: { oid: "bbb" } });
    const { exec } = world({
      [`gh pr view 12 --repo ${API}`]: pr,
      [`gh api repos/${API}/compare/bbb...api-sha`]: "ahead",
    });
    const f: Fetch = async () => ({ ok: true, json: async () => ({ commit: "api-sha" }) });
    const r = await evaluateCheck({ type: "prod-includes", pr: 12, repo: API }, realGateIO(exec, ADAPTER, f), contextFrom(ADAPTER));
    expect(r).toEqual({ pass: true, reason: `${API} prod api-sha includes PR ${API}#12` });
  });

  it("extra: a repo-provided check goes to the adapter's command with the check on stdin", async () => {
    const withExtra = parseAdapter({
      ...ADAPTER,
      gateChecks: { types: ["sql-true"], command: "pnpm tsx scripts/gate.ts" },
    });
    const runs: [string, string, string][] = [];
    const run = (command: string, mode: "check" | "validate", input: string) => (
      runs.push([command, mode, input]), { code: 0, stdout: 'log line\n{"pass":true,"reason":"warehouse says yes"}\n', stderr: "" }
    );
    const { exec } = world();
    const r = await realGateIO(exec, withExtra, noFetch, run).extra({ type: "sql-true", query: "SELECT true" });
    expect(r).toEqual({ pass: true, reason: "warehouse says yes" });
    expect(runs).toEqual([["pnpm tsx scripts/gate.ts", "check", '{"type":"sql-true","query":"SELECT true"}']]);
  });
});
