import { describe, it, expect } from "vitest";
import {
  branchFor,
  parseMarkers,
  isPlainRetry,
  resolveTask,
  nextStep,
  MAX_CHECK_FAILURES,
  MAX_REVIEW_CHANGES,
  type LedgerTask,
  type PrFacts,
  type Marker,
} from "../../lib/next-step.ts";

const CHECK = { type: "issue-closed", issue: 1 } as const;

function task(over: Partial<LedgerTask> = {}): LedgerTask {
  return {
    id: "T1",
    title: "do a thing",
    pointer: "docs/x.md ### T1",
    status: "todo",
    deps: [],
    human_gate: false,
    kind: "code",
    verify: "gate",
    ...over,
  };
}

function pr(markers: Marker[], over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 7,
    state: "OPEN",
    headRefName: "ralph/feat/T1",
    headRefOid: "abc123",
    url: "https://github.com/o/r/pull/7",
    markers,
    ...over,
  };
}

const m = (event: string, attrs: Record<string, string> = {}): Marker => ({ event, attrs });

describe("branchFor", () => {
  it("is ralph/<slug>/<id>", () => {
    expect(branchFor("feat", "G1")).toBe("ralph/feat/G1");
  });
  it("replaces characters git refs dislike", () => {
    expect(branchFor("feat", "HG 1:x")).toBe("ralph/feat/HG-1-x");
  });
});

describe("parseMarkers", () => {
  it("reads event + key=value attrs from HTML-comment markers, in comment order", () => {
    const got = parseMarkers([
      "Red tests pushed.\n<!-- ralph:red tests=3 -->",
      "no marker here",
      "<!-- ralph:implemented sha=deadbeef -->\nDone.",
      "<!-- ralph:review verdict=changes round=1 -->",
    ]);
    expect(got).toEqual([
      m("red", { tests: "3" }),
      m("implemented", { sha: "deadbeef" }),
      m("review", { verdict: "changes", round: "1" }),
    ]);
  });

  it("ignores unknown events so a typo cannot move a task", () => {
    expect(parseMarkers(["<!-- ralph:shipit -->"])).toEqual([]);
  });

  it("takes only the LAST marker in a comment (a review quoting the check marker is not a check)", () => {
    const got = parseMarkers([
      "The check said `<!-- ralph:check result=fail -->` earlier.\n<!-- ralph:review verdict=approve -->",
    ]);
    expect(got).toEqual([m("review", { verdict: "approve" })]);
  });

  it("accepts review verdict=redo-red", () => {
    expect(parseMarkers(["<!-- ralph:review verdict=redo-red -->"])).toEqual([
      { event: "review", attrs: { verdict: "redo-red" } },
    ]);
  });

  it("rejects a marker whose enum attr is not an exact value (a pasted template is not a fail)", () => {
    expect(parseMarkers(["<!-- ralph:check result=pass|fail -->"])).toEqual([]);
    expect(parseMarkers(["<!-- ralph:review -->"])).toEqual([]);
  });
});

