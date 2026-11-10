# Ralph — the PR pipeline grinder

Ralph grinds a feature/roadmap markdown file into **merged PRs, one per task**. Each task moves
through stages, and each stage is a **fresh agent in its own worktree**:

```
code, lane full:  red → implement → check → review → merge
code, lane light:       implement → review → merge                   (= size:"small")
docs / measure:         implement → [blind-check] → review → merge   (verify:"manual" parks for you)
lane human (gate): you do it; Ralph ticks it from its done_when evidence (lib/tick-gates.ts)
```

Ralph triages every task into a lane itself when it derives the ledger: `full` for money, auth,
data writes, migrations, time zones and security; `light` for UI, copy, wiring and removals; and
it sweeps light work into as few PRs as the gates allow. A tiny doc becomes one PR.

- **red** (Opus) writes the acceptance as real failing tests and opens a draft PR.
- **implement** (Opus, or the task's `Model:`) makes them pass and ticks the ledger *in the PR*.
- **check** (Sonnet) re-verifies the *pushed* head from scratch: sha match, merge of main,
  migration-number collisions, typecheck + red tests + `verify`, no weakened assertions.
- **review** (Opus) reviews the diff against the task, its issue and CLAUDE.md.
- **merge** is a script first (`lib/merge.ts`): the repo's merge guard, catch up with main, the
  merge gate (through the repo's lock, if it has one), the PR's CI if the repo gates on it, then
  squash-merge. A Sonnet agent runs only when the script hands a PR back.

A failed check or a `changes` review goes back to implement; the 3rd of either parks the task as
`blocked`. Named after the "Ralph Wiggum" technique: the loop is dumb and deterministic, the
intelligence is per stage.

## Install

Needs **Node ≥ 22.18** (native TypeScript type stripping: every helper runs as plain `node`).

```
/plugin marketplace add farnell/claude-plugins
/plugin install ralph@farnell-plugins
```

Then set a repo up once with **`/ralph --init`**: it writes the repo's adapter
(`.claude/ralph.json`, see [`docs/adapter.md`](docs/adapter.md)), a policy addendum and a
known-flakes list, as one PR.

## Run it

```
/ralph docs/my-roadmap.md --dry-run   # derive + validate the ledger, print the plan
/ralph docs/my-roadmap.md             # land the ledger on main, then grind
/ralph docs/my-roadmap.md --max 30 --model sonnet
/ralph --scaffold my-feature          # start a feature doc from the template
```

**Resume = run it again, from any session.** The loop holds no state that matters: each step a
Haiku relay agent (Sonnet on a recheck) runs `lib/next-step.ts`, which reads the ledger JSON **on `origin/main`** and the
**marker comments** on each task's PR (`ralph:red`, `ralph:implemented sha=…`, `ralph:check
result=…`, `ralph:review verdict=…`, `ralph:blocked`, `ralph:retry`). A stage's last act is
posting its marker, so progress is durable the moment it happens.

**Un-park a blocked task:** fix the cause (the PR's last comment says what it is), then either
merge the PR yourself (that counts as done) or reply `retry` on it and re-run `/ralph`.

The orchestrator is the `ralph:ralph-loop` **Workflow** (JavaScript): agent results come back as
small JS values, so the session that launched the run does not grow with the grind.

## Core vs repo

| | Where | What |
|---|---|---|
| **Core** (this plugin) | `skills/ralph/SKILL.md` | `/ralph`: derive the ledger, land it, launch the workflow, report. |
| | `workflows/ralph-loop.js` | Preflight → gates → plan/stage loop → one report. Plumbing only. |
| | `lib/*.ts` | Every decision, unit-tested; plain `node`, no install (`node:` imports and `.ts` siblings only). |
| | `docs/ralph-policy.md` | The contract every stage reads. |
| | `docs/authoring-guide.md`, `docs/feature-template.md` | How to write a doc the pipeline can grind. |
| **Repo** | `.claude/ralph.json` | The adapter: commands, merge semantics, prod readers, extra gate checks, forbidden commands ([`docs/adapter.md`](docs/adapter.md)). |
| | the addendum (e.g. `docs/ralph/repo-policy.md`) | The repo's guardrails, house rules, gate list, `done_when` examples. |
| | `docs/ralph/<slug>-LEDGER.{json,md}`, `docs/ralph/known-flakes.md` | The repo's state. |

| Helper (`lib/`) | Role |
|---|---|
| `next-step.ts` | Pure `nextStep(ledger, prs, skip, ctx)` + a CLI that fetches the inputs. |
| `validate-ledger-{deps,authorability}.ts` | Fail loud on a bad graph or an under-specified task. |
| `preflight.ts`, `worktrees.ts` | Adapter check, stale-worktree sweep, free-disk floor, install probe; remove each stage's worktree. |
| `gate-checks.ts`, `tick-gates.ts`, `repo-check.ts` | Read a gate's `done_when` evidence (GitHub, the adapter's prod readers, the repo's own checks) and tick passing gates through an auto-merged ledger PR. |
| `merge.ts` | The scripted merge stage. |
| `blocked-comment.ts`, `known-flakes.ts`, `render-ledger.ts` | The plain-language block comment; the flake list; the ledger `.md`. |
| `adapter.ts` | Load + validate `.claude/ralph.json`. |

## Safety

- **Guardrails** are layered: the ledger tags human gates; the authorability validator
  hard-blocks an apply/deploy command (core list + the adapter's `forbiddenCommands`) in an
  untagged task; every stage refuses a guardrail at runtime (policy §Guardrails + the addendum),
  posts `ralph:blocked` and stops.
- **No self-grading:** check re-verifies the pushed head; review is a separate Opus agent; the
  merge gate re-runs on the final head.
- **Merges are the only change Ralph lands.** What a merge does (deploy, migrate) is the repo's,
  stated in its adapter and addendum; Ralph never runs a release or ship script.
- **Serial.** One stage at a time.

## Developing Ralph

Tests live in `dev/__tests__/` (excluded from the version gate) and run with the marketplace's
`npm test`. `ralph-loop-workflow.test.ts` drives the workflow with a fake `agent()`.
