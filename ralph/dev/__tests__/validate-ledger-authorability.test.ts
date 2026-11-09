import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateLedgerAuthorability,
  runCli,
  type AuthorabilityLedgerLike,
} from "../../lib/validate-ledger-authorability.ts";

// Task factory covering the fields the authorability validator reads.
function task(
  over: Partial<{
    id: string;
    title: string;
    pointer: string;
    human_gate: boolean;
    verify: unknown;
    kind: unknown;
    status: string;
    done_when: unknown;
  }> = {},
) {
  return {
    id: over.id ?? "T1",
    title: over.title ?? "do a thing",
    pointer: over.pointer ?? "docs/x.md ### T1 — do a thing",
    human_gate: over.human_gate ?? false,
    status: over.status ?? "todo",
    kind: "kind" in over ? over.kind : "code",
    verify:
      "verify" in over ? over.verify : "pnpm test src/x.test.ts",
    // A gate carries a valid check by default; tests that need otherwise say so.
    done_when: "done_when" in over ? over.done_when : over.human_gate ? { type: "issue-closed", issue: 1 } : undefined,
  };
}

function ledger(
  tasks: unknown[],
  verifyCmds: unknown = ["npx tsc --noEmit", "pnpm test"],
): AuthorabilityLedgerLike {
  return { feature: { verifyCmds }, tasks };
}

