# claude-plugins

A small marketplace of [Claude Code](https://docs.claude.com/en/docs/claude-code) tools. Currently one: **adversarial-review** — a Claude × Codex code reviewer.

---

## adversarial-review

Two models review the same target and argue until they agree. **Codex (`gpt-5.5`)** produces an initial review; **Claude** independently audits each finding against the source, sends a critique back, and the loop repeats for up to N rounds. The result is synthesized into confirmed findings, a disputed set, and prioritized actions — and **every `file:line` citation is machine-checked against the repo** so a hallucinated reference can't be labelled "confirmed".

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
# 1. add this marketplace (once)
/plugin marketplace add farnell/claude-plugins

# 2. install the command + permissions
/plugin install adversarial-review@farnell-plugins

# 3. drop in the workflow engine
#    (the one manual step — Claude Code plugins can't bundle workflows, so the
#     engine is copied into ~/.claude/workflows/ rather than installed by /plugin)
curl -o ~/.claude/workflows/adversarial-review.js \
  https://raw.githubusercontent.com/farnell/claude-plugins/main/adversarial-review/workflows/adversarial-review.js
```

The Bash permissions the workflow needs (`codex exec`, `gh`, `mktemp`, …) ship in the plugin's `settings.json` and apply automatically once it's enabled.

### Usage

```
/adversarial-review 260                     # review PR #260
/adversarial-review docs/architecture.md    # review a file
/adversarial-review 260 --comment           # review a PR and post the synthesis as a comment
/adversarial-review continue                # approve more rounds from the last checkpoint
```

Tuning (optional): pass `effort` (`low`|`medium`|`high`|`xhigh`|`max`) and/or `model` to change the Codex reasoning tier. Defaults are **`high` for PRs, `medium` for files**.

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

Security and correctness hardening for the review loop is tracked here: **https://github.com/farnell/claude-plugins/issues/2**. (Codex currently ingests untrusted PR content under a prompt-level guard rather than a sandbox, and citations resolve against the working tree rather than the PR head — both are being tightened.)

---

## Development

The workflow inlines byte-for-byte copies of the pure helpers in `adversarial-review/dev/core.ts` (the workflow runtime forbids `import()`). A drift-guard test extracts the inlined block and asserts behavioural parity, so the two copies can never silently diverge.

```bash
npm install
npm test
```

### Releasing an update (maintainer)

Updates are **version-gated**: `/plugin update` compares the installed `version` against the marketplace, so a push with no version bump is invisible to users. To ship a change:

1. Edit the files under `adversarial-review/`.
2. **Bump `version`** in BOTH `adversarial-review/.claude-plugin/plugin.json` and the entry in `.claude-plugin/marketplace.json` (keep them equal).
3. Validate: `claude plugin validate ./adversarial-review && claude plugin validate .`
4. Commit and push to `main`.

⚠️ **If the change touched `workflows/adversarial-review.js`, that's not enough.** Plugins can't register workflows, so the engine lives at `~/.claude/workflows/` and is updated by the README's `curl` step, NOT by `/plugin update`. A workflow change means users must re-run the curl. Changes confined to the command/permissions update cleanly via `/plugin update` alone.

### Getting updates (user)

```bash
/plugin marketplace update farnell-plugins      # refresh the catalog first
/plugin update adversarial-review@farnell-plugins
# if the release notes say the engine changed, also re-run the curl from Install step 3
```

**Auto-update:** off by default for third-party marketplaces like this one (only Anthropic's official marketplaces auto-update out of the box). To opt in, open `/plugin` → Marketplaces → select `farnell-plugins` → **Enable auto-update** (refreshes + updates on Claude Code startup). It still won't touch the curl-installed engine.

## License

[MIT](LICENSE)
