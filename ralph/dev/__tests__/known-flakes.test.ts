import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseFlakes,
  recordFlake,
  checkFlakes,
  decideFlakes,
  runCli,
  KNOWN_FLAKES_PATH,
  KNOWN_FLAKES_BRANCH,
  type CliIO,
} from "../../lib/known-flakes.ts";

const TEMPLATE = fileURLToPath(new URL("../../docs/known-flakes-template.md", import.meta.url));

const HEAD = "| Test file | Symptom | Times seen | Last seen | Evidence |\n|---|---|---|---|---|";
const MD = `# Known flakes\n\nIntro.\n\n${HEAD}\n| \`scripts/__tests__/a.test.ts\` | timed out under load | 2 | 2026-10-01 | PR #1 |\n\nFooter text.\n`;

describe("known flakes list (lesson 9)", () => {
  it("parses the table", () => {
    expect(parseFlakes(MD)).toEqual([
      { file: "scripts/__tests__/a.test.ts", symptom: "timed out under load", timesSeen: 2, lastSeen: "2026-10-01", evidence: "PR #1" },
    ]);
  });

  it("recording a listed test bumps its count and evidence, leaving the rest of the doc alone", () => {
    const out = recordFlake(MD, { file: "./scripts/__tests__/a.test.ts", symptom: "x", evidence: "PR #9: fail / pass", date: "2026-10-12" });
    expect(parseFlakes(out)).toEqual([
      { file: "scripts/__tests__/a.test.ts", symptom: "timed out under load", timesSeen: 3, lastSeen: "2026-10-12", evidence: "PR #9: fail / pass" },
    ]);
    expect(out).toContain("Intro.");
    expect(out).toContain("Footer text.");
  });

  it("recording a new test appends a row, and escapes pipes in the evidence", () => {
    const out = recordFlake(MD, { file: "src/b.test.ts", symptom: "flaky", evidence: "run 1 | run 2", date: "2026-10-12" });
    const rows = parseFlakes(out);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ file: "src/b.test.ts", timesSeen: 1, evidence: "run 1 | run 2" });
  });

  it("creates the table when the doc has none", () => {
    const out = recordFlake("# Flakes\n", { file: "src/c.test.ts", symptom: "s", evidence: "e", date: "d" });
    expect(parseFlakes(out)).toHaveLength(1);
  });

  it("check splits failing files into known and unknown", () => {
    const got = checkFlakes(MD, ["scripts/__tests__/a.test.ts", "src/new.test.ts"]);
    expect(got.known.map((f) => f.file)).toEqual(["scripts/__tests__/a.test.ts"]);
    expect(got.unknown).toEqual(["src/new.test.ts"]);
  });

  it("the CLI records into the file and refuses a sighting without evidence", () => {
    let written = "";
    const logs: string[] = [];
    const io: CliIO = { read: () => MD, write: (_p, s) => (written = s), today: () => "2026-10-12", log: (s) => logs.push(s), err: () => {} };
    expect(runCli(["node", "x", "record", "--test", "src/d.test.ts", "--symptom", "s"], io)).toBe(1);
    expect(runCli(["node", "x", "record", "--test", "src/d.test.ts", "--symptom", "s", "--evidence", "PR #2"], io)).toBe(0);
    expect(parseFlakes(written).map((f) => f.file)).toContain("src/d.test.ts");
    expect(runCli(["node", "x", "check", "src/d.test.ts"], { ...io, read: () => written })).toBe(0);
    expect(JSON.parse(logs.at(-1)!).known).toHaveLength(1);
  });

  it("the shipped template parses (a new repo starts from it), and recording into it works", () => {
    // The template's table is empty, so prove it is well-formed by recording a row into it.
    const text = readFileSync(TEMPLATE, "utf8");
    const rows = parseFlakes(text);
    expect(rows.every((r) => r.file && r.evidence)).toBe(true);
    const after = parseFlakes(recordFlake(text, { file: "src/x.test.ts", symptom: "s", evidence: "PR #1: e", date: "2026-10-31" }));
    expect(after).toHaveLength(rows.length + 1);
    expect(after.find((r) => r.file === "src/x.test.ts")).toMatchObject({ timesSeen: 1, evidence: "PR #1: e" });
  });
});

describe("flake or real failure? (PR #1164 review: passing alone is not enough)", () => {
  const A = "src/a.test.ts";
  const B = "src/b.test.ts";

  it("a file that passes alone is NOT yet a flake: the full gate must be re-run first", () => {
    const d = decideFlakes({ firstRun: [A], aloneFailed: [], fullRerunFailed: null });
    expect(d.next).toBe("full-rerun");
    expect(d.verdicts).toEqual([{ file: A, verdict: "unproven" }]);
    expect(d.record).toEqual([]);
  });

  it("an order-dependent failure (passes alone, fails again in the full re-run) is REAL and never recorded", () => {
    const d = decideFlakes({ firstRun: [A], aloneFailed: [], fullRerunFailed: [A] });
    expect(d.next).toBe("attribute");
    expect(d.verdicts).toEqual([{ file: A, verdict: "real" }]);
    expect(d.record).toEqual([]);
  });

  it("only a passing FULL re-run makes every first-run failure a flake to record", () => {
    const d = decideFlakes({ firstRun: [A, `./${B}`], aloneFailed: [], fullRerunFailed: [] });
    expect(d.next).toBe("record");
    expect(d.verdicts).toEqual([{ file: A, verdict: "flake" }, { file: B, verdict: "flake" }]);
    expect(d.record).toEqual([A, B]);
  });

  it("a file that fails alone too is real: no full re-run, nothing recorded", () => {
    const d = decideFlakes({ firstRun: [A, B], aloneFailed: [B], fullRerunFailed: null });
    expect(d.next).toBe("attribute");
    expect(d.verdicts).toEqual([{ file: A, verdict: "unproven" }, { file: B, verdict: "real" }]);
    expect(d.record).toEqual([]);
  });

  it("a red full re-run records nothing, even for first-run files that passed in it", () => {
    const d = decideFlakes({ firstRun: [A], aloneFailed: [], fullRerunFailed: [B] });
    expect(d.next).toBe("attribute");
    expect(d.verdicts).toEqual([{ file: A, verdict: "unproven" }, { file: B, verdict: "real" }]);
    expect(d.record).toEqual([]);
  });

  it("refuses to decide with no first-run failures", () => {
    expect(() => decideFlakes({ firstRun: [], aloneFailed: [], fullRerunFailed: [] })).toThrow();
  });

  it("the CLI `decide` prints the decision: neither flag / --full-failed / --full-passed", () => {
    const logs: string[] = [];
    const io: CliIO = { read: () => MD, write: () => {}, today: () => "d", log: (s) => logs.push(s), err: () => {} };
    expect(runCli(["node", "x", "decide", "--first", `${A},${B}`], io)).toBe(0);
    expect(JSON.parse(logs.at(-1)!).next).toBe("full-rerun");
    expect(runCli(["node", "x", "decide", "--first", A, "--full-failed", A], io)).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ next: "attribute", record: [] });
    expect(runCli(["node", "x", "decide", "--first", A, "--full-passed"], io)).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ next: "record", record: [A] });
    expect(runCli(["node", "x", "decide"], io)).toBe(1);
  });

  it("flake rows have one standing branch, never a task branch", () => {
    expect(KNOWN_FLAKES_BRANCH).toBe("ralph/known-flakes");
  });
});
