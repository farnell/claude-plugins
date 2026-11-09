---
name: ralph
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/*" *)
  - Workflow(ralph:ralph-loop)
description: Grind ANY feature/roadmap markdown file to completion as a PR pipeline — per task, red tests → implement → check → Opus review → merge, each stage a fresh agent in its own worktree, with all state on GitHub so any session can resume. Use when the user runs `/ralph <feature.md>` or asks to "Ralph", auto-grind, or work through a roadmap/plan/task doc to done. Derives a machine ledger from the doc, tags kinds and human gates, lands it on main, then drives the deterministic ralph-loop Workflow.
---

# Ralph — the PR pipeline grinder

`/ralph <feature.md> [flags]` turns a feature doc into merged PRs. Per task:

```
code:            red → implement → check → review → merge
code, small:           implement → review → merge                   (size:"small")
docs / measure:        implement → [blind-check] → review → merge   (verify:"manual" parks for Matt)
decision / gate: Matt does it; Ralph ticks it itself once its done_when evidence exists
```

(docs/measure review does the check duties itself; `blind-check` runs only for a measure task with
`blind_check: true`.) Each stage is a fresh agent (no parent conversation) in its own worktree,
removed when the stage ends; the `ralph-loop` Workflow (JavaScript) sequences
them, so **this session's context does not grow with the grind**. The loop keeps no state: the
ledger on `origin/main` plus marker comments on each task's PR are the whole state, and
`next-step` reads them. **Resuming is just running `/ralph <doc>` again, in any session.**

**Ralph is a plugin; each repo adds an adapter.** The plugin (this skill, the `ralph-loop`
workflow, the helpers in `lib/`, the core policy) is the same everywhere. Everything about THIS
repo is in two files it owns:

- **`.claude/ralph.json`** — the adapter: repo name, commands (typecheck, tests, merge gate,
  worktree setup), what a merge does, the merge guard, migrations, how to read prod, extra gate
  check types, forbidden commands. Reference: `${CLAUDE_PLUGIN_ROOT}/docs/adapter.md`.
- **the addendum** (its path is the adapter's `addendum`, usually `docs/ralph/repo-policy.md`) —
  this repo's guardrails, house rules, human-gate list, `done_when` examples and what a merged
  migration means. **Read it before Step 2**: it is where "what must be gated here" lives.

The core contract every stage follows is `${CLAUDE_PLUGIN_ROOT}/docs/ralph-policy.md`; read it
before anything non-obvious. Every helper is plain node on the plugin, no install needed:
`node "${CLAUDE_PLUGIN_ROOT}/lib/<helper>.ts"` (written **RALPH `<helper>`** below).

You do the judgement-heavy bootstrap ONCE (Steps 1–4), then hand off.

## Step 0 — parse the invocation

- `<path.md>`: the feature doc (required unless `--scaffold`). No path → ask which doc.
- `--scaffold <name>`: copy `${CLAUDE_PLUGIN_ROOT}/docs/feature-template.md` to `docs/<name>.md`
  (refuse if it exists), point the user at `${CLAUDE_PLUGIN_ROOT}/docs/authoring-guide.md`, STOP.
- `--init`: set this repo up for Ralph (no adapter yet): write `.claude/ralph.json` from
  `${CLAUDE_PLUGIN_ROOT}/docs/adapter.md` (ask Matt for anything you cannot read from the repo:
  what a merge deploys, which commands are forbidden), an addendum, and
  `docs/ralph/known-flakes.md` from `${CLAUDE_PLUGIN_ROOT}/docs/known-flakes-template.md`; open
  them as one PR, STOP.
- `--max N`: maxSteps (default 60; a code task is ~5 steps).
- `--model X`: the implement-stage model (default `opus`). A task's `Model:` line wins. Red and
  review always run on Opus (reviews are Opus unless Matt says Fable), check on Sonnet; merge is
  RALPH `merge` relayed by a helper agent, with a Sonnet agent only when it hands a PR back.
- `--dry-run`: derive/refresh + validate the ledger and print the plan (plus what
  `next-step` says is next, if the ledger is already on main); do not land or run anything.

**No `.claude/ralph.json` in this repo?** Ralph can't run here yet: say so and offer `--init`.

**If the ledger already exists on `origin/main`, the doc hasn't changed since, and both validators
pass on it, skip straight to Step 5.** That's the resume path, no re-derivation needed. An older
ledger that fails them (no `kind`, or an open gate with no `done_when`) goes through Steps 1–4 as a
refresh, which adds what's missing.

## Step 1 — read the doc once, derive tasks

The authoring contract is `${CLAUDE_PLUGIN_ROOT}/docs/authoring-guide.md`. Read the feature doc **once, in full**
(the only full read; every stage reads only its slice). Derive tasks by the first rule that
yields a clean set: explicit checkboxes → a task table → numbered phases → H2/H3 headings. If
none do, STOP and ask the user to point at the task list; never fabricate micro-tasks.

Per task: a stable `id`, a short `title`, a **`pointer`** (`<doc> §<heading> — lines A,B`).

## Step 2 — kind, verify, deps, gates

- **`kind`** (required on every runnable task; from a `Kind:` line in the section, else judge it):
  - `code`: changes behaviour. Gets a red stage. `verify` = `"gate"` (the typecheck + its red and implementer tests) or
    a concrete test command. Never `"manual"`: split the unmeasurable part into a `measure` task.
  - `docs`: prose only. `verify` = an artifact check (`test -f … && grep -q …`) or `"manual"`.
  - `measure`: run read-only measurements and record numbers. Usually `"manual"`, so it parks
    for Matt after review instead of auto-merging. If its method calls for a **blind** or
    **independent** check of the grades (a `Blind check: yes` line, or wording like "a blind live
    check by a subagent"), set `"blind_check": true` so a fresh agent that never saw the grades
    does it. The implement agent can't spawn one and must not self-check.
  - `decision`: Matt chooses. Always `human_gate:true`.
- **`size`** (code tasks only): `"small"` from a `Size: small` line, or by judgement when every
  rule holds; otherwise omit it (= standard). A small task skips red and check: about 2 fresh
  agents instead of 4–5, each of which starts with ~40k tokens of fixed context.
  **When a code task is `small`** (all of these hold): no migration, no change to core decision
  logic or a TS↔SQL twin, no new shared source of truth, nothing that writes a live store, about
  300 changed lines or fewer outside tests, and nothing the addendum lists as never-small.
  Typical: a CLI flag, a script, an env override, a route that reads an existing table, a guard
  test. When in doubt it is `standard`: a wrong `small` loses the independent red tests, which
  have caught real bugs. Print each task's size in the Step 4 plan so Matt can veto one.
- **Batch tiny neighbours.** Two or three small code tasks that touch the same files and ship
  together are one task, not three PRs.
- **`human_gate:true`** for anything a human must own: migration **apply**, live-DB / data writes,
  deploys and release/ship scripts, worker restarts, remote-host runs, flag and env flips, hosting /
  auth / payments settings, any change in another repo (this repo's task waits on it through a
  gate), paid-API spend without an explicit cap, every decision, and everything the addendum adds.
  *Writing* gated code is fine; *applying* it is not. Err toward gating. If one task mixes the
  two, say so and suggest the split. A schema change + its migration is a normal `code` task, but
  keep it small and on its own; the addendum says what Ralph's merge does with a migration here.
- **`done_when`** on every open gate (required; the validator enforces it): the evidence that
  Matt's step has happened, so Ralph ticks the gate itself and **nobody ever ticks the ledger by
  hand**. A `Done when:` line in the section wins; otherwise derive it from what the gate does.
  Pick only from the fixed, anchored check types in
  `${CLAUDE_PLUGIN_ROOT}/docs/authoring-guide.md` §"Gates tick themselves" (`pr-merged`,
  `prod-includes`, `issue-closed`, `doc-contains`; the first three take an optional
  `"repo": "owner/name"`, default this repo) plus any types the adapter adds (`gateChecks.types`;
  the addendum documents them). `prod-includes` works for a repo the adapter's `prod` can read.
  The validator rejects anything else. Anchor each one to the most specific thing you can name:
  the PR a ship must include, the other repo's PR this one waits on, the issue that records a
  decision. A list means every check must pass. Examples (the addendum has this repo's):
  - prod includes W3: `{"type":"prod-includes","pr":170}`
  - Matt merged a parked PR: `{"type":"pr-merged","pr":171}`
  - another repo's change is live: `{"type":"prod-includes","pr":1601,"repo":"owner/other"}`
  - a decision: `{"type":"issue-closed","issue":120}` or `{"type":"doc-contains","file":"docs/x.md","text":"Decision:"}`
  **Prefer evidence that appears by itself** (`pr-merged`, `prod-includes`, `issue-closed`, here
  or in another repo, or a repo check on a table the work itself writes). Use
  `doc-contains` for a decision only on a file that exists on `origin/main` (or that a task in this
  ledger writes), and only because Step 6 offers to write the line for Matt. Never point it at a
  log nobody creates. The authorability validator warns when you do; relay that warning and fix it.
  When the PR to anchor on doesn't exist yet, anchor on the gate's issue or today's date; a later
  refresh can tighten it. Never write a check that the CURRENT state already passes unless the gate
  really is done: run RALPH `tick-gates <ledger>` (dry run) on the landed ledger and
  sanity-read what it would tick.
- **`deps`** from any sequencing section and the collision map; `model` from a `Model:` line.

## Step 3 — write (or refresh) the ledger

`docs/ralph/<slug>-LEDGER.json`:

```json
{
  "feature": { "slug": "...", "title": "...", "featureMd": "<path>",
               "verifyCmds": ["<the adapter's typecheck>", "<the adapter's mergeGate>"],
               "generatedAt": "<today>", "ledgerVersion": 2 },
  "tasks": [
    { "id": "HG-1", "title": "Ship the API endpoint", "pointer": "<doc> §HG-1 — lines 100,108",
      "kind": "code", "status": "todo", "deps": [], "human_gate": true, "verify": null,
      "done_when": { "type": "prod-includes", "pr": 1601, "repo": "owner/other" },
      "attempts": 0, "commit": null, "notes": "", "updatedAt": null },
    { "id": "E2", "title": "...", "pointer": "<doc> §E2 — lines 115,126",
      "kind": "code", "size": "small", "status": "todo", "deps": ["HG-1"], "human_gate": false,
      "verify": "gate", "attempts": 0, "commit": null, "notes": "", "updatedAt": null }
  ]
}
```

Refresh, don't clobber: merge by `id`, keep `status`/`attempts`/`notes`, add new tasks as `todo`,
flag a `done` task whose title/pointer changed materially. Render the `.md` with
RALPH `render-ledger <ledger.json>`.

**Both validators must pass, or STOP and show the errors** (never invent a fake `verify` to get
past one):

```
node "${CLAUDE_PLUGIN_ROOT}/lib/validate-ledger-deps.ts" docs/ralph/<slug>-LEDGER.json
node "${CLAUDE_PLUGIN_ROOT}/lib/validate-ledger-authorability.ts" docs/ralph/<slug>-LEDGER.json
```

Relay the authorability warnings even when it passes.

## Step 4 — land the ledger on main

The pipeline reads the ledger **only from `origin/main`** (every task PR ticks it there).

- If the feature doc itself is still in an open PR, add the ledger (JSON + `.md`) to **that** PR
  and ask Matt to merge it. Stop until he has.
- Otherwise open a PR from `ralph-ledger/<slug>` (outside the `ralph/<slug>/` task namespace)
  with just the two ledger files, then squash-merge
  it once both validators pass (docs-only; no tests to run).

Print the plan: tasks in order, kind, size, which are gated, what runs first.

## Step 5 — run the pipeline

The workflow's preflight runs RALPH `preflight` first: it validates `.claude/ralph.json`,
removes stale stage worktrees, then stops with a plain message on low disk (the adapter's
`minFreeGb`, default 25 GB; `RALPH_MIN_FREE_GB` overrides) or an install that would need a
terminal. You can run it yourself before launching; it prints one JSON line (including the
adapter it read).

**One run per machine at a time is the default.** Two runs can share a machine (a repo whose
merge gate goes through a lock queues rather than overloads it), but they then mostly wait on
each other's gates. If another Ralph run is active, say so and suggest waiting.

**Launch only in the same turn as Matt's `/ralph` message.** The Workflow harness relays Matt's
most recent chat message, verbatim, to every stage agent as "the user request", and Ralph can't
change that. The workflow's prompts tell each agent to treat that message as the trigger, not a
task, but a bare `/ralph <doc>` is the only message that can't confuse them. So:

- If you would launch from any other message (Matt answered a question with "yes" or "remove it",
  or the run is a follow-up you decided on), do NOT launch. Ask Matt to send `/ralph <doc>` as its
  own message, and launch in that turn.
- Any extra text Matt puts in the `/ralph` message (a checklist for the report, notes for you) is
  relayed to every stage too. If he adds some, say once that every stage agent will see it and
  suggest he sends it as a separate message next time; it is safe to go ahead.

```
Workflow({ name: 'ralph:ralph-loop', args: {
  ralphRoot: '${CLAUDE_PLUGIN_ROOT}',
  ledgerPath: 'docs/ralph/<slug>-LEDGER.json',
  maxSteps: <--max or 60>,
  model: '<--model or opus>'
} })
```

`ralphRoot` must be this plugin's directory exactly as written above (the absolute path it
expands to); every helper command the workflow builds starts from it. The main checkout must be
on a commit that has `.claude/ralph.json` (any recent `main` of a repo set up for Ralph).

## Step 6 — report

The workflow returns one object. Lead with `status`:

- `complete`: every task merged. List the PRs.
- `parked`: nothing runnable left. `parked[]` is **Matt's to-do list**: human gates, decisions,
  `awaiting-human` (a manual task's PR is ready for him to read and merge), `blocked` (read the
  PR's last comments), `deps-not-met`. Show it prominently and don't do any of it yourself.
  For gates, show `gatesWaiting[]`: each with what its check still sees ("prod 5c6f3e50 does not
  include PR #170 yet"), which tells Matt exactly what's left. Nobody ticks them: the next run
  does, once the evidence exists.
- **`gatesTicked`**: gates Ralph found done and ticked this run, with the evidence. Always list them.
- **`gatesNoCheck`** (or a `gate-no-check` park reason): an open gate with no valid `done_when`.
  Fix it yourself by refreshing the ledger (Steps 1–4), never by asking Matt to tick it.
- A `blocked` PR whose comment says the merge guard refused it (the app's: a migration that is not
  purely additive): Matt checks it is safe and merges it himself; that merge lands its ledger tick.
- `migration-pending` (a repo whose adapter stops after a merged migration): show `message` — it
  says what to apply — then Matt re-runs `/ralph`.
- `stuck` / `cap-reached` / `error`: show `message` and the last few `history` rows; re-running
  continues from the same place. An `error` now carries the failing helper's real stderr and
  stdout; read them before guessing.
- `preflight-failed`: show `message` verbatim. It is already plain language (low disk, a broken
  install, a missing or invalid `.claude/ralph.json`, missing ledger) and says what to do.
- **`migrationsMerged`**: always surface it if non-empty: migrations Ralph merged this run. The
  addendum says where they are now (e.g. applied to staging, prod at the next release).
- **`keptWorktrees`**: stage worktrees the loop did not delete because they were dirty or
  unpushed. List them; never delete them yourself without looking.

**Decision and measurement gates: offer to write the evidence.** For each waiting gate whose check
is `doc-contains`, show the exact line it needs and ask Matt for his one-line answer. When he gives
it, write that line into the file on a `ralph-gates/<slug>-<date>` branch, open the PR, and (it is
docs-only) merge it; the next run ticks the gate. Matt never hand-edits the file.

**Blocked PRs.** Every blocked PR carries a plain comment saying why and what to do. To un-park
one after fixing the cause, Matt either merges the PR himself (a hand-merged PR counts as done:
its ledger tick lands with it) or replies `retry` on the PR (the bare word as the whole comment,
optionally `retry - <note>`; anything longer, a `Retry: …` sentence, or a second line does NOT count;
the old `<!-- ralph:retry -->` marker still works), then re-runs `/ralph`. Explain it in those
words; never tell him to type an HTML comment.

**Known flakes.** A merge stage that proves a flake (it passed only when the FULL merge gate
was re-run, never on a solo re-run) records it on the standing `ralph/known-flakes` branch and its
one open PR, never on the task's branch. If that PR is open, mention it in the run summary: it is
Matt's to read and merge.

**Answer Matt's chat questions yourself.** The stage agents are fresh and do not see this
conversation, so a question he asks mid-run is yours to answer, not theirs.

## Cost safety

Everything runs on the subscription. Never introduce an `ANTHROPIC_API_KEY` into any step. The
step cap, the 3-failure task limit and the consecutive-failure breaker bound a stuck run.