describe("resolveTask — task-level parking", () => {
  const done = new Set<string>();

  it("skips a task that is done on main", () => {
    expect(resolveTask(task({ status: "done" }), undefined, done)).toEqual({ action: "skip" });
  });

  it("parks a human gate (tick-gates ticks it from its done_when evidence)", () => {
    expect(resolveTask(task({ human_gate: true, done_when: CHECK }), undefined, done)).toEqual({
      action: "park",
      reason: "human_gate",
    });
  });

  it("parks a gate with no valid done_when apart, as gate-no-check", () => {
    expect(resolveTask(task({ human_gate: true }), undefined, done)).toEqual({ action: "park", reason: "gate-no-check" });
    expect(resolveTask(task({ human_gate: true, done_when: { type: "shipped-recently" } }), undefined, done)).toEqual({
      action: "park",
      reason: "gate-no-check",
    });
  });

  it("parks a decision task even if it was not tagged human_gate", () => {
    expect(resolveTask(task({ kind: "decision", done_when: CHECK }), undefined, done)).toMatchObject({
      action: "park",
      reason: "human_gate",
    });
  });

  it("parks a task whose deps are not done", () => {
    expect(resolveTask(task({ deps: ["T0"] }), undefined, done)).toEqual({
      action: "park",
      reason: "deps-not-met",
    });
  });

  it("parks a legacy blocked/awaiting_review ledger status", () => {
    expect(resolveTask(task({ status: "blocked" }), undefined, done)).toMatchObject({
      action: "park",
      reason: "blocked",
    });
    expect(resolveTask(task({ status: "awaiting_review" }), undefined, done)).toMatchObject({
      action: "park",
      reason: "awaiting-human",
    });
  });

  it("parks a merged PR whose ledger tick did not reach main", () => {
    expect(resolveTask(task(), pr([], { state: "MERGED" }), done)).toMatchObject({
      action: "park",
      reason: "merged-ledger-not-done",
    });
  });

  it("parks a PR closed without merging", () => {
    expect(resolveTask(task(), pr([], { state: "CLOSED" }), done)).toMatchObject({
      action: "park",
      reason: "pr-closed",
    });
  });
});

