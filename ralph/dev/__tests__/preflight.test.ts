import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diskVerdict,
  explainHelperFailure,
  installVerdict,
  runPreflight,
  DEFAULT_MIN_FREE_GB,
  type PreflightDeps,
} from "../../lib/preflight.ts";
import { parseAdapter } from "../../lib/adapter.ts";

const GB = 1024 ** 3;

// The exact output pnpm gave on 2026-10-12 (pnpm prints its own errors on STDOUT).
const NO_TTY = {
  status: 1,
  stdout:
    " ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY  Aborted removal of modules directory due to no TTY\n\nIf you are running pnpm in CI, set the CI environment variable to \"true\".\n",
  stderr: "",
};

describe("diskVerdict (lesson 1)", () => {
  it("passes at or above the floor", () => {
    expect(diskVerdict(30 * GB, 25, "/repo")).toEqual({ ok: true, error: "" });
  });
  it("stops below it with a plain message that says how to free space", () => {
    const v = diskVerdict(12.3 * GB, 25, "/repo");
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/12\.3 GB free/);
    expect(v.error).toMatch(/at least 25 GB/);
    expect(v.error).toMatch(/worktree/);
    expect(v.error).toMatch(/re-run \/ralph/);
  });
});

describe("install check (lesson 2)", () => {
  it("names the NO_TTY purge and tells Matt to run pnpm install, keeping the raw output", () => {
    const v = installVerdict(true, NO_TTY, "/repo");
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/package install is broken/);
    expect(v.error).toMatch(/Run `pnpm install` yourself in \/repo/);
    expect(v.error).toContain("ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY");
  });

  it("missing node_modules is its own plain message", () => {
    expect(installVerdict(false, null, "/repo").error).toMatch(/node_modules is missing in \/repo/);
  });

  it("an unknown failure still passes the command's real stdout AND stderr through", () => {
    const msg = explainHelperFailure("pnpm tsx x.ts", { status: 3, stdout: "partial out", stderr: "boom: weird" }, "/repo");
    expect(msg).toMatch(/exit 3/);
    expect(msg).toContain("partial out");
    expect(msg).toContain("boom: weird");
  });

  it("an empty failure says it printed nothing instead of looking like success", () => {
    expect(explainHelperFailure("pnpm tsx x.ts", { status: 1, stdout: "", stderr: "" }, "/repo")).toMatch(/printed nothing/);
  });

  it("passes when the probe succeeds", () => {
    expect(installVerdict(true, { status: 0, stdout: "tsx v4", stderr: "" }, "/repo")).toEqual({ ok: true, error: "" });
  });
});

const ADAPTER = parseAdapter({
  repo: "acme/app",
  addendum: "docs/ralph/repo-policy.md",
  installProbe: "pnpm exec vitest --version",
  commands: { typecheck: "pnpm typecheck", testFiles: "pnpm vitest run", mergeGate: "pnpm test" },
  merge: { note: "deploys to staging" },
});

function deps(over: PreflightDeps = {}): PreflightDeps {
  return {
    cwd: "/repo",
    adapter: () => ADAPTER,
    env: {},
    freeBytes: () => 100 * GB,
    nodeModulesExists: () => true,
    probeInstall: () => ({ status: 0, stdout: "tsx v4", stderr: "" }),
    sweep: () => [],
    ...over,
  };
}

