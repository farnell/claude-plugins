# CLAUDE.md — claude-plugins

Personal Claude Code marketplace. One plugin today: **adversarial-review** (a Claude × Codex code reviewer implemented as a Workflow).

## Mental model (read before "just update it")

Merging to `main` updates **nothing** on any machine. Three separate copies exist locally and must each advance:

1. **Marketplace clone** — `~/.claude/plugins/marketplaces/farnell-plugins/` (a git clone of this repo). The version gate reads the plugin version from *here*.
2. **Version-gated cache** — `~/.claude/plugins/cache/farnell-plugins/adversarial-review/<version>/`. Claude Code copies the plugin here per released version; `installed_plugins.json` records which version/dir is active.
3. **Live engine** — `~/.claude/workflows/adversarial-review.js`. **This is what actually runs.** The plugin's `SessionStart` hook `cp`s it from the active cache dir on every session start.

Footguns that cost real time (2026-07-01):
- **There is no `/plugin update` CLI** — typing it just opens the marketplace browser TUI.
- **Auto-update silently no-ops** when the marketplace clone is stale or diverged. This repo **squash-merges** (rewrites history), so the clone routinely diverges from `origin/main` and Claude Code's git-pull gives up quietly → the merged fix never reaches the cache → the live engine stays old.
- A restart alone does nothing useful until the **cache** advances — the hook copies from the still-old active dir.

## Updating your local install after a merge (do this — don't fight the TUI)

```bash
scripts/sync-local.sh
```

One command, idempotent. It resets the marketplace clone to `origin/main` (tolerating squash-merge divergence), rebuilds the cache dir for the released version, repoints `installed_plugins.json`, and syncs the live engine. No restart needed. **Verify:** `grep -c END_SID ~/.claude/workflows/adversarial-review.js` (or whatever token your change added).

Quick path for a **workflow-only** change (most fixes are): the live engine is just a file, so you can also pull it straight from `main` — this is what the README troubleshooting `curl` one-liner does.

Supported-but-flaky TUI path (documented for completeness): `/plugin` → Marketplaces → `farnell-plugins` → Update, then update the plugin, then restart. Prefer the script.

## Releasing a change (maintainer)

1. Edit files under `adversarial-review/` (the workflow engine `workflows/adversarial-review.js` ships bundled — a workflow change releases like any other).
2. **Bump `version` in BOTH** `adversarial-review/.claude-plugin/plugin.json` and the `adversarial-review` entry in `.claude-plugin/marketplace.json` (keep them equal). Updates are version-gated; an un-bumped push is invisible.
   - A tracked `pre-push` hook (`.githooks/pre-push`, active after `npm install`) blocks a push to `main` that changes `adversarial-review/` content without a bump, and blocks a version mismatch. A vitest test asserts the two versions stay equal.
   - The gate scopes to `adversarial-review/` **excluding `adversarial-review/dev/`**. Changes to `README.md`, this `CLAUDE.md`, or `scripts/` are outside the plugin and **do not need a bump**.
3. `npm test` (drift guard + manifest-version). Optionally `claude plugin validate ./adversarial-review && claude plugin validate .`.
4. Commit → PR → merge. Then run `scripts/sync-local.sh` to update your own machine.

## Code layout gotcha — the drift guard

The Workflow runtime forbids `import()`, so `workflows/adversarial-review.js` inlines byte-for-byte copies of the pure helpers from `dev/core.ts` inside a `// <core-mirror> … // </core-mirror>` block. **Edit both copies** — `dev/__tests__/core.test.ts` extracts the block and asserts behavioural parity, so they can't silently diverge. `core.ts`-only exports (e.g. `extractThreadId`) that the workflow doesn't use are not mirrored.