describe("resolveTask — stage from the marker log", () => {
  const done = new Set<string>();
  const stageOf = (t: LedgerTask, p?: PrFacts) => {
    const r = resolveTask(t, p, done);
    return r.action === "run" ? r.stage : `${r.action}:${"reason" in r ? r.reason : ""}`;
  };

  it("a code task with no PR starts at red", () => {
    expect(stageOf(task({ kind: "code" }))).toBe("red");
  });

  it.each(["docs", "measure"] as const)("a %s task with no PR starts at implement (no red stage)", (kind) => {
    expect(stageOf(task({ kind, verify: "manual" }))).toBe("implement");
  });

  it("a code PR with no marker yet re-runs red (the red agent died after opening it)", () => {
    expect(stageOf(task(), pr([]))).toBe("red");
  });

  it("red → implement → check → review → merge", () => {
    expect(stageOf(task(), pr([m("red")]))).toBe("implement");
    expect(stageOf(task(), pr([m("red"), m("implemented", { sha: "a" })]))).toBe("check");
    expect(
      stageOf(task(), pr([m("red"), m("implemented"), m("check", { result: "pass" })])),
    ).toBe("review");
    expect(
      stageOf(
        task(),
        pr([m("red"), m("implemented"), m("check", { result: "pass" }), m("review", { verdict: "approve" })]),
      ),
    ).toBe("merge");
  });

  it("a failed check goes back to implement", () => {
    expect(stageOf(task(), pr([m("red"), m("implemented"), m("check", { result: "fail" })]))).toBe(
      "implement",
    );
  });

  it("review changes go back to implement and carry the round", () => {
    const r = resolveTask(
      task(),
      pr([m("red"), m("implemented"), m("check", { result: "pass" }), m("review", { verdict: "changes" })]),
      done,
    );
    expect(r).toMatchObject({ action: "run", stage: "implement", reviewRound: 1 });
  });

  it(`blocks after ${MAX_REVIEW_CHANGES} review change rounds`, () => {
    const markers = [m("red")];
    for (let i = 0; i < MAX_REVIEW_CHANGES; i++) {
      markers.push(m("implemented"), m("check", { result: "pass" }), m("review", { verdict: "changes" }));
    }
    expect(stageOf(task(), pr(markers))).toBe("park:blocked");
  });

  it(`blocks after ${MAX_CHECK_FAILURES} check failures`, () => {
    const markers = [m("red")];
    for (let i = 0; i < MAX_CHECK_FAILURES; i++) {
      markers.push(m("implemented"), m("check", { result: "fail" }));
    }
    expect(stageOf(task(), pr(markers))).toBe("park:blocked");
  });

  // A bad RED test can't be fixed by implement (it may never change red's assertions), so
  // review sends it back to red with verdict=redo-red (code tasks only).
  it("review redo-red sends a code task back to red, says why, and carries the round", () => {
    const r = resolveTask(
      task(),
      pr([m("red"), m("implemented"), m("check", { result: "pass" }), m("review", { verdict: "redo-red" })]),
      done,
    );
    expect(r).toMatchObject({ action: "run", stage: "red", lastEvent: "review-redo-red", reviewRound: 1 });
  });

  it("after a red redo, implement runs next and is told red's tests were rewritten", () => {
    const r = resolveTask(
      task(),
      pr([
        m("red"),
        m("implemented"),
        m("check", { result: "pass" }),
        m("review", { verdict: "redo-red" }),
        m("red"),
      ]),
      done,
    );
    expect(r).toMatchObject({ action: "run", stage: "implement", lastEvent: "red-redone", reviewRound: 1 });
  });

  it(`redo-red and changes share the ${MAX_REVIEW_CHANGES}-round limit, so a redo cannot loop forever`, () => {
    const markers = [m("red")];
    // Alternate the two verdicts for exactly MAX rounds, whatever MAX is.
    const verdicts = Array.from({ length: MAX_REVIEW_CHANGES }, (_, i) => (i % 2 === 0 ? "redo-red" : "changes"));
    for (const [i, verdict] of verdicts.entries()) {
      markers.push(m("implemented"), m("check", { result: "pass" }), m("review", { verdict }));
      // One round short of the limit, the task still runs.
      if (i === MAX_REVIEW_CHANGES - 2) expect(stageOf(task(), pr(markers))).not.toBe("park:blocked");
      if (verdict === "redo-red") markers.push(m("red"));
    }
    expect(stageOf(task(), pr(markers))).toBe("park:blocked");
  });

  it("redo-red on a docs task (no red stage) goes to implement like changes", () => {
    const r = resolveTask(
      task({ kind: "docs", verify: "manual" }),
      pr([m("implemented"), m("review", { verdict: "redo-red" })]),
      done,
    );
    expect(r).toMatchObject({ action: "run", stage: "implement", lastEvent: "review-changes", reviewRound: 1 });
  });

  // Check's diff baseline comes from the red markers (tested code), not a commit-message search.
  it("reports red's commit and files from the red marker", () => {
    const r = resolveTask(
      task(),
      pr([m("red", { sha: "r1", files: "a.test.ts,b.test.ts" }), m("implemented", { sha: "i1" })]),
      done,
    );
    expect(r).toMatchObject({ action: "run", stage: "check", redSha: "r1", prevRedSha: "", redFiles: ["a.test.ts", "b.test.ts"] });
  });

  it("after a redo: baseline = the redo's commit, previous = the original, files = the union", () => {
    const r = resolveTask(
      task(),
      pr([
        m("red", { sha: "r1", files: "a.test.ts,b.test.ts" }),
        m("implemented", { sha: "i1" }),
        m("check", { result: "pass" }),
        m("review", { verdict: "redo-red" }),
        m("red", { sha: "r2", files: "b.test.ts,c.test.ts" }),
        m("implemented", { sha: "i2" }),
      ]),
      done,
    );
    expect(r).toMatchObject({ redSha: "r2", prevRedSha: "r1", redFiles: ["a.test.ts", "b.test.ts", "c.test.ts"] });
  });

  it("a red marker with only one of sha/files is ignored, so red runs again and re-posts it", () => {
    expect(parseMarkers(["<!-- ralph:red sha=r1 -->", "<!-- ralph:red files=a.test.ts -->"])).toEqual([]);
    // First red: no valid marker → red re-runs.
    expect(stageOf(task(), pr(parseMarkers(["<!-- ralph:red sha=r1 -->"])))).toBe("red");
    // A redo: the review is still the last valid marker → red re-runs.
    const redo = parseMarkers([
      "<!-- ralph:red sha=r1 files=a.test.ts -->",
      "<!-- ralph:implemented sha=i1 -->",
      "<!-- ralph:check result=pass -->",
      "<!-- ralph:review verdict=redo-red -->",
      "<!-- ralph:red files=a.test.ts -->",
    ]);
    expect(stageOf(task(), pr(redo))).toBe("red");
  });

  it("two red markers with no redo-red review between them are not a redo: no previous red commit", () => {
    // Red crashed after posting and was re-run (or re-posted): the later marker is the baseline.
    const r = resolveTask(
      task(),
      pr([m("red", { sha: "r1", files: "a.test.ts" }), m("red", { sha: "r2", files: "a.test.ts" })]),
      done,
    );
    expect(r).toMatchObject({ redSha: "r2", prevRedSha: "" });
  });

  it("a red marker with no sha (a PR from before markers recorded it) reports empty values", () => {
    const r = resolveTask(task(), pr([m("red"), m("implemented", { sha: "i1" })]), done);
    expect(r).toMatchObject({ redSha: "", prevRedSha: "", redFiles: [] });
  });

  it("implement learns WHY it is back from the last event, not the counters", () => {
    // review changes → implement → check fail: the fix is the check failure.
    const r = resolveTask(
      task(),
      pr([
        m("red"),
        m("implemented"),
        m("check", { result: "pass" }),
        m("review", { verdict: "changes" }),
        m("implemented"),
        m("check", { result: "fail" }),
      ]),
      done,
    );
    expect(r).toMatchObject({ action: "run", stage: "implement", lastEvent: "check-fail", reviewRound: 1 });
    // first implement: nothing to fix
    expect(resolveTask(task(), pr([m("red")]), done)).toMatchObject({ lastEvent: "none" });
  });

  it("a merge-stage test failure after approve goes back to implement as a check fail", () => {
    const r = resolveTask(
      task(),
      pr([
        m("red"),
        m("implemented"),
        m("check", { result: "pass" }),
        m("review", { verdict: "approve" }),
        m("check", { result: "fail", stage: "merge" }),
      ]),
      done,
    );
    expect(r).toMatchObject({ action: "run", stage: "implement", lastEvent: "check-fail", checkFailures: 1 });
  });

  it(`acts on ${MAX_REVIEW_CHANGES - 1} change rounds before blocking`, () => {
    const markers = [m("red")];
    for (let i = 0; i < MAX_REVIEW_CHANGES - 1; i++) {
      markers.push(m("implemented"), m("check", { result: "pass" }), m("review", { verdict: "changes" }));
    }
    expect(stageOf(task(), pr(markers))).toBe("implement");
  });

  it("a retry after a check-limit block resumes at implement with the counters cleared", () => {
    const markers = [m("red")];
    for (let i = 0; i < MAX_CHECK_FAILURES; i++) {
      markers.push(m("implemented"), m("check", { result: "fail" }));
    }
    markers.push(m("retry"));
    expect(resolveTask(task(), pr(markers), done)).toMatchObject({
      action: "run",
      stage: "implement",
      checkFailures: 0,
      lastEvent: "check-fail",
    });
  });

  it("an approved manual-verify task parks for Matt instead of merging", () => {
    const r = resolveTask(
      task({ kind: "measure", verify: "manual" }),
      pr([m("implemented"), m("check", { result: "pass" }), m("review", { verdict: "approve" })]),
      done,
    );
    expect(r).toMatchObject({ action: "park", reason: "awaiting-human" });
  });

  it("an explicit blocked marker parks the task", () => {
    expect(stageOf(task(), pr([m("red"), m("blocked", { reason: "guardrail" })]))).toBe("park:blocked");
  });

  it("a retry marker clears the block and the counters, resuming from the last stage", () => {
    const markers = [m("red")];
    for (let i = 0; i < MAX_REVIEW_CHANGES; i++) {
      markers.push(m("implemented"), m("check", { result: "pass" }), m("review", { verdict: "changes" }));
    }
    markers.push(m("blocked"), m("retry"));
    const r = resolveTask(task(), pr(markers), done);
    expect(r).toMatchObject({ action: "run", stage: "implement", reviewRound: 0 });
  });
});

