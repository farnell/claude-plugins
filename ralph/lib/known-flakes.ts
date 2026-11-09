// Ralph KNOWN FLAKES — a small list the merge stage reads before blaming a PR,
// and appends to (with evidence) when a merge-gate test fails,
// then passes on an immediate re-run with nothing changed.
//
// Why (2026-10-12): a merge stage re-ran the
// release tests after a load flake and moved on. Nothing was
// written down, so the next run would rediscover it from scratch, and nobody can
// see which tests flake how often. The list is `docs/ralph/known-flakes.md`, a
// markdown table this module parses and rewrites:
//
//   | Test file | Symptom | Times seen | Last seen | Evidence |
//
// CLI:
//   node <ralph>/lib/known-flakes.ts check <test-file>...
//       → JSON {known: [{file, symptom, timesSeen}], unknown: [file]}
//   node <ralph>/lib/known-flakes.ts decide --first <a,b> [--alone-failed <c>] [--full-failed <d> | --full-passed]
//       → JSON {next: full-rerun|record|attribute, verdicts: [{file, verdict}], record: [file]}
//         (decideFlakes: passing ALONE never makes a flake; only a passing FULL re-run does)
//   node <ralph>/lib/known-flakes.ts record --test <file> --symptom "<text>" --evidence "<PR #n …>" [--date YYYY-MM-DD]
//       → rewrites docs/ralph/known-flakes.md (bumps the count if the file is listed)
//
// Being on the list never excuses a failure: the merge stage still needs the
// FULL re-run to pass. It only tells the stage to re-run FIRST, and keeps the
// count. Rows are recorded on the standing `ralph/known-flakes` branch (one open
// PR for Matt), never on a task branch; `check` reads the list as merged on main.

import { readFileSync, writeFileSync } from "node:fs";
import { isEntryPoint } from "./is-entry-point.ts";

export const KNOWN_FLAKES_PATH = "docs/ralph/known-flakes.md";

export interface Flake {
  file: string;
  symptom: string;
  timesSeen: number;
  lastSeen: string;
  evidence: string;
}

const HEADER = "| Test file | Symptom | Times seen | Last seen | Evidence |";
const DIVIDER = "|---|---|---|---|---|";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
const uncell = (s: string) => s.replace(/\\\|/g, "|").trim();
const unticked = (s: string) => s.replace(/^`|`$/g, "");

/** Split a table row on unescaped pipes. */
function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map(uncell);
}

export function parseFlakes(md: string): Flake[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === HEADER);
  if (start < 0) return [];
  const out: Flake[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith("|")) break;
    const [file = "", symptom = "", times = "", lastSeen = "", evidence = ""] = splitRow(line);
    if (!file) continue;
    out.push({ file: unticked(file), symptom, timesSeen: Number(times) || 1, lastSeen, evidence });
  }
  return out;
}

function renderRow(f: Flake): string {
  return `| \`${cell(f.file)}\` | ${cell(f.symptom)} | ${f.timesSeen} | ${cell(f.lastSeen)} | ${cell(f.evidence)} |`;
}

/** Normalise a test path so `./src/x.test.ts` and `src/x.test.ts` match. */
export function normaliseTestPath(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/:\d+(:\d+)?$/, "");
}

/** Record one sighting: bump an existing row, or append a new one. Pure. */
export function recordFlake(
  md: string,
  sighting: { file: string; symptom: string; evidence: string; date: string },
): string {
  const file = normaliseTestPath(sighting.file);
  const flakes = parseFlakes(md);
  const existing = flakes.find((f) => f.file === file);
  const next: Flake[] = existing
    ? flakes.map((f) =>
        f.file === file
          ? { ...f, timesSeen: f.timesSeen + 1, lastSeen: sighting.date, evidence: sighting.evidence, symptom: f.symptom || sighting.symptom }
          : f,
      )
    : [...flakes, { file, symptom: sighting.symptom, timesSeen: 1, lastSeen: sighting.date, evidence: sighting.evidence }];

  const table = [HEADER, DIVIDER, ...next.map(renderRow)];
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === HEADER);
  if (start < 0) {
    return `${md.replace(/\n*$/, "\n\n")}${table.join("\n")}\n`;
  }
  let end = start + 2;
  while (end < lines.length && (lines[end] ?? "").trim().startsWith("|")) end++;
  return [...lines.slice(0, start), ...table, ...lines.slice(end)].join("\n");
}

export function checkFlakes(md: string, files: string[]): { known: Flake[]; unknown: string[] } {
  const flakes = parseFlakes(md);
  const known: Flake[] = [];
  const unknown: string[] = [];
  for (const raw of files) {
    const f = flakes.find((x) => x.file === normaliseTestPath(raw));
    if (f) known.push(f);
    else unknown.push(normaliseTestPath(raw));
  }
  return { known, unknown };
}