describe("runPreflight", () => {
  it("is ok on a healthy box", () => {
    expect(runPreflight(deps())).toMatchObject({ ok: true, error: "" });
  });

  it("sweeps stale stage worktrees BEFORE measuring disk, so freed space counts", () => {
    const order: string[] = [];
    const r = runPreflight(
      deps({
        sweep: () => {
          order.push("sweep");
          return [{ path: "/repo/.claude/worktrees/wf_a-1", removed: true, reason: "clean, pushed, stale" }];
        },
        freeBytes: () => {
          order.push("disk");
          return 100 * GB;
        },
      }),
    );
    expect(order).toEqual(["sweep", "disk"]);
    expect(r.sweep).toEqual({ removed: 1, kept: 0 });
    expect(r.warnings).toMatch(/removed 1 stale stage worktree/);
  });

  it("stops on low disk before probing the install", () => {
    let probed = false;
    const r = runPreflight(deps({ freeBytes: () => 5 * GB, probeInstall: () => ((probed = true), { status: 0, stdout: "", stderr: "" }) }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Not enough free disk/);
    expect(probed).toBe(false);
  });

  it("honours RALPH_MIN_FREE_GB and defaults to the documented floor", () => {
    expect(runPreflight(deps({ freeBytes: () => 30 * GB, env: { RALPH_MIN_FREE_GB: "50" } })).ok).toBe(false);
    expect(runPreflight(deps({ freeBytes: () => (DEFAULT_MIN_FREE_GB + 1) * GB })).ok).toBe(true);
  });

  it("stops on a broken install with the translated message", () => {
    const r = runPreflight(deps({ probeInstall: () => NO_TTY }));
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/pnpm install/);
  });

  it("warns (does not fail) when the sweep keeps a worktree that may hold work", () => {
    const r = runPreflight(deps({ sweep: () => [{ path: "/repo/.claude/worktrees/wf_b-2", removed: false, reason: "has uncommitted or untracked changes" }] }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toMatch(/may hold work/);
  });
});

describe("runPreflight — the adapter", () => {
  it("stops with the adapter's own error when it is missing or invalid, before anything else runs", () => {
    let swept = false;
    const r = runPreflight(
      deps({
        adapter: () => {
          throw new Error("/repo/.claude/ralph.json is missing: this repo has no Ralph adapter.");
        },
        sweep: () => ((swept = true), []),
      }),
    );
    expect(r).toMatchObject({ ok: false, adapter: null });
    expect(r.error).toMatch(/ralph\.json is missing/);
    expect(swept).toBe(false);
  });

  it("prints the validated adapter, so the workflow builds its prompts from it", () => {
    expect(runPreflight(deps()).adapter).toEqual(ADAPTER);
  });

  it("runs the adapter's install probe, and skips the install check when it sets none", () => {
    const probed: string[] = [];
    runPreflight(deps({ probeInstall: (_c, cmd) => (probed.push(cmd), { status: 0, stdout: "", stderr: "" }) }));
    expect(probed).toEqual(["pnpm exec vitest --version"]);
    const none = parseAdapter({ ...ADAPTER, installProbe: "" });
    const r = runPreflight(deps({ adapter: () => none, nodeModulesExists: () => false }));
    expect(r.ok).toBe(true);
  });

  it("uses the adapter's disk floor; RALPH_MIN_FREE_GB still overrides it", () => {
    const small = parseAdapter({ ...ADAPTER, minFreeGb: 5 });
    expect(runPreflight(deps({ adapter: () => small, freeBytes: () => 10 * GB })).ok).toBe(true);
    expect(runPreflight(deps({ adapter: () => small, freeBytes: () => 10 * GB, env: { RALPH_MIN_FREE_GB: "20" } })).ok).toBe(false);
  });
});

describe("every Ralph helper runs without node_modules", () => {
  // Every helper runs as `node <ralph>/lib/<x>.ts` from the plugin, with no
  // install anywhere: each module may only use node: builtins and relative .ts siblings.
  const LIB = fileURLToPath(new URL("../../lib", import.meta.url));
  it.each(readdirSync(LIB).filter((f) => f.endsWith(".ts")))(
    "%s imports only node: builtins and relative .ts files",
    (f) => {
      const src = readFileSync(join(LIB, f), "utf8");
      const specs = [...src.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]!);
      for (const s of specs) expect(s.startsWith("node:") || /^\.\.?\/[\w/-]+\.ts$/.test(s)).toBe(true);
    },
  );
});
