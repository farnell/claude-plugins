import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateLedgerDeps,
  runCli,
  type LedgerLike,
} from "../../lib/validate-ledger-deps.ts";

// Minimal task factory — the validator only reads `id` + `deps`.
function task(id: string, deps: string[] = [], status = "todo") {
  return { id, deps, status };
}

describe("validateLedgerDeps", () => {
  it("accepts a valid linear chain (T1 <- T2 <- T3)", () => {
    const ledger: LedgerLike = {
      tasks: [task("T1", []), task("T2", ["T1"]), task("T3", ["T2"])],
    };
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("accepts deps that point at already-done tasks (status is irrelevant to graph validity)", () => {
    const ledger: LedgerLike = {
      tasks: [
        task("T1", [], "done"),
        task("T2", [], "done"),
        task("T3", ["T1", "T2"], "todo"),
      ],
    };
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("flags a dep pointing at a non-existent id, naming the bad ref", () => {
    const ledger: LedgerLike = {
      tasks: [task("T1", []), task("T2", ["TYPO"])],
    };
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('task "T2" depends on unknown task id "TYPO"');
  });

  it("flags a duplicate task id", () => {
    const ledger: LedgerLike = {
      tasks: [task("T1", []), task("T1", [])],
    };
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('duplicate task id "T1"'))).toBe(
      true,
    );
  });

  it("flags a self-dependency", () => {
    const ledger: LedgerLike = {
      tasks: [task("T1", ["T1"])],
    };
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('task "T1" depends on itself');
    // A self-dep is reported as a self-dep, not duplicated as a generic cycle.
    expect(res.errors.some((e) => e.startsWith("dependency cycle"))).toBe(false);
  });

  it("detects a 2-node cycle A -> B -> A and reports the path", () => {
    const ledger: LedgerLike = {
      tasks: [task("A", ["B"]), task("B", ["A"])],
    };
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(false);
    const cycleErrs = res.errors.filter((e) => e.startsWith("dependency cycle"));
    expect(cycleErrs).toHaveLength(1);
    // Same cycle, reached from either root, is reported exactly once and names
    // every node in the loop.
    expect(cycleErrs[0]).toContain("A");
    expect(cycleErrs[0]).toContain("B");
    expect(cycleErrs[0]).toMatch(/->.*->/); // closed path has two arrows
  });

  it("detects a 3-node cycle A -> B -> C -> A", () => {
    const ledger: LedgerLike = {
      tasks: [task("A", ["B"]), task("B", ["C"]), task("C", ["A"])],
    };
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(false);
    const cycleErrs = res.errors.filter((e) => e.startsWith("dependency cycle"));
    expect(cycleErrs).toHaveLength(1);
    for (const node of ["A", "B", "C"]) {
      expect(cycleErrs[0]).toContain(node);
    }
  });

  it("returns an error when there is no tasks array", () => {
    const res = validateLedgerDeps({} as LedgerLike);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('ledger has no "tasks" array');
  });

  // ---- malformed `deps` shapes: the validator must FAIL LOUD, not coerce ----
  // A non-array `deps` used to become `[]` and a non-string element used to be
  // filtered out — both silently dropped a dependency, which can make a task
  // pickable before its real prerequisite is done.

  it('flags a non-array "deps" (string) instead of silently coercing it to []', () => {
    const ledger = { tasks: [{ id: "T1", deps: "T0" }] } as unknown as LedgerLike;
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('non-array "deps"'))).toBe(true);
  });

  it("flags a null deps as a non-array shape", () => {
    const ledger = { tasks: [{ id: "A", deps: null }] } as unknown as LedgerLike;
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('non-array "deps"'))).toBe(true);
  });

  it("flags a non-string dep element instead of silently filtering it out", () => {
    const ledger = { tasks: [{ id: "A", deps: [123] }] } as unknown as LedgerLike;
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("non-string dep"))).toBe(true);
  });

  it("treats a missing deps as no dependencies (still valid)", () => {
    const ledger = { tasks: [{ id: "A" }, { id: "B" }] } as unknown as LedgerLike;
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("flags the bad element AND still checks the well-formed ones (no early bail)", () => {
    // ["A", 5] — element 5 is flagged, and the valid edge to "A" is still
    // validated (here "A" is unknown), proving we don't stop at the first error.
    const ledger = {
      tasks: [{ id: "B", deps: ["A", 5] }],
    } as unknown as LedgerLike;
    const res = validateLedgerDeps(ledger);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("non-string dep"))).toBe(true);
    expect(res.errors).toContain('task "B" depends on unknown task id "A"');
  });
});