// ---------------------------------------------------------------------------
// Is it a flake? (PR #1164 review.) Passing when re-run ALONE is not enough: a
// failure that depends on test order or shared state always passes alone, so
// that rule recorded real failures as flakes. The rule now:
//
//   1. re-run each failing file alone. One that fails again is REAL (stop).
//   2. all passed alone → re-run the FULL merge gate once.
//   3. the full re-run passes → every first-run failure is a FLAKE; record them.
//      a file fails again in it → REAL. Nothing is recorded: the merge gate is
//      red, so the merge stage attributes it (merge-base comparison) as before.
//
// `fullRerunFailed: null` means the full re-run has not happened yet.

/** The branch flake rows are recorded on — never a task branch. */
export const KNOWN_FLAKES_BRANCH = "ralph/known-flakes";

export type FlakeVerdict = "flake" | "real" | "unproven";
export interface FlakeRuns {
  firstRun: string[];
  aloneFailed: string[];
  fullRerunFailed: string[] | null;
}
export interface FlakeDecision {
  /** full-rerun: run the full gate now · record: record `record`, carry on · attribute: a real failure */
  next: "full-rerun" | "record" | "attribute";
  verdicts: { file: string; verdict: FlakeVerdict }[];
  /** The files to record as flakes. Non-empty only when `next` is "record". */
  record: string[];
}

export function decideFlakes(runs: FlakeRuns): FlakeDecision {
  const norm = (xs: string[]) => [...new Set(xs.map(normaliseTestPath).filter(Boolean))];
  const first = norm(runs.firstRun);
  const alone = new Set(norm(runs.aloneFailed));
  if (first.length === 0) throw new Error("decideFlakes: no first-run failures to decide on");

  if (first.some((f) => alone.has(f))) {
    return {
      next: "attribute",
      verdicts: first.map((file) => ({ file, verdict: alone.has(file) ? "real" : "unproven" })),
      record: [],
    };
  }
  if (runs.fullRerunFailed === null) {
    return { next: "full-rerun", verdicts: first.map((file) => ({ file, verdict: "unproven" })), record: [] };
  }
  const full = norm(runs.fullRerunFailed);
  if (full.length === 0) {
    return { next: "record", verdicts: first.map((file) => ({ file, verdict: "flake" })), record: first };
  }
  const failedAgain = new Set(full);
  const newOnes = full.filter((f) => !first.includes(f));
  return {
    next: "attribute",
    verdicts: [
      ...first.map((file) => ({ file, verdict: (failedAgain.has(file) ? "real" : "unproven") as FlakeVerdict })),
      ...newOnes.map((file) => ({ file, verdict: "real" as FlakeVerdict })),
    ],
    record: [],
  };
}

// ---------------------------------------------------------------------------
export interface CliIO {
  read: (p: string) => string;
  write: (p: string, s: string) => void;
  today: () => string;
  log: (s: string) => void;
  err: (s: string) => void;
}

const realIO: CliIO = {
  read: (p) => readFileSync(p, "utf8"),
  write: (p, s) => writeFileSync(p, s),
  today: () => new Date().toISOString().slice(0, 10),
  log: (s) => console.log(s),
  err: (s) => console.error(s),
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function runCli(argv: string[], io: CliIO = realIO): number {
  const cmd = argv[2];
  const path = flag(argv, "--file") ?? KNOWN_FLAKES_PATH;
  if (cmd === "check") {
    const files = argv.slice(3).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--file");
    io.log(JSON.stringify(checkFlakes(io.read(path), files)));
    return 0;
  }
  if (cmd === "decide") {
    const list = (name: string) => (flag(argv, name) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const firstRun = list("--first");
    if (firstRun.length === 0) {
      io.err("usage: known-flakes.ts decide --first <a,b> [--alone-failed <c>] [--full-failed <d> | --full-passed]");
      return 1;
    }
    const fullRerunFailed = argv.includes("--full-passed") ? [] : argv.includes("--full-failed") ? list("--full-failed") : null;
    io.log(JSON.stringify(decideFlakes({ firstRun, aloneFailed: list("--alone-failed"), fullRerunFailed })));
    return 0;
  }
  if (cmd === "record") {
    const test = flag(argv, "--test");
    const symptom = flag(argv, "--symptom");
    const evidence = flag(argv, "--evidence");
    if (!test || !symptom || !evidence) {
      io.err('usage: known-flakes.ts record --test <file> --symptom "<text>" --evidence "<PR #n: what ran>" [--date YYYY-MM-DD]');
      return 1;
    }
    const date = flag(argv, "--date") ?? io.today();
    io.write(path, recordFlake(io.read(path), { file: test, symptom, evidence, date }));
    io.log(`recorded ${normaliseTestPath(test)} in ${path}`);
    return 0;
  }
  io.err("usage: known-flakes.ts check <file>... | decide --first <a,b> [--alone-failed <c>] [--full-failed <d> | --full-passed] | record --test <file> --symptom <s> --evidence <e> [--date d]");
  return 1;
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) process.exit(runCli(process.argv));
