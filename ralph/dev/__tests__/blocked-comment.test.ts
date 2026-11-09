import { describe, it, expect } from "vitest";
import { blockedCommentBody, BLOCK_REASONS } from "../../lib/blocked-comment.ts";
import { parseMarkers, isPlainRetry } from "../../lib/next-step.ts";

describe("blocked comment (lesson 6)", () => {
  const body = blockedCommentBody({ reason: "env", why: "Free disk is 12 GB, and the release tests need 20 GB" });

  it("opens in plain words: what went wrong, then what to do", () => {
    expect(body.split("\n")[0]).toBe("**Ralph stopped on this PR.** Blocked because free disk is 12 GB, and the release tests need 20 GB.");
    expect(body).toMatch(/\*\*To continue:\*\* .*Fix the machine, then either/);
    expect(body).toMatch(/merge this PR yourself \(Ralph counts a PR you merge as done\)/);
    expect(body).toMatch(/reply to this PR with just the word `retry`, and run `\/ralph` again/);
  });

  it("never asks Matt to type an HTML comment", () => {
    const plain = body.split("\n").slice(0, -1).join("\n");
    expect(plain).not.toMatch(/<!--/);
  });

  it("ends with the machine marker so next-step parks the task", () => {
    expect(body.trimEnd().split("\n").at(-1)).toBe("<!-- ralph:blocked reason=env -->");
    expect(parseMarkers([body])).toEqual([{ event: "blocked", attrs: { reason: "env" } }]);
  });

  it("is never itself read as a retry", () => {
    for (const reason of BLOCK_REASONS) {
      const b = blockedCommentBody({ reason, why: "x" });
      expect(isPlainRetry(b)).toBe(false);
    }
  });

  it("uses a specific fix when given, and tucks technical detail away", () => {
    const b = blockedCommentBody({ reason: "guardrail", why: "Migration 0181 must be applied", fix: "Run `pnpm db:migrate` on the warehouse", detail: "drizzle/0181_x.sql" });
    expect(b).toMatch(/\*\*To continue:\*\* Run `pnpm db:migrate` on the warehouse, then either/);
    expect(b).toMatch(/<details><summary>Details<\/summary>[\s\S]*drizzle\/0181_x\.sql[\s\S]*<\/details>/);
  });

  it("keeps an acronym at the start of the reason intact", () => {
    expect(blockedCommentBody({ reason: "other", why: "PR #12 conflicts" })).toMatch(/Blocked because PR #12 conflicts\./);
  });

  it("refuses an empty reason or an unknown reason word", () => {
    expect(() => blockedCommentBody({ reason: "env", why: "  " })).toThrow();
    expect(() => blockedCommentBody({ reason: "nope" as never, why: "x" })).toThrow();
  });
});
