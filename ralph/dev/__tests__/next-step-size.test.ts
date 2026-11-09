// size:"small" code tasks run implement → review → merge (2026-11-02): no red
// stage, no check stage. Everything else keeps its route.
import { describe, it, expect } from "vitest";
import { resolveTask, nextStep, isSmallCode, type LedgerTask, type PrFacts, type Marker } from "../../lib/next-step.ts";

function task(over: Partial<LedgerTask> = {}): LedgerTask {
  return { id: "T1", title: "t", pointer: "docs/x.md ### T1", status: "todo", deps: [], human_gate: false, kind: "code", verify: "gate", ...over };
}
function pr(markers: Marker[]): PrFacts {
  return { number: 7, state: "OPEN", headRefName: "ralph/feat/T1", headRefOid: "abc", url: "u", markers };
}
const m = (event: string, attrs: Record<string, string> = {}): Marker => ({ event, attrs });
const small = (over: Partial<LedgerTask> = {}) => task({ size: "small", ...over });
const run = (t: LedgerTask, p?: PrFacts) => resolveTask(t, p, new Set());

describe("size: small code tasks", () => {
  it("isSmallCode is true only for a code task sized small", () => {
    expect(isSmallCode("code", "small")).toBe(true);
    expect(isSmallCode("code", "standard")).toBe(false);
    expect(isSmallCode("code", undefined)).toBe(false);
    expect(isSmallCode("docs", "small")).toBe(false);
  });
  it("starts at implement, not red", () => {
    expect(run(small())).toMatchObject({ action: "run", stage: "implement" });
  });
  it("goes from implemented straight to review (no check stage)", () => {
    expect(run(small(), pr([m("implemented", { sha: "a" })]))).toMatchObject({ stage: "review" });
  });
  it("approve → merge", () => {
    expect(run(small(), pr([m("implemented", { sha: "a" }), m("review", { verdict: "approve" })]))).toMatchObject({ stage: "merge" });
  });
  it("changes → implement, as a fix round", () => {
    const r = run(small(), pr([m("implemented", { sha: "a" }), m("review", { verdict: "changes" })]));
    expect(r).toMatchObject({ stage: "implement", lastEvent: "review-changes", reviewRound: 1 });
  });
  it("a redo-red verdict is an ordinary fix round: there is no red stage to go back to", () => {
    const r = run(small(), pr([m("implemented", { sha: "a" }), m("review", { verdict: "redo-red" })]));
    expect(r).toMatchObject({ stage: "implement", lastEvent: "review-changes" });
  });
  it("a merge-stage check fail sends it back to implement", () => {
    const r = run(small(), pr([m("implemented", { sha: "a" }), m("review", { verdict: "approve" }), m("check", { result: "fail", stage: "merge" })]));
    expect(r).toMatchObject({ stage: "implement", lastEvent: "check-fail" });
  });
  it("the 3rd changes verdict still parks it", () => {
    const rounds = [1, 2, 3].flatMap(() => [m("implemented", { sha: "a" }), m("review", { verdict: "changes" })]);
    expect(run(small(), pr(rounds))).toEqual({ action: "park", reason: "blocked" });
  });
  it("standard (or absent) size keeps the full code route", () => {
    expect(run(task({ size: "standard" }))).toMatchObject({ stage: "red" });
    expect(run(task())).toMatchObject({ stage: "red" });
    expect(run(task(), pr([m("red", { sha: "r", files: "a.test.ts" }), m("implemented", { sha: "a" })]))).toMatchObject({ stage: "check" });
    expect(run(task(), pr([m("red", { sha: "r", files: "a.test.ts" }), m("review", { verdict: "redo-red" })]))).toMatchObject({ stage: "red" });
  });
  it("size is ignored on a docs task (the validator refuses it; the route stays docs)", () => {
    expect(run(task({ kind: "docs", verify: "manual", size: "small" }), pr([m("implemented", { sha: "a" })]))).toMatchObject({ stage: "review" });
  });
  it("the planner reports the size, defaulting to standard", () => {
    expect(nextStep({ feature: { slug: "feat" }, tasks: [small({ id: "A" })] }, [], new Set()).next.size).toBe("small");
    expect(nextStep({ feature: { slug: "feat" }, tasks: [task({ id: "B" })] }, [], new Set()).next.size).toBe("standard");
  });
});
