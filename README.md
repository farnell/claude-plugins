# claude-plugins

A personal marketplace of [Claude Code](https://docs.claude.com/en/docs/claude-code) tools. Add the marketplace once, then install any tool below with `/plugin`.

```
/plugin marketplace add farnell/claude-plugins
```

| Tool | What it is | Install |
|------|-----------|---------|
| [`adversarial-review`](#adversarial-review) | Claude × Codex adversarial code review (file or PR) | `/plugin install adversarial-review@claude-plugins` |

> **Note on workflows.** Most tools here install cleanly via `/plugin`. `adversarial-review` is built on a Claude Code **workflow**, which the plugin system can't auto-load — so it has one extra one-line step (copy the workflow file into `~/.claude/workflows/`). It's called out in its install steps below.

---

## adversarial-review

Two models review the same target and argue until they agree. **Codex (`gpt-5.5`)** produces an initial review; **Claude** independently audits each finding against the source, sends a critique back, and the loop repeats for up to N rounds. The result is synthesized into confirmed findings, a disputed set, and prioritized actions — and **every `file:line` citation is machine-checked against the repo** so a hallucinated reference can't be labelled "confirmed".

- Reviews either a **markdown file** (`docs/architecture.md`) or a **GitHub PR** (`260`).
- **Resumable** — state persists to `~/.claude/adversarial-review-state/`, so you can approve more rounds or answer a question and it continues rather than restarting.
- **Optional** `--comment` (PR only) posts the synthesis as a single summary comment, updated in place on re-run.

### Prerequisites

Assumes you already run both, authenticated:

- **Claude Code** — the host (this is a Claude Code tool).
- **[Codex CLI](https://github.com/openai/codex)** — the second reviewer (`codex exec` must work).
- **[`gh` CLI](https://cli.github.com/)** — only for PR targets and `--comment` (needs repo scope).

The Bash permissions the workflow needs (`codex exec`, `gh`, `mktemp`, …) ship in the plugin's `settings.json` and are applied automatically when the plugin is enabled.

### Install

```bash
# 1. add the marketplace (once)
/plugin marketplace add farnell/claude-plugins

# 2. install the command + permissions
/plugin install adversarial-review@claude-plugins

# 3. drop in the workflow engine (the one manual step — workflows can't ship in a plugin)
curl -o ~/.claude/workflows/adversarial-review.js \
  https://raw.githubusercontent.com/farnell/claude-plugins/main/adversarial-review/workflows/adversarial-review.js
```

### Usage

```
/adversarial-review 260                     # review PR #260
/adversarial-review docs/architecture.md    # review a file
/adversarial-review 260 --comment           # review a PR and post the synthesis as a comment
/adversarial-review continue                # approve more rounds from the last checkpoint
```

Tuning (optional): pass `effort` (`low`|`medium`|`high`|`xhigh`|`max`) and/or `model` to change the Codex reasoning tier. Defaults are **`high` for PRs, `medium` for files**.

### Hardening / known work

Security and correctness hardening for the review loop is tracked here: **https://github.com/farnell/claude-plugins/issues/2**. (Codex currently ingests untrusted PR content under a prompt-level guard rather than a sandbox, and citations resolve against the working tree rather than the PR head — both are being tightened.)

---

## Development

The workflow inlines byte-for-byte copies of the pure helpers in `adversarial-review/dev/core.ts` (the workflow runtime forbids `import()`). A drift-guard test extracts the inlined block and asserts behavioural parity, so the two copies can never silently diverge.

```bash
npm install
npm test
```

## License

[MIT](LICENSE)