describe("runCli (exit codes + file IO)", () => {
  beforeEach(() => {
    // The CLI prints to stderr/stdout; silence it so test output stays clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function writeLedger(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ledger-"));
    const p = join(dir, "ledger.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it("exits 1 when no path arg is given", () => {
    expect(runCli(["node", "script"])).toBe(1);
  });

  it("exits 1 when the file does not exist", () => {
    expect(
      runCli(["node", "script", join(tmpdir(), "ralph-no-such-file-xyz.json")]),
    ).toBe(1);
  });

  it("exits 1 on non-JSON file contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ledger-"));
    const p = join(dir, "bad.json");
    writeFileSync(p, "not json {");
    expect(runCli(["node", "script", p])).toBe(1);
  });

  it("exits 1 when there is no tasks array", () => {
    expect(runCli(["node", "script", writeLedger({ nope: true })])).toBe(1);
  });

  it("exits 0 on a valid ledger", () => {
    const p = writeLedger({
      tasks: [
        { id: "T1", deps: [] },
        { id: "T2", deps: ["T1"] },
      ],
    });
    expect(runCli(["node", "script", p])).toBe(0);
  });

  it("exits 1 on a malformed non-string-element deps ledger (the regression this PR fixes)", () => {
    const p = writeLedger({ tasks: [{ id: "A", deps: [123] }] });
    expect(runCli(["node", "script", p])).toBe(1);
  });

  it("exits 1 on a non-array deps ledger", () => {
    const p = writeLedger({ tasks: [{ id: "A", deps: "T1" }] });
    expect(runCli(["node", "script", p])).toBe(1);
  });
});

describe("validateLedgerDeps — folds (status batched)", () => {
  const fold = (id: string, into: unknown, deps: string[] = []) => ({ id, deps, status: "batched", batched_into: into });

  it("accepts a well-formed fold, and reads a dep on the folded row as a dep on its host", () => {
    const res = validateLedgerDeps({ tasks: [task("H"), fold("F", "H"), task("D", ["F"])] });
    expect(res).toEqual({ ok: true, errors: [] });
  });

  it("rejects a fold with no, unknown, self, batched or gate host", () => {
    const res = validateLedgerDeps({
      tasks: [
        task("H"),
        { id: "G", deps: [], status: "todo", human_gate: true },
        fold("F1", undefined),
        fold("F2", "NOPE"),
        fold("F3", "F3"),
        fold("F4", "F1"),
        fold("F5", "G"),
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/"F1" has status:"batched" but no "batched_into"/);
    expect(res.errors.join("\n")).toMatch(/"F2" is batched into unknown task id "NOPE"/);
    expect(res.errors.join("\n")).toMatch(/"F3" is batched into itself/);
    expect(res.errors.join("\n")).toMatch(/"F4" is batched into "F1", which is itself batched/);
    expect(res.errors.join("\n")).toMatch(/"F5" is batched into "G", a human gate/);
  });

  it("rejects batched_into on a row that is not batched, and a batched gate", () => {
    const res = validateLedgerDeps({
      tasks: [task("H"), { id: "X", deps: [], status: "todo", batched_into: "H" }, { ...fold("G", "H"), human_gate: true }],
    });
    expect(res.errors.join("\n")).toMatch(/"X" has "batched_into" but its status is not "batched"/);
    expect(res.errors.join("\n")).toMatch(/"G" is a human gate \/ decision with status:"batched"/);
  });

  it("rejects a host that still depends on a task folded into it", () => {
    const res = validateLedgerDeps({ tasks: [fold("F", "H"), task("H", ["F"])] });
    expect(res.errors).toEqual([expect.stringMatching(/"H" depends on "F", which is batched into "H" — drop the dep/)]);
  });

  it("rejects a host that doesn't carry its folded task's dep; accepts one that reaches it transitively", () => {
    const bad = validateLedgerDeps({ tasks: [task("P"), task("H"), fold("F", "H", ["P"])] });
    expect(bad.errors).toEqual([expect.stringMatching(/"F" is batched into "H" but "H" doesn't depend on "P"/)]);
    const ok = validateLedgerDeps({ tasks: [task("P"), task("Q", ["P"]), task("H", ["Q"]), fold("F", "H", ["P"])] });
    expect(ok.ok).toBe(true);
  });

  it("finds a cycle that only exists through a fold", () => {
    // H depends on D, D depends on F, F is folded into H → H -> D -> H.
    const res = validateLedgerDeps({ tasks: [task("H", ["D"]), task("D", ["F"]), fold("F", "H")] });
    expect(res.errors.join("\n")).toMatch(/dependency cycle detected/);
  });
});