describe("validateLedgerAuthorability", () => {
  it("accepts tasks with a concrete verify command", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", verify: "pnpm test src/a.test.ts" })]),
    );
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('accepts verify:"gate" when the feature has a real gate', () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", verify: "gate" })]),
    );
    expect(res.ok).toBe(true);
  });

  it('accepts verify:"manual"', () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", kind: "measure", verify: "manual" })]),
    );
    expect(res.ok).toBe(true);
  });

  it("allows a human-gated task to have verify:null (never auto-run)", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T3", human_gate: true, verify: null })]),
    );
    expect(res.ok).toBe(true);
  });

  it("HARD-BLOCKS a non-gated task with verify:null (the core insufficient-spec case)", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", human_gate: false, verify: null })]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('task "T1"') && e.includes("no \"verify\""))).toBe(true);
  });

  it("HARD-BLOCKS a non-gated task with verify undefined (field omitted)", () => {
    const t = task({ id: "T1" });
    delete (t as { verify?: unknown }).verify;
    const res = validateLedgerAuthorability(ledger([t]));
    expect(res.ok).toBe(false);
  });

  it('HARD-BLOCKS verify:"gate" when the feature gate is trivial (["true"])', () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", verify: "gate" })], ["true"]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('verify:"gate"') && e.includes("no real verifyCmds"))).toBe(true);
  });

  it('HARD-BLOCKS verify:"gate" when the feature has no verifyCmds at all', () => {
    const res = validateLedgerAuthorability({
      feature: {},
      tasks: [task({ id: "T1", verify: "gate" })],
    });
    expect(res.ok).toBe(false);
  });

  it("HARD-BLOCKS an empty verify string", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", verify: "   " })]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("empty \"verify\""))).toBe(true);
  });

  it("HARD-BLOCKS a non-string verify", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", verify: 123 })]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("non-string \"verify\""))).toBe(true);
  });

  it("HARD-BLOCKS a task with a missing title", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", title: "" })]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("empty \"title\""))).toBe(true);
  });

  it("HARD-BLOCKS a task with a missing pointer", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", pointer: "" })]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("empty \"pointer\""))).toBe(true);
  });

  it("HARD-BLOCKS an unambiguous deploy command in a non-gated task (db:migrate)", () => {
    const res = validateLedgerAuthorability(
      ledger([
        task({
          id: "T1",
          title: "run db:migrate against the production Neon DB",
          verify: "gate",
        }),
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("apply/deploy step"))).toBe(true);
  });

  it("does NOT hard-block an apply/deploy command when the task IS human-gated", () => {
    const res = validateLedgerAuthorability(
      ledger([
        task({
          id: "T3",
          title: "run vercel --prod to deploy",
          human_gate: true,
          verify: null,
        }),
      ]),
    );
    expect(res.ok).toBe(true);
  });

  // A repo's own deploy / data commands come from its adapter (forbiddenCommands).
  const REPO_FORBIDDEN = [/\bdb:push\b/i, /\bdrizzle-kit\s+push\b/i, /\bvercel\s+(deploy\b|--prod\b)/i, /\bcredit:grant\b/i];
  it.each(["pnpm db:push the new column", "drizzle-kit push to Neon", "vercel --prod after the merge", "vercel deploy a preview", "pnpm credit:grant 50 to the test user"])(
    "HARD-BLOCKS a repo's forbidden commands (adapter) in a non-gated task: %s",
    (title) => {
      expect(validateLedgerAuthorability(ledger([task({ id: "T1", title, verify: "gate" })])).ok).toBe(true);
      const res = validateLedgerAuthorability(ledger([task({ id: "T1", title, verify: "gate" })]), { forbidden: REPO_FORBIDDEN });
      expect(res.ok).toBe(false);
      expect(res.errors.some((e) => e.includes("apply/deploy step"))).toBe(true);
    },
  );

  it("does NOT flag 'write a migration file' (writing is allowed; only applying is gated)", () => {
    const res = validateLedgerAuthorability(
      ledger([
        task({
          id: "T1",
          title: "write a Drizzle migration file for the new column",
          verify: "gate",
        }),
      ]),
    );
    // 'migration' alone (no apply/db:migrate) is not a hard block.
    expect(res.ok).toBe(true);
  });

  // ---- warnings (advisory, never affect ok) ----

  it("WARNS (does not block) on soft prod wording in a non-gated task", () => {
    const res = validateLedgerAuthorability(
      ledger([
        task({
          id: "T1",
          title: "update the production config docs",
          verify: "gate",
        }),
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.includes('task "T1"'))).toBe(true);
  });

  it("WARNS (does not block) on a mega-task with a large line span", () => {
    const res = validateLedgerAuthorability(
      ledger([
        task({
          id: "T1",
          pointer: "docs/x.md §9 W4 — lines 100,400",
          verify: "gate",
        }),
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.includes("spans"))).toBe(true);
  });

  it("does NOT warn on a small line span", () => {
    const res = validateLedgerAuthorability(
      ledger([
        task({
          id: "T1",
          pointer: "docs/x.md §9 W4 — lines 100,140",
          verify: "gate",
        }),
      ]),
    );
    expect(res.warnings.some((w) => w.includes("spans"))).toBe(false);
  });

  it("collects errors across multiple tasks (no early bail)", () => {
    const res = validateLedgerAuthorability(
      ledger([
        task({ id: "T1", verify: null }),
        task({ id: "T2", title: "" }),
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('task "T1"'))).toBe(true);
    expect(res.errors.some((e) => e.includes('task "T2"'))).toBe(true);
  });

  it("errors when there is no tasks array", () => {
    const res = validateLedgerAuthorability({} as AuthorabilityLedgerLike);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('ledger has no "tasks" array');
  });
});

// `kind` routes a task through the PR pipeline: only `code` gets a red stage,
// `decision` is always a human's, and each kind has a verify it can honestly use.
describe("validateLedgerAuthorability — kind", () => {
  it("HARD-BLOCKS a runnable task with no kind", () => {
    const res = validateLedgerAuthorability(ledger([task({ id: "T1", kind: undefined })]));
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/"kind"/);
  });

  it("HARD-BLOCKS an unknown kind", () => {
    const res = validateLedgerAuthorability(ledger([task({ id: "T1", kind: "chore" })]));
    expect(res.ok).toBe(false);
  });

  it("does not require kind on a done task (old ledgers stay valid)", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", kind: undefined, status: "done" })]),
    );
    expect(res.ok).toBe(true);
  });

  it("does not require kind on a human-gated task", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", kind: undefined, human_gate: true, verify: null })]),
    );
    expect(res.ok).toBe(true);
  });

  it("HARD-BLOCKS a decision task that is not human_gate", () => {
    const res = validateLedgerAuthorability(ledger([task({ id: "T1", kind: "decision" })]));
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/decision/);
  });

  it('HARD-BLOCKS a code task with verify:"manual" (code is proven by its red tests)', () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", kind: "code", verify: "manual" })]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/split/);
  });

  it('HARD-BLOCKS a docs task with verify:"gate" (tsc + tests prove nothing about a doc)', () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", kind: "docs", verify: "gate" })]),
    );
    expect(res.ok).toBe(false);
  });

  it('HARD-BLOCKS a measure task with verify:"gate"', () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", kind: "measure", verify: "gate" })]),
    );
    expect(res.ok).toBe(false);
  });

  it("accepts a docs task with an artifact check, and a measure task with manual", () => {
    const res = validateLedgerAuthorability(
      ledger([
        task({ id: "T1", kind: "docs", verify: 'grep -q "## G1" docs/x.md' }),
        task({ id: "T2", kind: "measure", verify: "manual" }),
      ]),
    );
    expect(res.ok).toBe(true);
  });
});

