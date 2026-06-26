---
description: Adversarial Claude × Codex review of a markdown file or GitHub PR (resumable, citation-checked).
argument-hint: "<PR#|file.md> [--comment] [continue]"
---

Invoke the adversarial-review workflow using the Workflow tool.

Parse $ARGUMENTS to extract the target (and optional flags):
- A number (e.g. "242") → a PR number
- A file path (e.g. "docs/architecture.md") → a file path
- If the user says "continue"/"approve more rounds"/"resume", pass `resume: true` (and `maxRounds` higher than before)
- If the user is answering a prior `needs_human` question, pass `resume: true` and `humanAnswer: "<their answer>"`
- Optional `effort` (`low`|`medium`|`high`|`xhigh`|`max`) and `model` (e.g. `gpt-5.5`) tune the Codex reasoning tier. Omit them to use the default: **`high` for PRs, `medium` for files** (high reasoning on a large file is ~30 min / ~700k tok — only pass `effort: 'high'` for a file when the user explicitly wants the deepest pass). Invalid values fall back to the default.
- Optional `--comment` flag (or the user saying "post it to the PR" / "comment on the PR") → pass `comment: true`. **PR targets only** — it posts the synthesized result as ONE summary comment (confirmed findings + the disputed set + prioritized actions), created once and then **updated in place** on re-run via a hidden marker (no duplicate comments). Ignored with a note for file targets. Opt-in, off by default — this is the only write the workflow makes to GitHub.

Then call (omit `effort` to take the size-aware default; add `comment: true` only when the user opted in):
Workflow({ name: 'adversarial-review', args: { target: '<parsed-target>', maxRounds: 3 } })

Invoke by **`name`**, not a relative `scriptPath` — `name` resolves the engine cwd-independently from `~/.claude/workflows/adversarial-review.js` (synced there by the plugin's `SessionStart` hook from its bundled `workflows/`) or a project `.claude/workflows/`. A relative `scriptPath` would resolve against the user's current project and fail in any repo that doesn't have its own copy. If `name` can't be found, the engine wasn't synced (hooks disabled, or first session before the hook ran) — tell the user to restart Claude Code, or to run the README's fallback `curl … -o ~/.claude/workflows/adversarial-review.js`.

After the workflow completes, format and present the result based on `status`:
- `agreed` — both agents converged. Show summary, agreedFindings (severity + confidence + citation + action item), and prioritizedActionItems.
- `needs_approval` — hit the round cap without full agreement. Show the synthesized findings + unresolvedPoints, then surface the permission gate: ask the user whether to approve more rounds. If yes, re-invoke with `{ target, resume: true, maxRounds: <higher> }` (this CONTINUES from the saved checkpoint, it does not restart).
- `needs_human` — a question only the user can answer. Surface `question` + `context` clearly and stop. When they answer, re-invoke with `{ target, resume: true, humanAnswer: "<answer>" }`.
- `codex_failed` — Codex exited non-zero / produced no review. Report it; offer to re-run (fresh, or `resume: true` if state was saved).
- `resume_failed` — the Codex session id wasn't captured so the loop couldn't continue. Report it; offer a fresh re-run.
- `error` — bad/missing target or invalid file path. Show the message.

Every `agreed`/`needs_approval` result also carries `citationAudit` `{ checked, unresolved, results[] }`: each `file:line` cited in the findings is checked against the repo (file exists + line in range; bare filenames resolved via `find`). When `unresolved > 0`, call it out prominently and tell the user those citations are stale or hallucinated and must be re-checked before acting (the message field already appends this warning). Note the check confirms the line *resolves*, not that it says what the finding claims — line-in-range ≠ line-correct.

When `comment: true` was passed (PR only), the result also carries `comment` `{ posted, action, url }`. Surface the comment URL when `posted` is true; if `posted` is false, tell the user it did not post (gh failure or missing permission) — the findings in the result still stand regardless. A post failure does NOT change the review `status`.

Notes:
- Codex runs as `gpt-5.5`; reasoning effort defaults to `high` for PRs / `medium` for files, overridable via the `effort` arg.
- State persists to ~/.claude/adversarial-review-state/ so `resume: true` genuinely continues a paused review rather than starting over.
- The Bash permissions the Codex subagent needs are shipped in this plugin's `settings.json` and applied when the plugin is enabled, so the auto-mode safety classifier doesn't block it: `Bash(codex exec:*)`, `Bash(mktemp:*)`, `Bash(sort:*)`, `Bash(tail:*)`, `Bash(comm:*)`, `Bash(rm -f:*)`, `Bash(git rev-parse:*)`, `Bash(mkdir -p:*)`, plus `Bash(find:*)`, `Bash(grep:*)`, `Bash(cat:*)` which the generated session-capture bash also runs. For PR reviews the Claude verifier also runs `gh pr view`/`gh pr diff`. If `codex exec` is still blocked (e.g. the plugin isn't enabled), add these to `.claude/settings.local.json` and re-run.
- With `comment: true`, the post step additionally runs `gh repo view`, `gh api` (list + PATCH the comment), and `gh pr comment` to create/update the summary comment. These need the usual `gh` auth (repo write scope); allow `Bash(gh:*)` if the classifier blocks them.