describe("nextStep", () => {
  it("returns the first runnable task in ledger order and parks the rest", () => {
    const tasks = [
      task({ id: "A", status: "done" }),
      task({ id: "B", human_gate: true, done_when: CHECK }),
      task({ id: "C", deps: ["B"] }),
      task({ id: "D" }),
      task({ id: "E" }),
    ];
    const got = nextStep({ feature: { slug: "feat" }, tasks }, [], new Set());
    expect(got.hasNext).toBe(true);
    expect(got.next).toMatchObject({ taskId: "D", stage: "red", branch: "ralph/feat/D", prNumber: 0 });
    expect(got.remaining).toBe(4);
    expect(got.parked).toEqual([
      { id: "B", reason: "human_gate" },
      { id: "C", reason: "deps-not-met" },
    ]);
  });

  it("matches PRs by branch and prefers the open one over an old closed one", () => {
    const tasks = [task({ id: "D" })];
    const prs = [
      pr([], { number: 3, state: "CLOSED", headRefName: "ralph/feat/D" }),
      pr([m("red")], { number: 9, state: "OPEN", headRefName: "ralph/feat/D" }),
    ];
    const got = nextStep({ feature: { slug: "feat" }, tasks }, prs, new Set());
    expect(got.next).toMatchObject({ taskId: "D", stage: "implement", prNumber: 9 });
  });

  it("parks tasks the loop already gave up on this run (--skip)", () => {
    const tasks = [task({ id: "D" }), task({ id: "E" })];
    const got = nextStep({ feature: { slug: "feat" }, tasks }, [], new Set(["D"]));
    expect(got.next).toMatchObject({ taskId: "E" });
    expect(got.parked).toEqual([{ id: "D", reason: "skipped-this-run" }]);
  });

  it("reports hasNext=false with every not-done task parked when nothing is runnable", () => {
    const tasks = [task({ id: "A", status: "done" }), task({ id: "B", human_gate: true, done_when: CHECK })];
    const got = nextStep({ feature: { slug: "feat" }, tasks }, [], new Set());
    expect(got.hasNext).toBe(false);
    expect(got.remaining).toBe(1);
    expect(got.parked).toEqual([{ id: "B", reason: "human_gate" }]);
  });

  it("counts markers so the loop can tell a stage that recorded nothing", () => {
    const tasks = [task({ id: "D" })];
    const prs = [pr([m("red"), m("implemented")], { headRefName: "ralph/feat/D" })];
    const got = nextStep({ feature: { slug: "feat" }, tasks }, prs, new Set());
    expect(got.next.markerCount).toBe(2);
  });

  it("always fills every NextTask field, even when nothing is runnable", () => {
    const got = nextStep({ feature: { slug: "feat" }, tasks: [] }, [], new Set());
    expect(Object.keys(got.next).sort()).toEqual(
      [
        "branch", "checkFailures", "kind", "lastEvent", "markerCount", "model", "pointer",
        "prNumber", "prUrl", "reviewRound", "stage", "taskId", "title", "verify",
        "redSha", "prevRedSha", "redFiles", "size",
      ].sort(),
    );
  });

  it("relays red's commit and files to the stage that runs", () => {
    const got = nextStep(
      { feature: { slug: "feat" }, tasks: [task({ id: "T1" })] },
      [pr([m("red", { sha: "r1", files: "a.test.ts" }), m("implemented", { sha: "i1" })], { headRefName: "ralph/feat/T1" })],
      new Set(),
    );
    expect(got.next).toMatchObject({ stage: "check", redSha: "r1", prevRedSha: "", redFiles: ["a.test.ts"] });
  });

  it("relays the task's per-task model, or empty", () => {
    const got = nextStep(
      { feature: { slug: "feat" }, tasks: [task({ id: "D", model: "sonnet" })] },
      [],
      new Set(),
    );
    expect(got.next.model).toBe("sonnet");
  });
});

