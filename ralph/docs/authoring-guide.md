# Ralph — feature-doc authoring guide (the authoring contract)

This is the **authoring contract**: how to write a `feature.md` so the Ralph loop can grind it to a
finished feature. It is read two ways —

- by a **human** authoring or reviewing a feature doc, and
- by the **`/ralph` skill** at derivation time (it applies these rules when it turns your doc into a
  ledger, and refuses to proceed on a doc that violates the hard ones).

It is the derivation-side mirror of [`ralph-policy.md`](ralph-policy.md) (which governs each
*stage* of the PR pipeline). Keep it small — it's loaded every derivation. The `/ralph --scaffold <name>` command
emits [`feature-template.md`](feature-template.md), a skeleton that already satisfies this contract.

---

## The one principle

**Every task must have an explicit, honest "done" signal.** The pipeline's whole value (red tests,
an independent check of the pushed head, an Opus review) evaporates on a task it can only *self-grade*.
A task with no machine-checkable done is the single most-documented Ralph failure: the agent ticks
the checkbox, confidently wrong. So the authorability validator **hard-blocks** an under-specified
task at derivation rather than letting it shallow-pass mid-run.

The lever that most determines output quality is the **specificity of each task's acceptance
criteria + `verify`**. If the spec is vague, the result is vague.

---

## The `kind` declaration (what pipeline a task gets)

Every runnable task declares a `Kind:`. It decides the stages the task goes through:

| `kind` | Stages | `verify` allowed |
|---|---|---|
| `code` | lane `full`: red → implement → check → review → merge; lane `light`: implement → review → merge (§Lanes) | `gate` or a test command. **Never `manual`**: code is proven by its red tests; split anything judged by eye or measured on a live box into a `measure` task |
| `docs` | implement → review (which also does the check) → merge | an artifact check command, or `manual`. **Never `gate`**: tsc + tests prove nothing about prose |
| `measure` | implement (run read-only measurements, record the numbers) → [blind-check] → review (which also does the check) → (manual: Matt merges) | a check command, or `manual` |
| `decision` | none: Matt decides | must be `HUMAN-GATED` |


### Lanes: how much pipeline a code task gets (Ralph decides)

At derivation `/ralph` triages every runnable code task into a **lane** and records it in the
ledger with a one-line `lane_reason` (from ledger version 3 the validator requires the lane). You
don't have to write one: an optional `Lane: full` or `Lane: light` line in a section overrides
Ralph's call. (An old `Size: small` line reads as `Lane: light`.)

| Lane | Stages | For |
|---|---|---|
| `full` | red → implement → check → review → merge | money, credits, billing, pricing; auth, sessions, tokens, permissions; data writes and every migration; time / date / timezone logic; core decision logic or a TS↔SQL twin; a new shared source of truth; security; whatever the repo's addendum lists as never-light |
| `light` | implement → review → merge (= `size: "small"`) | UI markup, copy, layout, styling; wiring an existing endpoint or component; removals; a11y attributes; guard tests; CLI flags, scripts, env overrides; a route that only reads an existing table |
| `human` | none: Matt's step | every gate and decision |

Each skipped stage is a fresh agent that starts with ~40k tokens of fixed context, so light
roughly halves a task's cost. Light is the default for code; full is earned by risk. A light task
still gets an Opus review of every line, and its implement agent writes the tests with the code;
what it loses is the *independent* red tests, which have caught real bugs in risky code, hence
the full lane for it.

The validator: an unknown lane; `human` on a non-gate or a gate in another lane; `full` on a
non-code task; `full` + `size: "small"` or `light` + `size: "standard"` (the lane sets the size;
don't write both); `light` on a task that adds a migration (a migrations / drizzle / `.sql` path
in `files`, or "migration" in the title). It warns when a light task's wording looks like full
territory (credits, auth, timezone, …), when a lane has no `lane_reason`, and when light tasks
could ship as fewer PRs (§Batch by default). `size: "small"` stays valid on old ledgers, only on
code tasks.

**A tiny doc is one PR.** If after triage there are no `full` tasks and at most two light
batches (gates aside), `/ralph` folds every runnable section into one task: one implement
agent, one review, one PR, through the normal loop (never in the chat session).

### Batch by default

