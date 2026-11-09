// Ralph BLOCKED COMMENT — the plain-language note a stage posts when it parks a PR.
//
// Why (2026-10-12): Matt was told to comment `<!-- ralph:retry -->` to un-park a
// task and did not know what that meant. Every block now opens with what went
// wrong and what to do, in ordinary words, and the un-park is a plain `retry`
// reply (next-step.ts `isPlainRetry`). The machine marker stays as the comment's
// LAST line, because that is what next-step.ts reads.
//
// CLI (a stage agent writes the body to a file, then `gh pr comment --body-file`):
//   node <ralph>/lib/blocked-comment.ts --reason env --why "<one plain sentence>" [--fix "<what to do>"] [--detail-file <path>]

import { readFileSync } from "node:fs";
import { isEntryPoint } from "./is-entry-point.ts";

export const BLOCK_REASONS = ["guardrail", "env", "limit", "conflict", "other"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

// What Matt does about each reason when the stage gives no specific fix.
const DEFAULT_FIX: Record<BlockReason, string> = {
  guardrail: "This step needs a person (for example applying a migration, a deploy, or a live-data change). Do that step yourself",
  env: "The machine, not this PR, is the problem (for example low disk, a busy database, or a broken install). Fix the machine",
  limit: "Ralph tried to fix this PR several times and could not. Read the last review or check comment above and fix it yourself, or change the task",
  conflict: "The branch conflicts with main in a way Ralph would not resolve on its own. Resolve the conflict",
  other: "Read the details below and fix the cause",
};

export interface BlockedComment {
  reason: BlockReason;
  /** One plain sentence: what went wrong. No internal jargon. */
  why: string;
  /** Optional specific instruction; otherwise the reason's default. */
  fix?: string;
  /** Optional technical detail (commands, output) shown below the plain part. */
  detail?: string;
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

export function blockedCommentBody(c: BlockedComment): string {
  if (!(BLOCK_REASONS as readonly string[]).includes(c.reason)) throw new Error(`unknown block reason ${c.reason}`);
  if (!c.why.trim()) throw new Error("a blocked comment needs a plain `why`");
  const fix = sentence(c.fix?.trim() || DEFAULT_FIX[c.reason]);
  const parts = [
    `**Ralph stopped on this PR.** Blocked because ${sentence(c.why.trim().replace(/^[A-Z](?=[a-z])/,(ch) => ch.toLowerCase()))}`,
    "",
    `**To continue:** ${fix.replace(/\.$/, "")}, then either`,
    "- merge this PR yourself (Ralph counts a PR you merge as done), or",
    "- reply to this PR with just the word `retry`, and run `/ralph` again.",
  ];
  if (c.detail?.trim()) parts.push("", "<details><summary>Details</summary>", "", c.detail.trim(), "", "</details>");
  parts.push("", `<!-- ralph:blocked reason=${c.reason} -->`);
  return parts.join("\n");
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function runCli(argv: string[], read: (p: string) => string = (p) => readFileSync(p, "utf8")): number {
  const reason = flag(argv, "--reason") as BlockReason | undefined;
  const why = flag(argv, "--why");
  if (!reason || !why || !(BLOCK_REASONS as readonly string[]).includes(reason)) {
    console.error(`usage: blocked-comment.ts --reason <${BLOCK_REASONS.join("|")}> --why "<plain sentence>" [--fix "<what to do>"] [--detail-file <path>]`);
    return 1;
  }
  const detailFile = flag(argv, "--detail-file");
  console.log(blockedCommentBody({ reason, why, fix: flag(argv, "--fix"), detail: detailFile ? read(detailFile) : undefined }));
  return 0;
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) process.exit(runCli(process.argv));