// Lessons from the first real run (embeddings-v2 follow-ups, 2026-10-10..12).
describe("docs/measure: check folded into review (lesson 5)", () => {
  const done = new Set<string>();
  it.each(["docs", "measure"] as const)("a %s task goes implement → review, with no check stage", (kind) => {
    const r = resolveTask(task({ kind, verify: "manual" }), pr([m("implemented", { sha: "a" })]), done);
    expect(r).toMatchObject({ action: "run", stage: "review" });
  });

  it("a code task still gets its check stage", () => {
    const r = resolveTask(task({ kind: "code" }), pr([m("red"), m("implemented", { sha: "a" })]), done);
    expect(r).toMatchObject({ action: "run", stage: "check" });
  });

  it("an approved docs task with a command verify merges straight after review", () => {
    const r = resolveTask(
      task({ kind: "docs", verify: "test -f docs/x.md" }),
      pr([m("implemented"), m("review", { verdict: "approve" })]),
      done,
    );
    expect(r).toMatchObject({ action: "run", stage: "merge" });
  });
});

describe("blind-check stage for measure tasks (lesson 3)", () => {
  const done = new Set<string>();
  const blind = (over: Partial<LedgerTask> = {}) =>
    task({ kind: "measure", verify: "manual", blind_check: true, ...over });

  it("a measure task with blind_check goes implement → blind-check → review", () => {
    expect(resolveTask(blind(), pr([m("implemented")]), done)).toMatchObject({ action: "run", stage: "blind-check" });
    expect(resolveTask(blind(), pr([m("implemented"), m("blind-check", { result: "pass" })]), done)).toMatchObject({
      action: "run",
      stage: "review",
    });
  });

  it("a failed blind check goes back to implement, says why, and counts toward the failure limit", () => {
    const r = resolveTask(blind(), pr([m("implemented"), m("blind-check", { result: "fail" })]), done);
    expect(r).toMatchObject({ action: "run", stage: "implement", lastEvent: "blind-check-fail", checkFailures: 1 });
    const markers: Marker[] = [];
    for (let i = 0; i < MAX_CHECK_FAILURES; i++) markers.push(m("implemented"), m("blind-check", { result: "fail" }));
    expect(resolveTask(blind(), pr(markers), done)).toMatchObject({ action: "park", reason: "blocked" });
  });

  it("blind_check on a non-measure task is ignored by the resolver (the validator refuses it)", () => {
    const r = resolveTask(task({ kind: "docs", verify: "manual", blind_check: true }), pr([m("implemented")]), done);
    expect(r).toMatchObject({ action: "run", stage: "review" });
  });

  it("parses the blind-check marker and refuses a template value", () => {
    expect(parseMarkers(["<!-- ralph:blind-check result=fail -->"])).toEqual([m("blind-check", { result: "fail" })]);
    expect(parseMarkers(["<!-- ralph:blind-check result=pass|fail -->"])).toEqual([]);
  });
});

