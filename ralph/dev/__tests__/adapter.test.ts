// The per-repo adapter (lib/adapter.ts): what every helper and the workflow
// read about a repo. A bad adapter must fail loudly at load, never at stage time.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ADAPTER_PATH, loadAdapter, parseAdapter } from "../../lib/adapter.ts";

const MIN = {
  repo: "acme/app",
  addendum: "docs/ralph/repo-policy.md",
  commands: { typecheck: "pnpm typecheck", testFiles: "pnpm vitest run", mergeGate: "pnpm run test" },
  merge: { note: "deploys to staging" },
};

describe("parseAdapter", () => {
  it("fills every default from a minimal adapter", () => {
    const a = parseAdapter(MIN);
    expect(a).toMatchObject({
      repo: "acme/app",
      knownFlakes: "docs/ralph/known-flakes.md",
      worktreeSetup: [],
      installProbe: "",
      prod: {},
      gateChecks: { types: [], command: "" },
      forbiddenCommands: [],
      minFreeGb: 25,
    });
    expect(a.merge).toMatchObject({
      note: "deploys to staging",
      guard: "",
      gateWrapper: "",
      busyExitCode: 0,
      waitForCi: false,
      vitestJson: true,
      migrations: { dir: "drizzle", pattern: "\\.sql$" },
      afterMigration: "continue",
      lockfile: "pnpm-lock.yaml",
    });
  });

  it("lists every problem at once", () => {
    let msg = "";
    try {
      parseAdapter({ repo: "app", commands: {}, merge: { afterMigration: "later" }, forbiddenCommands: ["("] });
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const bit of ['"repo" must be "owner/name"', '"addendum"', '"commands.typecheck"', '"commands.mergeGate"', '"merge.note"', '"merge.afterMigration"', "invalid regex"]) {
      expect(msg).toContain(bit);
    }
  });

  it("refuses a pnpm/npm `test` built-in as the merge gate: it eats the vitest reporter flags", () => {
    expect(() => parseAdapter({ ...MIN, commands: { ...MIN.commands, mergeGate: "pnpm test" } })).toThrow(/use "pnpm run test"/);
    expect(() => parseAdapter({ ...MIN, commands: { ...MIN.commands, mergeGate: "npm test" } })).toThrow(/use "npm run test"/);
    expect(() => parseAdapter({ ...MIN, commands: { ...MIN.commands, mergeGate: "pnpm test" }, merge: { ...MIN.merge, vitestJson: false } })).not.toThrow();
    for (const ok of ["pnpm run test", "pnpm test:release", "pnpm vitest run"]) {
      expect(() => parseAdapter({ ...MIN, commands: { ...MIN.commands, mergeGate: ok } })).not.toThrow();
    }
  });

  it("checks prod readers and repo-provided gate checks", () => {
    expect(() => parseAdapter({ ...MIN, prod: { "acme/app": { kind: "health-url", url: "api.example.com/health" } } })).toThrow(/prod\.acme\/app/);
    expect(() => parseAdapter({ ...MIN, prod: { app: { kind: "github-deployment", environment: "Production" } } })).toThrow(/"prod" key "app"/);
    expect(() => parseAdapter({ ...MIN, gateChecks: { types: ["sql-true"] } })).toThrow(/gateChecks\.command" is required/);
    const ok = parseAdapter({
      ...MIN,
      prod: { "acme/app": { kind: "github-deployment", environment: "Production" }, "acme/api": { kind: "health-url", url: "https://api.example.com/health" } },
      gateChecks: { types: ["sql-true"], command: "pnpm tsx scripts/gate.ts" },
    });
    expect(Object.keys(ok.prod)).toEqual(["acme/app", "acme/api"]);
  });
});

describe("loadAdapter", () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-adapter-"));
    execFileSync("git", ["init", "-q", dir]);
    return dir;
  };

  it("reads .claude/ralph.json from the git top level, even from a subdirectory", () => {
    const dir = repo();
    mkdirSync(join(dir, ".claude"));
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    writeFileSync(join(dir, ADAPTER_PATH), JSON.stringify(MIN));
    expect(loadAdapter(join(dir, "src", "deep")).repo).toBe("acme/app");
  });

  it("says plainly when the repo has no adapter, or it is not JSON", () => {
    const dir = repo();
    expect(() => loadAdapter(dir)).toThrow(/ralph\.json is missing: this repo has no Ralph adapter/);
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ADAPTER_PATH), "{ nope");
    expect(() => loadAdapter(dir)).toThrow(/not valid JSON/);
  });
});