Every task costs ~3–5 fresh agents, each starting with ~40k tokens of fixed context, and reviews
are LLM-run, so a PR covering 2–3 related sections is fine. **A doc section is a unit of spec; a
ledger task is a unit of PR.** At derivation, group related `code` sections into one task covering
**up to ~3 sections**: the same feature area or panel, the same `files`, or a direct dep chain
(e.g. a data loader + the help page that shows it; a panel rebuild + its chart; three cleanup /
copy edits in one component). Every runnable code task lists the repo-relative paths it expects to
edit in **`files`** (best effort, from its sections).

**The batch shape.** Title `X and Y (S12 + S13)`; pointer `<doc> §S12 — lines A,B; §S13 — lines C,D`.
The stages read every listed section, and every section's acceptance applies. `files` is the union;
`deps` is the union minus the members; the batch is `light` only if every member would be
light, else `full`.

**Light work is swept harder.** Light sections need not share files to share a PR: every light
section that waits on the same open gates goes into as few tasks as the ~150-line cap allows (and
never two that have another open task between them in the dep graph). The validator warns with a
suggested grouping when light tasks could ship as fewer PRs. A dep that only existed to serialize two members on a shared file goes away.

**Keep a task on its own when:**
- it carries a migration (or the repo's addendum says never-batch);
- it is a human gate or decision, or the chain between the members crosses one (the gate has to
  happen between them);
- the kinds differ (a `docs` or `measure` section doesn't join a `code` task);
- the combined slice is over ~150 lines (the summed pointer ranges; the span warning says so);
- there is a stated reason: `"unbatched": "<reason>"` on the task.

**What the validator enforces** (both apply to runnable, not-done, not-gated `code` tasks that
share a path in `files` where one depends on the other through `deps`, directly or through other
tasks but never through a gate):
- at least one of the pair light (`size: "small"`) → **error**: merge them;
- both full / standard → **warning**: consider batching them.

Either is silenced by a non-empty `"unbatched": "<reason>"` on either task (an empty string still
errors). A runnable small code task with no `files` can't be checked, so it warns.

In the feature doc, put tiny same-file changes under one heading (or say `Batch with S12`) so the
derivation needn't guess.

### Folding a task into another mid-run (`status: "batched"`)

To batch tasks after the ledger is live (even while a run is going), **fold** them; never delete
a row. On the folded task set `"status": "batched"` and `"batched_into": "<host id>"`, and keep the
row. On the host: extend the title and pointer to list the folded sections, union in the folded
task's `files`, and add any of its `deps` the host doesn't already wait on (the deps validator
errors if the host misses one, or still depends on a task folded into it). A dep elsewhere on the
folded task now means its host; you may leave it or repoint it. Re-render and land the ledger PR.

A batched row is closed: the loop never runs or parks it, `render-ledger` shows it as
`↪ batched into <host>`, and the planner counts it apart from the open tasks, so the run carries
on. (2026-11-10: a fold that deleted two rows stopped a run with "open tasks dropped from 13 to 11
with 0 merge(s)".) Rules: fold only a task with no open PR (close it first), fold into a host that
is not a gate and not itself batched, and never fold a gate.

### Blind checks in a `measure` task: `Blind check: yes`

If a measure task grades a sample and its method calls for a **blind** or **independent** check
(a second judge who has not seen the first grades, e.g. "a blind Opus live check on every
disagreement"), add a `Blind check: yes` line. The ledger then carries `"blind_check": true` and
the task gets a `blind-check` stage: a fresh agent that judges the sample from its inputs alone,
commits its verdicts, and only then compares (policy §blind-check). Without it, the only agent
left to do the check is the one that made the grades, which is what happened in G1 (2026-10-12).
Name in the section which file holds the sample inputs, where the blind verdicts go, and the
agreement bar (default ≥ 90%). The validator refuses `blind_check` on any kind but `measure`.

The validator hard-blocks a runnable task with no `kind`, an unknown `kind`, a `decision` that isn't
gated, `code` + `manual`, and `docs` or `measure` + `gate`. A `done` task (older ledgers) needs no `kind`.

## The `verify` declaration (the core rule)

Every task declares how its "done" is checked. For a **non-gated** task, `verify` must be exactly
one of:

| `verify` value | Meaning | Lifecycle |
|---|---|---|
| a **concrete command** (e.g. `pnpm vitest run src/lib/foo.test.ts`, `test -f x && grep -q "## API" x`) | the task-specific machine check; the check stage runs it with the typecheck + the red tests | pass + approved review → auto-merged (and whatever a merge does in this repo) |
| `"gate"` | the typecheck + the task's red tests fully verify it (the normal **code** case); the full merge gate (and the PR's CI, where the repo gates on it) runs before merge | pass + approved review → auto-merged |
| `"manual"` | there is **no** machine check; a human must confirm it | the PR is checked and reviewed, then **parks** for Matt to read and merge, never auto-merged |

`verify: null` is valid **only for a `human_gate` task** (which is never auto-run anyway). A non-gated
task with `verify: null`/omitted is a **hard error** — you must consciously choose one of the three
above. That conscious choice is the point: it removes the ambiguity where `null` could mean "the gate
covers it" *or* "I forgot / there's no real check."

**Two hard rules the validator enforces on `verify`:**
- `"gate"` is only allowed when the feature has a **real** `verifyCmds` (something beyond a trivial
  `["true"]`). A doc/roadmap feature with no real gate **can't** use `"gate"` — its tasks need a
  concrete artifact check or `"manual"`. (This is what stops a doc grind from silently self-grading.)
- `"manual"` never merges autonomously. It's the honest home for a genuinely-unverifiable
  task (subjective prose, a judgment call): Ralph does the work and a human confirms it. There is no
  path where an unverifiable task ticks to `done` on the agent's word.

### Doc/roadmap grinds specifically

The default gate (`tsc` + `test`) proves **nothing** about prose. So for a doc deliverable, give each
task a `verify` that proves the artifact:

```
Verify: test -f docs/x.md && grep -q "## Required Section" docs/x.md
```

Name the exact output file and the headings/content it must contain; add multiple `grep`s for
multiple required sections. Keep tasks narrow ("write §4 with a request/response table", not "write
the doc"). Use `"manual"` only when the task is genuinely a judgment call — and expect to review it.

### Code tasks that add a migration, or wait on another repo

What a merged migration does differs by repo (applied to a staging DB by CI, or written now and
applied later by a human gate), and so does how a task waits on another repo. **The repo's
addendum** (`addendum` in `.claude/ralph.json`) says how to author for both. The general rule:
put a schema change + its migration in its **own small task**, so if it parks only that PR does;
and make another repo's change a human gate whose `done_when` names that repo's PR with `"repo"`
(`{"type": "prod-includes", "pr": 1601, "repo": "owner/other"}`, or `pr-merged` / `issue-closed`
with the same `repo`). Ralph never edits another repo.

---

## The eight rules

1. **One clean decomposable structure at the top.** Give the skill a task list it can map 1:1 —
   best is a **workstream table** (`| ID | Workstream | State |`, reusing `W1`/`E3` ids) **or** a
   **checkbox list** with one `###` section per box whose heading *matches the box text* (so the
   pointer locates the slice by heading). A pure-narrative doc makes the skill **stop and ask** —
   it won't fabricate tasks.
2. **Size each section to "one sentence without *and*."** Good: "add a column + migration", "add
   one route handler + its Zod schema", "add tests for module X". Write sections small and let the
   derivation batch related ones into a PR (§Batch by default); a section that bundles unrelated
   features is still the most common authoring mistake (and trips the span warning).
3. **Behavioral, testable acceptance criteria — never "works correctly."** State the observable
   outcome: *"`POST /api/foo` with a valid body returns 200 `{ok:true}`; 400 on a bad body; 401
   with no session."*
4. **Give every task a `Verify:` line** (per the table above). This is the loop's red/green for that
   task. No `Verify:` → the skill can't set an honest `verify` → the task hard-blocks.
5. **State dependencies explicitly** — in prose ("depends on W1") and/or a "Sequencing" section.
   Deps must form a DAG (the dep validator rejects cycles/self-deps/dangling refs).
6. **Flag collisions.** If two tasks edit the same file, say so ("serializes on `src/foo.ts`") so
   they get a stable ordering edge.
7. **Use human-gate vocabulary for anything irreversible/prod**, in its **own** task. The skill
   keys on: "human's deliberate step", "migration apply" / `db:migrate` / `db:push`, "flip the
   flag" / any `*=1` cutover, a hosting / auth / payments setting or env var, "deploy" / a ship or
   release script, "live DB" / a backfill / a grant, any change in another repo, and whatever the
   repo's addendum lists.
   *Writing* the gated code is fine and not gated; only *applying / enabling / deploying* is. Put the apply step in its own task
   so the code tasks grind and the apply step parks. **Nobody ticks a gate by hand:** each one
   carries a `done_when` evidence check (see "Gates tick themselves" below), and Ralph ticks it at
   the start of the next run once the evidence exists.
8. **Write declaratively (desired end state), and say how you'll test "done."** If you can't state
   the end state and its test, the loop can't know when it's finished — and neither can you.

---

## The per-task shape

```markdown
### W2 — add `POST /api/foo` route (depends on W1)
Add a thin route handler (Zod body, logic in `src/lib/foo.ts`) returning `{ ok: true }`.
Acceptance: 200 `{ok:true}` for a valid body; 400 on a bad body; 401 with no session.
Kind: code
Verify: pnpm vitest run src/lib/foo.test.ts
```

- Heading matches the checkbox/table id + title (so the pointer can locate it).
- Explicit dep in prose.
- Behavioral **Acceptance**.
- A **Verify:** line → the task's `verify` (here a concrete command; use `gate` if the feature suite
  covers it, or `manual` if it's a judgment call).
- A **`Kind:`** line (`code|docs|measure|decision`).
- For a `measure` task whose method needs a second, independent judge: a **`Blind check: yes`**
  line (see "Blind checks" above).
- An optional **`Model:`** line (`opus|sonnet|haiku|fable`) pins the implement-stage model for THIS
  task; otherwise `--model` (red and review always run on Opus). Use it to put a stronger model on the core
  packets and a cheaper one on the periphery within ONE grind. Effort is not settable.

The full runnable skeleton (checkbox summary + one section per task + a human-gated task) is
[`feature-template.md`](feature-template.md) — copy it via `/ralph --scaffold <name>`.

---

## Gates tick themselves (`done_when`)

A human gate or decision is never run by the pipeline, so no PR ticks it. Instead every open gate
carries a `done_when`: one check, or a list that must **all** pass. At the start of every run
Ralph's `tick-gates` reads the evidence (read-only), ticks the gates that passed through an
auto-merged ledger PR, and the work queued behind them runs in the same run.

Checks come from a **fixed list**, each tied to a specific anchor, so a check can't be satisfied
by the wrong event (a deploy from last week, before the code that needed it merged):

| `type` | Fields | Passes when |
|---|---|---|
| `pr-merged` | `pr`, optional `repo` | the PR is merged (e.g. Matt merges a manual or parked PR) |
| `prod-includes` | `pr`, optional `repo` | prod contains the PR's merge commit. How prod is read is the adapter's `prod`, per repo: a **GitHub Deployment environment** (the newest successful one, e.g. Vercel Production) or a public **`/health` URL**'s `commit`. Another repo's ancestry goes through GitHub's compare API |
| `issue-closed` | `issue`, optional `repo` | the GitHub issue is closed |
| `doc-contains` | `file`, `text` | the file on this repo's `origin/main` contains the text (a recorded decision; text inside an HTML comment does not count) |
| *repo-provided* | the repo's | a check type the repo adds (adapter `gateChecks.types`, e.g. the API's `migration-applied` / `sql-true`), judged by the repo's own command. The addendum documents them |

`repo` is `"owner/name"`; without it a check reads this repo (the adapter's `repo`).
`prod-includes` works only for a repo the adapter's `prod` lists. A type the repo does not
provide is rejected by the validator.

Typical shapes: a PR Matt merges = `{pr-merged, pr}`; a ship check = `{prod-includes, pr}`;
waiting on another repo's change = `{prod-includes, pr, repo: "owner/other"}`; a decision =
`{issue-closed}` or `{doc-contains}`.

**Prefer evidence that appears by itself.** The best check is one that turns true as a side effect
of Matt doing the step: `pr-merged`, `prod-includes` or `issue-closed` (here or in another repo),
or a repo check on a table the work itself writes. A `doc-contains` on a log file is evidence
somebody has to type. On the first run (2026-10-12) every decision gate waited on `doc-contains`
in a log file that did not exist and that no task wrote, so Matt would have hand-written the
evidence for each one.

For a decision or measurement Matt rules on, use `doc-contains` only when **Ralph writes the line
for him**: at the end of a run, the report shows each waiting decision gate with the exact line
it needs ("G2 — Decision: …") and offers, from Matt's one-line answer in chat, to write that line
into the file and open (and, docs-only, merge) the PR. Point the check at a file that exists on
`origin/main` (or one a task in the same ledger writes). The authorability validator **warns** on
a `doc-contains` whose file is on neither.
Where the PR number isn't known yet at derivation, anchor on the gate's issue or a date, and the
ledger refresh after that PR lands can tighten it. A gate also needs its `deps` done before it can
tick, however good its evidence looks.

The skill derives `done_when` from the gate's section (a `Done when:` line wins). Any read failure
fails closed: the gate just stays waiting.

---

## What the authorability validator checks

Ralph's `validate-ledger-authorability` runs at derivation (the skill) and in the workflow
preflight. Two tiers:

**Hard errors (block the run):**
- a non-gated task with no `verify` (null / omitted / empty);
- `verify:"gate"` under a feature with no real `verifyCmds`;
- a non-string `verify`;
- a malformed task (missing `title` or `pointer`);
- a runnable task with a missing/unknown `kind`, a non-gated `decision`, `code` + `"manual"`, or
  `docs`/`measure` + `"gate"`;
- `blind_check` on a task that is not `measure`, or a non-boolean `blind_check`;
- an unambiguous apply/deploy command (`db:migrate`, `drizzle-kit migrate`, plus the repo's own
  list: adapter `forbiddenCommands`) in a **non**-`human_gate` task;
- an open gate (`human_gate` or `decision`) without a valid `done_when` (including a type this
  repo does not provide, a repo-provided check its own validator rejects, a malformed `repo`, or
  `prod-includes` for a repo with no prod reader), or a `done_when` on a task that is not a gate;
- `size` that is not `small | standard`, or `small` on a task that is not `code`;
- a lane problem: an unknown `lane`; no `lane` on a runnable code task in a `ledgerVersion` ≥ 3
  ledger; `human` on a non-gate or a gate in another lane; `full` on a non-code task; `full` +
  `size: "small"`; `light` + `size: "standard"`; `light` on a task that adds a migration;
- a malformed `files` (not an array of strings) or a non-string `unbatched`;
- an **unbatched same-file pair**: two runnable `code` tasks, at least one `small`, sharing a path
  in `files`, one depending on the other (directly or transitively, not through a gate), and
  neither carrying a non-empty `unbatched` reason — merge them (§Batch by default);
- a malformed fold (deps validator): a `batched` row with no / unknown / self / batched / gate
  `batched_into`, `batched_into` on a row that isn't batched, a batched gate, a host that still
  depends on a task folded into it, or a host that doesn't wait on a folded task's deps.

**Warnings (advisory, never block):**
- a runnable task whose pointer slice spans over ~150 lines — a multi-section pointer counts the
  sum of its ranges, so a sensible 2–3 section batch doesn't warn; split it or batch fewer;
- a runnable light (`small`) code task with no `files` (the batching check can't see it);
- a light task whose wording looks like full-lane territory, or a lane with no `lane_reason`;
- light tasks waiting on the same gates that could ship as fewer PRs within the span cap (with a
  suggested grouping);
- two runnable **standard** code tasks sharing a path in `files`, one depending on the other (not
  through a gate), with no `unbatched` reason — consider batching them;
- softer prod-touching wording ("deploy", "production", "flip flag", …) in a non-gated task —
  confirm it only *writes* code; if it applies/deploys, gate it;
- a gate's `doc-contains` check on a file that is not on `origin/main` and that no task in the
  ledger names (title / pointer / verify / notes) — evidence nobody will create (CLI only; it
  asks git).

Warnings are surfaced so you can act on them; they don't stop the grind. Errors do — fix the doc (or
the derived ledger) and re-derive until it's clean.