describe("plain `retry` comment un-parks a task (lesson 6)", () => {
  const done = new Set<string>();
  it.each(["retry", "Retry", "RETRY!", "retry.", "/retry", "  retry  \n", "retry - freed the disk", "Retry — box is quiet now"])(
    "%j counts as a retry",
    (body) => {
      expect(isPlainRetry(body)).toBe(true);
      expect(parseMarkers([body])).toEqual([m("retry")]);
    },
  );

  it.each([
    "Retrying the merge after a flake",
    "please retry",
    "Blocked because the disk is full. Reply `retry`",
    "retry the tests later maybe",
    // PR #1164 review: these un-parked a task under the old first-line rule.
    "Retry: no, hold off",
    "retry\n\nactually don't",
    "retry, but only after the build",
    "Retry: box is quiet now",
    "retry -no space before the note",
    "retry!!",
    "retry ?",
  ])("%j does not", (body) => {
    expect(isPlainRetry(body)).toBe(false);
    expect(parseMarkers([body])).toEqual([]);
  });

  it("a plain retry clears a block exactly like the marker", () => {
    const markers = parseMarkers(["<!-- ralph:red -->", "<!-- ralph:blocked reason=env -->", "retry"]);
    expect(resolveTask(task(), pr(markers), done)).toMatchObject({ action: "run", stage: "implement" });
  });

  it("a PR Matt merged by hand counts as done: its ledger tick reached main, so the task is skipped", () => {
    // The implement stage ticks the ledger inside the PR, so a hand merge lands the tick.
    const got = nextStep(
      { feature: { slug: "feat" }, tasks: [task({ id: "T1", status: "done" }), task({ id: "T2", deps: ["T1"] })] },
      [pr([m("implemented")], { state: "MERGED" })],
      new Set(),
    );
    expect(got.next.taskId).toBe("T2");
    expect(got.parked).toEqual([]);
  });
});

