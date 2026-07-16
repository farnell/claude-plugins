# claude-plugins

A small marketplace of [Claude Code](https://docs.claude.com/en/docs/claude-code) tools. Currently one: **adversarial-review** — a Claude × Codex code reviewer.

---

## adversarial-review

Two models review the same target and argue until they agree. **Codex** and a **blind Claude pass** review the target independently in parallel; Claude then audits each Codex finding against the source, sends a critique back, and the loop repeats for up to N rounds. The result is synthesized into confirmed findings, a disputed set, and prioritized actions — **every `file:line` citation is machine-checked against the repo** (against the PR head for PR targets) so a hallucinated reference can't be labelled "confirmed", and a fresh-context **refuter pass** then tries to overturn each agreed finding so two models converging on something plausible-but-wrong gets caught too.

- Reviews either a **markdown file** (`docs/architecture.md`) or a **GitHub PR** (`260`).
- **Resumable** — state persists to `~/.claude/adversarial-review-state/`, so you can approve more rounds or answer a question and it continues rather than restarting.
- **Optional** `--comment` (PR only) posts the synthesis as a single summary comment, updated in place on re-run.

### Prerequisites

Assumes you already run both, authenticated:

- **Claude Code** — the host (this is a Claude Code tool).
- **[Codex CLI](https://github.com/openai/codex)** — the second reviewer (`codex exec` must work). Setup walkthrough below if you need it.
- **[`gh` CLI](https://cli.github.com/)** — only for PR targets and `--comment` (needs repo scope).

### Install

```bash
/plugin marketplace add farnell/claude-plugins
/plugin install adversarial-review@farnell-plugins
```

Restart Claude Code, then run `/adversarial-review`. **That's it** — permissions and the workflow engine are set up automatically and stay current on every update.

<details>
<summary>How it works / troubleshooting</summary>

Claude Code plugins can't register workflows directly, so the engine ships *inside* the plugin and a bundled `SessionStart` hook copies it into `~/.claude/workflows/` on every session start (installs on first run, re-syncs the latest on every update). The Bash permissions the review needs (`codex exec`, `gh`, `mktemp`, …) ride in the plugin's `settings.json`.

If `/adversarial-review` ever reports the workflow isn't found (e.g. you run with hooks disabled), drop the engine in by hand:

```bash
curl -o ~/.claude/workflows/adversarial-review.js \
  https://raw.githubusercontent.com/farnell/claude-plugins/main/adversarial-review/workflows/adversarial-review.js
```

</details>

### Usage

```
/adversarial-review 260                     # review PR #260
/adversarial-review docs/architecture.md    # review a file
/adversarial-review 260 --comment           # review a PR and post the synthesis as a comment
/adversarial-review continue                # approve more rounds from the last checkpoint
```

Tuning (optional): pass `effort` (`low`|`medium`|`high`|`xhigh`|`max`) and/or `model` to change the Codex run. Defaults are model **`gpt-5.6-sol`** and effort **`high`** for both PRs and files (drop to `medium`/`low` for a faster, shallower pass on big files). Long runs are fine — Codex is launched detached and polled, so there's no 10-minute ceiling.

<details>
<summary><strong>Setting up Codex</strong> (optional — skip if <code>codex</code> already works)</summary>

The review's second opinion comes from OpenAI's Codex CLI. If you don't have it yet:

```bash
# install (pick one)
npm install -g @openai/codex
brew install --cask codex

# authenticate: run codex and choose "Sign in with ChatGPT"
# (Plus/Pro/Business/Edu/Enterprise) — or use an OpenAI API key.
codex

# sanity check
codex exec "say hello"
```

**Optional: give Codex the same project context as Claude Code.** Codex reads `AGENTS.md` files (walking from the git root down to your working directory, plus a global `~/.codex/AGENTS.md`). If you already maintain a `CLAUDE.md`, symlink it so both tools share one source of truth — Codex then reviews with full knowledge of your architecture and conventions:

```bash
# from the repo root — AGENTS.md becomes a link to CLAUDE.md (CLAUDE.md stays canonical)
ln -s CLAUDE.md AGENTS.md
git add AGENTS.md   # commit it so clones get the link too
```

Notes:
- Use the **uppercase** name `AGENTS.md` — git is case-sensitive even where macOS isn't, and Codex looks for that exact name.
- Symlink the file at the **repo root**; nested `AGENTS.md` (e.g. `src/api/AGENTS.md → CLAUDE.md`) layer on top for that subtree, with deeper files weighted more heavily.
- Verify Codex is loading it: from the repo root run `codex --ask-for-approval never "Summarize the current instructions."` and confirm it echoes your `CLAUDE.md` guidance.

</details>

### Hardening / known work

Security and correctness hardening for the review loop is tracked here: **https://github.com/farnell/claude-plugins/issues/2**. (Citations now resolve against the PR head via a dedicated worktree; Codex still ingests untrusted PR content under a prompt-level guard rather than a sandbox — that part is still being tightened.)

---

## Development

The workflow inlines byte-for-byte copies of the pure helpers in `adversarial-review/dev/core.ts` (the workflow runtime forbids `import()`). A drift-guard test extracts the inlined block and asserts behavioural parity, so the two copies can never silently diverge.

```bash
npm install
npm test
```

### Releasing an update (maintainer)

Updates are **version-gated**: `/plugin update` compares the installed `version` against the marketplace, so a push with no version bump is invisible to users. To ship a change:

1. Edit the files under `adversarial-review/` — including `workflows/adversarial-review.js`; the engine is bundled, so a workflow change ships like any other.
2. **Bump `version`** in BOTH `adversarial-review/.claude-plugin/plugin.json` and the entry in `.claude-plugin/marketplace.json` (keep them equal) — updates are version-gated, so an un-bumped push is invisible to `/plugin update`.
3. Validate: `claude plugin validate ./adversarial-review && claude plugin validate .`
4. Commit and push to `main`.

The `SessionStart` hook re-syncs the (now updated) engine from the plugin cache into `~/.claude/workflows/` on the user's next session — no separate engine release, no re-curl.

**Safety net (so step 2 can't be forgotten):** a tracked `pre-push` hook (`.githooks/pre-push`) refuses any push to `main` that changes `adversarial-review/` content without bumping the version, and also blocks a mismatch between the two version fields. It activates automatically on `npm install` (via the `prepare` script); to activate it by hand in a fresh clone run `git config core.hooksPath .githooks`. A vitest test (`npm test`) independently asserts the two versions stay equal. Override the hook in a pinch with `git push --no-verify`.

### Getting updates (maintainer / your own machines)

**Merging to `main` updates nothing locally.** Three copies must each advance — the marketplace clone, the version-gated cache, and the live engine at `~/.claude/workflows/adversarial-review.js` (what actually runs, synced from the cache by the `SessionStart` hook). The reliable one-command way to pull a merged release:

```bash
scripts/sync-local.sh
```

Idempotent. It resets the marketplace clone to `origin/main`, rebuilds the cache dir for the released version, repoints `installed_plugins.json`, and syncs the live engine — no restart needed. Verify with `grep -c <your-new-token> ~/.claude/workflows/adversarial-review.js`.

**Don't rely on the TUI or auto-update.** There is no `/plugin update` *command* (typing it just opens the browser), and auto-update **silently no-ops when the marketplace clone is stale or diverged** — and this repo squash-merges, which rewrites history and causes exactly that divergence. The supported-but-flaky path, for completeness:

```bash
/plugin marketplace update farnell-plugins                # MUST refresh the clone first — the version gate reads it
/plugin update adversarial-review@farnell-plugins         # via the /plugin TUI; the @marketplace qualifier is required
# then restart so the SessionStart hook copies the new engine from the cache
```

For a **workflow-only** change you can skip all of it and pull the engine straight from `main` — that's the `curl` one-liner in the *How it works / troubleshooting* box above.

## License

[MIT](LICENSE)
