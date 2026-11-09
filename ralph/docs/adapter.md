# The Ralph adapter — `.claude/ralph.json`

Ralph's core (this plugin) is the same in every repo. Everything that differs lives in the repo,
in two files it owns:

1. **`.claude/ralph.json`** — the adapter (this page): commands, what a merge does, prod readers,
   extra gate checks, forbidden commands. Loaded and validated by `lib/adapter.ts`; the preflight
   prints it, and the workflow builds every stage prompt from it.
2. **The addendum** — a markdown file (`addendum` below) every stage reads after the core policy:
   this repo's guardrails, house rules, human-gate list, `done_when` examples, and what a merged
   migration means here. Where it is more specific than the core policy, it wins.

Plus the repo's data: its ledgers (`docs/ralph/<slug>-LEDGER.{json,md}`) and its known-flakes
list (start it from `known-flakes-template.md`).

A missing or invalid adapter stops a run at the preflight with every problem listed.
`node <ralph>/lib/preflight.ts` prints what it read.

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `repo` | yes | | `"owner/name"`. A gate check with no `repo` reads here. |
| `addendum` | yes | | Repo-relative path of the repo's policy addendum. |
| `knownFlakes` | | `docs/ralph/known-flakes.md` | The known-flakes list. |
| `worktreeSetup` | | `[]` | Shell commands every stage runs first in its fresh worktree (install, `.env` symlinks). |
| `installProbe` | | `""` | Preflight: a command that proves the install runs with no terminal (e.g. `pnpm exec vitest --version`). `""` skips the install check. |
| `commands.typecheck` | yes | | The type check (TYPECHECK in the policy). |
| `commands.testFiles` | yes | | Runs named test files; the files are appended (TESTS `<files>`). |
| `commands.mergeGate` | yes | | The merge stage's full test run (the MERGE GATE is TYPECHECK + this). |
| `merge.note` | yes | | One or two plain sentences: what merging to `main` does in this repo. Shown to the merge stage. |
| `merge.guard` | | `""` | A command run before anything else at merge, `{pr}` replaced by the PR number. Must print JSON `{"ok": bool, "reasons": [..]}`; anything but `ok: true` parks the PR as a guardrail. |
| `merge.gateWrapper` | | `""` | A prefix the full gate runs through (e.g. a machine-wide lock: `pnpm --silent heavy-job run --job ralph-gate --`). |
| `merge.busyExitCode` | | `0` | The wrapper's "busy, try later" exit code. The scripted merge retries until `busyWaitMinutes`, then skips the task for the run. |
| `merge.busyWaitMinutes` | | `4` | |
| `merge.waitForCi` | | `false` | Also wait for the PR's GitHub checks; a failed check is red. |
| `merge.ciTimeoutMinutes` | | `8` | Checks still running after this hand the PR to the merge agent. |
| `merge.vitestJson` | | `true` | The gate is vitest: add a JSON reporter so a red gate names its failing files. |
| `merge.migrations` | | `{dir:"drizzle", pattern:"\\.sql$"}` | Which added files count as migrations (reported as `migrationAdded`). |
| `merge.afterMigration` | | `"continue"` | After a merge that added a migration: keep grinding (`continue`), or end the run as `migration-pending` (`stop`) so no later task tests against an un-migrated DB. |
| `merge.migrationMessage` | | `""` | What the run log (or the `migration-pending` message) says after such a merge. |
| `merge.lockfile` / `merge.install` | | `pnpm-lock.yaml` / `pnpm install --frozen-lockfile --prefer-offline` | Reinstall when catching up with main changed the lockfile (`lockfile: ""` = never). |
| `prod` | | `{}` | `{"owner/name": reader}` for every repo `prod-includes` may read. A reader is `{"kind":"github-deployment","environment":"Production"}` (newest successful GitHub Deployment, e.g. Vercel) or `{"kind":"health-url","url":"https://…/health"}` (its JSON `commit`). |
| `gateChecks.types` / `.command` | | `[]` / `""` | Extra `done_when` types this repo provides, and the command that judges them (below). |
| `forbiddenCommands` | | `[]` | Regex sources (case-insensitive): commands a **non**-gated task may never name. Added to the core list (`db:migrate`, `drizzle-kit migrate`). |
| `minFreeGb` | | `25` | Free disk a run needs. `RALPH_MIN_FREE_GB` overrides. |

## Repo-provided gate checks

`gateChecks.command` is run through the shell as `<command> validate` or `<command> check`, with
**one** check object as JSON on stdin. It prints JSON as its last stdout output:

- `validate` → `{"errors": []}` (shape errors, `[]` when fine). Run by the authorability validator.
- `check` → `{"pass": true|false, "reason": "plain words"}`. Run by `tick-gates`.

Any non-zero exit, missing JSON or missing field **fails closed**: the gate stays waiting (or the
ledger fails validation). The core knows these types by name only; the planner treats a gate
using one as valid exactly when the adapter lists its type.

## Example (an app on Vercel that merges only additive migrations)

```json
{
  "repo": "acme/app",
  "addendum": "docs/ralph/repo-policy.md",
  "worktreeSetup": ["pnpm install --frozen-lockfile --prefer-offline"],
  "installProbe": "pnpm exec vitest --version",
  "commands": { "typecheck": "pnpm typecheck", "testFiles": "pnpm vitest run", "mergeGate": "pnpm test" },
  "merge": {
    "note": "Merging to main deploys to staging and applies new migrations to the staging DB; prod moves only at release.",
    "guard": "node scripts/migration-additive.ts --pr {pr}",
    "waitForCi": true,
    "afterMigration": "continue",
    "migrationMessage": "applied to staging by CI; ships to prod with the next release."
  },
  "prod": {
    "acme/app": { "kind": "github-deployment", "environment": "Production" },
    "acme/api": { "kind": "health-url", "url": "https://api.acme.com/health" }
  },
  "forbiddenCommands": ["\\bdb:push\\b", "\\bvercel\\s+(deploy|--prod|promote)\\b"]
}
```