// Every open gate must say what "done" looks like, so tick-gates can tick it from
// evidence and nobody has to tick the ledger by hand.
describe("validateLedgerAuthorability — done_when on gates", () => {
  it("HARD-BLOCKS an open human gate with no done_when", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "HG-1", human_gate: true, verify: null, done_when: undefined })]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/HG-1.*done_when/);
  });

  it("HARD-BLOCKS an open gate whose done_when is not one of the fixed, anchored checks", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "HG-1", human_gate: true, verify: null, done_when: { type: "built-after" } })]),
    );
    expect(res.ok).toBe(false);
  });

  it("HARD-BLOCKS an open gate using a check type this repo does not provide, even fully anchored", () => {
    for (const done_when of [
      { type: "built-after", pr: 5 },
      { type: "migration-applied", migration: "0179" },
      { type: "loaded-after", source: "pdl", pr: 5 },
      { type: "sql-true", query: "SELECT true" },
    ]) {
      const res = validateLedgerAuthorability(ledger([task({ id: "HG-1", human_gate: true, verify: null, done_when })]));
      expect(res.ok, done_when.type).toBe(false);
      expect(res.errors.join("\n")).toMatch(/unknown type/);
    }
  });

  it("a repo-provided check type is valid where the adapter declares it, and the repo's validator judges its shape", () => {
    const ctx = { self: "acme/api", prodRepos: [], extraTypes: ["sql-true"] };
    const seen: unknown[] = [];
    const validateExtra = (c: Record<string, unknown>) => (seen.push(c), typeof c.query === "string" ? [] : ['(sql-true) needs "query"']);
    const good = task({ id: "HG-1", human_gate: true, verify: null, done_when: { type: "sql-true", query: "SELECT true" } });
    expect(validateLedgerAuthorability(ledger([good]), { ctx, validateExtra }).ok).toBe(true);
    expect(seen).toEqual([{ type: "sql-true", query: "SELECT true" }]);
    const bad = task({ id: "HG-1", human_gate: true, verify: null, done_when: { type: "sql-true" } });
    const res = validateLedgerAuthorability(ledger([bad]), { ctx, validateExtra });
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/needs "query"/);
  });

  it("accepts a gate that waits on another repo (repo field)", () => {
    const ctx = { self: "acme/app", prodRepos: ["acme/app", "acme/api"], extraTypes: [] };
    const res = validateLedgerAuthorability(
      ledger([
        task({
          id: "HG-1",
          human_gate: true,
          verify: null,
          done_when: [
            { type: "prod-includes", pr: 1601, repo: "acme/api" },
            { type: "issue-closed", issue: 1600, repo: "acme/api" },
          ],
        }),
      ]),
      { ctx },
    );
    expect(res.ok).toBe(true);
  });

  it("HARD-BLOCKS a gate with a malformed repo", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "HG-1", human_gate: true, verify: null, done_when: { type: "pr-merged", pr: 1, repo: "api" } })]),
    );
    expect(res.ok).toBe(false);
  });

  it("does not require done_when on a gate that is already done (old ledgers stay valid)", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "HG-1", human_gate: true, verify: null, status: "done", done_when: undefined })]),
    );
    expect(res.ok).toBe(true);
  });

  it("HARD-BLOCKS done_when on a task that is not a gate (the pipeline proves those itself)", () => {
    const res = validateLedgerAuthorability(
      ledger([task({ id: "T1", verify: "gate", done_when: { type: "pr-merged", pr: 1 } })]),
    );
    expect(res.ok).toBe(false);
  });
});