describe("resolveTask — gates are judged in the repo's context (its adapter)", () => {
  const done = new Set<string>();
  const gate = task({ human_gate: true, done_when: { type: "prod-includes", pr: 1 } });
  it("prod-includes parks as a human gate where the adapter can read this repo's prod", () => {
    const ctx = { self: "acme/app", prodRepos: ["acme/app"], extraTypes: [] };
    expect(resolveTask(gate, undefined, done, ctx)).toEqual({ action: "park", reason: "human_gate" });
  });
  it("…and as gate-no-check where it cannot (no prod reader for this repo)", () => {
    const ctx = { self: "acme/app", prodRepos: [], extraTypes: [] };
    expect(resolveTask(gate, undefined, done, ctx)).toEqual({ action: "park", reason: "gate-no-check" });
  });
  it("a repo-provided check type is a valid gate only where the adapter declares it", () => {
    const g = task({ human_gate: true, done_when: { type: "sql-true", query: "SELECT true" } as never });
    expect(resolveTask(g, undefined, done, { self: "acme/api", prodRepos: [], extraTypes: ["sql-true"] })).toEqual({ action: "park", reason: "human_gate" });
    expect(resolveTask(g, undefined, done, { self: "acme/app", prodRepos: [], extraTypes: [] })).toEqual({ action: "park", reason: "gate-no-check" });
  });
});

describe("nextStep — batched (folded) rows", () => {
  it("never runs or parks a batched row, and counts it apart from the open tasks", () => {
    const tasks = [
      task({ id: "A" }),
      task({ id: "B", status: "batched", batched_into: "A" }),
      task({ id: "C", status: "done" }),
    ];
    const got = nextStep({ feature: { slug: "feat" }, tasks }, [], new Set());
    expect(got.next).toMatchObject({ taskId: "A" });
    expect(got.parked).toEqual([]);
    expect(got.remaining).toBe(1);
    expect(got.batched).toBe(1);
  });

  it("a dep on a batched row waits on its host", () => {
    const tasks = [
      task({ id: "A" }),
      task({ id: "B", status: "batched", batched_into: "A" }),
      task({ id: "D", deps: ["B"] }),
    ];
    let got = nextStep({ feature: { slug: "feat" }, tasks }, [], new Set());
    expect(got.parked).toEqual([{ id: "D", reason: "deps-not-met" }]);
    tasks[0]!.status = "done";
    got = nextStep({ feature: { slug: "feat" }, tasks }, [], new Set());
    expect(got.next).toMatchObject({ taskId: "D" });
  });

  it("a host's dep on a task folded into it drops out (no self-deadlock)", () => {
    const tasks = [task({ id: "A", status: "batched", batched_into: "H" }), task({ id: "H", deps: ["A"] })];
    const got = nextStep({ feature: { slug: "feat" }, tasks }, [], new Set());
    expect(got.next).toMatchObject({ taskId: "H" });
  });

  it("resolveTask skips a batched row", () => {
    expect(resolveTask(task({ status: "batched", batched_into: "X" }), undefined, new Set())).toEqual({ action: "skip" });
  });
});