describe("runCli (exit codes + file IO)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function writeLedger(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "ralph-auth-"));
    const p = join(dir, "ledger.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it("exits 1 when no path arg is given", () => {
    expect(runCli(["node", "script"], () => ({}))).toBe(1);
  });

  it("exits 1 when the file does not exist", () => {
    expect(
      runCli(["node", "script", join(tmpdir(), "ralph-no-such-auth-xyz.json")], () => ({})),
    ).toBe(1);
  });

  it("exits 1 on non-JSON contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-auth-"));
    const p = join(dir, "bad.json");
    writeFileSync(p, "not json {");
    expect(runCli(["node", "script", p], () => ({}))).toBe(1);
  });

  it("exits 0 on an authorable ledger", () => {
    const p = writeLedger(
      ledger([task({ id: "T1", verify: "gate" })]),
    );
    expect(runCli(["node", "script", p], () => ({}))).toBe(0);
  });

  it("exits 0 with warnings only (advisory does not fail the CLI)", () => {
    const p = writeLedger(
      ledger([
        task({
          id: "T1",
          pointer: "docs/x.md §9 — lines 10,300",
          verify: "gate",
        }),
      ]),
    );
    expect(runCli(["node", "script", p], () => ({}))).toBe(0);
  });

  it("exits 1 on a non-gated task with no verify", () => {
    const p = writeLedger(ledger([task({ id: "T1", verify: null })]));
    expect(runCli(["node", "script", p], () => ({}))).toBe(1);
  });
});

// 2026-10-12 lesson 8: gates pointed at doc-contains in a log nobody wrote.
describe("validateLedgerAuthorability — evidence nobody creates", () => {
  const LOG = "docs/x-log.md";
  const gate = (file = LOG) =>
    task({ id: "HG-1", human_gate: true, kind: "decision", verify: null, done_when: { type: "doc-contains", file, text: "Decision:" } });

  it("warns when a gate's doc-contains file is not on main and no task writes it", () => {
    const r = validateLedgerAuthorability(ledger([task({ id: "A" }), gate()]), { fileExistsOnMain: () => false });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes(LOG) && w.includes("nobody will create"))).toBe(true);
  });

  it("does not warn when the file is on main", () => {
    const r = validateLedgerAuthorability(ledger([gate()]), { fileExistsOnMain: (p) => p === LOG });
    expect(r.warnings.filter((w) => w.includes(LOG))).toEqual([]);
  });

  it("does not warn when a task names the file (it will create it)", () => {
    const writer = task({ id: "W", kind: "docs", verify: `test -f ${LOG}` });
    const r = validateLedgerAuthorability(ledger([writer, gate()]), { fileExistsOnMain: () => false });
    expect(r.warnings.filter((w) => w.includes(LOG))).toEqual([]);
  });

  it("checks every doc-contains in a list, and skips the check when no lookup is given", () => {
    const g = task({
      id: "HG-2",
      human_gate: true,
      verify: null,
      done_when: [{ type: "pr-merged", pr: 1 }, { type: "doc-contains", file: LOG, text: "x" }],
    });
    expect(validateLedgerAuthorability(ledger([g]), { fileExistsOnMain: () => false }).warnings.some((w) => w.includes(LOG))).toBe(true);
    expect(validateLedgerAuthorability(ledger([g])).warnings.some((w) => w.includes(LOG))).toBe(false);
  });
});

// 2026-10-12 lesson 3: an independent blind check is a measure-task stage.
describe("validateLedgerAuthorability — blind_check", () => {
  it("accepts blind_check:true on a measure task", () => {
    const t = { ...task({ kind: "measure", verify: "manual" }), blind_check: true };
    expect(validateLedgerAuthorability(ledger([t])).errors).toEqual([]);
  });

  it.each(["code", "docs"])("refuses blind_check:true on a %s task", (kind) => {
    const t = { ...task({ kind, verify: kind === "code" ? "gate" : "manual" }), blind_check: true };
    const r = validateLedgerAuthorability(ledger([t]));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/blind_check/);
  });

  it("refuses a non-boolean blind_check", () => {
    const t = { ...task({ kind: "measure", verify: "manual" }), blind_check: "yes" };
    expect(validateLedgerAuthorability(ledger([t])).ok).toBe(false);
  });
});
