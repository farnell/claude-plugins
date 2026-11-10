# Ralph policy — the PR pipeline contract (every stage reads this)

> **This is the core policy, the same for every repo.** Each repo adds an **addendum** (its path
> is `addendum` in the repo's `.claude/ralph.json`; your stage prompt names it): that repo's
> guardrails, house rules, what a merge to `main` does there, and anything else specific to it.
> Read both; where the addendum is more specific, it wins. Commands are named, not spelled out:
> your stage prompt says what **SETUP**, **TYPECHECK**, **TESTS `<files>`** and **MERGE GATE**
> are in this repo, and **RALPH** `<helper>` means `node "<ralph plugin>/lib/<helper>.ts"` (plain
> node: the helpers need no install).

One policy for every roadmap Ralph grinds. Each task becomes **one PR** that moves through
fresh-context stages, each a separate agent in its own worktree:

```
code, lane full:   red → implement → check → review → merge
code, lane light:        implement → review → merge                   (= size:"small", since 2026-11-02)
docs / measure:          implement → [blind-check] → review → merge   (verify:"manual" → parks for Matt)
lane human (gate): never run — Matt does it; ticked from its done_when evidence (below)
```

**docs/measure have no separate check stage** (since 2026-10-12): their review does the check
duties itself (§review). On the first real run the check stage only re-confirmed what review then
re-checked, at a full agent's cost. **`blind-check`** runs only for a `measure` task whose ledger
entry says `blind_check: true` (§blind-check).

**The merge stage is a script first** (since 2026-11-02): a Haiku relay agent runs RALPH `merge`,
which runs the repo's merge guard (if it has one), catches the branch up (resolving the routine
ledger-only conflict itself), runs the MERGE GATE (through the repo's gate wrapper, if it has one,
e.g. a machine-wide lock), waits for the PR's CI if the repo gates on it, and squash-merges when
all is green. Only a conflict it can't resolve, a red gate or CI, a refused guard or an error
reaches the Sonnet merge agent (§merge), and that agent is told what the script already found. A
`busy` gate wrapper (another heavy job on this machine) skips the task for the run instead of
failing it.

**Light code tasks** (`lane: "light"`, or the older `size: "small"`) have no red and no check stage: implement
writes the tests with the code, and review does the check duties (§review). A fresh stage agent
starts with ~40k tokens of fixed context, so these two stages were most of a small task's cost.

**Every stage agent is a fresh agent that sees only its prompt** (`agentType: 'general-purpose'`
in `ralph-loop.js`). It has no conversation with Matt: on the first run every stage answered a
chat question Matt had asked the parent session. Act only on the prompt, this policy and the PR.

**Before a run** the workflow runs RALPH `preflight` (plain node, so it works on a broken
install): it loads and validates the repo's adapter (`.claude/ralph.json`), removes stale stage
worktrees, then stops with a plain message if free disk is under the repo's floor (adapter
`minFreeGb`, default 25 GB; `RALPH_MIN_FREE_GB` overrides) or if the repo's install probe does
not run non-interactively (for example pnpm wants to reinstall `node_modules` and has no terminal
to ask). **After each stage** the loop removes that stage's worktree (RALPH `worktrees remove
<path>`) if it is clean and
pushed; one that is not is kept and listed in the run result's `keptWorktrees`. Removal deletes
every git-ignored file too, so a worktree holding any ignored file other than `node_modules`, the
`.env*` symlinks or build output (`.next/`) is also kept: **save results you need to keep in a
tracked file and commit it, never only in an ignored directory.**

**Gates tick themselves.** A human gate or decision has no PR, so nothing in the stages above ever
ticks it. Each open gate carries a `done_when` evidence check from a fixed, anchored list
(RALPH `gate-checks`; table in `authoring-guide.md` §"Gates tick themselves"), plus any check
types the repo adds through its adapter (`gateChecks`, judged by the repo's own command). At the
start of every run the workflow's Gates step runs RALPH `tick-gates --apply`: it reads the
evidence (read-only), ticks every gate whose deps are done and whose checks all pass, and lands
the tick on `origin/main` through an auto-merged ledger-only PR (branch `ralph-gates/<slug>-<ts>`).
A stage agent never ticks a gate, and never writes `done_when`. A check may name another repo
(`"repo": "owner/name"`), so a gate can wait for another repo's PR to merge, reach that repo's
prod (when the adapter knows how to read it), or its issue to close.

A failed `check` or a `review` asking for changes sends the task back to `implement`; a
`redo-red` review (a bad red test, code tasks only) sends it back to `red`. The
**3rd failed check or 3rd `changes`/`redo-red` verdict** parks it as `blocked`, so two fix rounds get acted on.

**Where the state lives.** Nowhere in a session. It is (a) the ledger JSON **on `origin/main`**,
where a task's own PR ticks it `done`, and (b) **marker comments** on the task's PR, one per
finished stage. RALPH `next-step` reads both and names the next stage. A killed run, or a
brand-new session, resumes exactly where the last one stopped. **So your stage is not finished
until its marker comment is posted. Post the marker last, and only when the stage really
succeeded.**

| Marker (an HTML comment in a PR comment) | Posted by | Means |
|---|---|---|
| `<!-- ralph:red sha=<sha> files=<a,b> -->` | red | failing acceptance tests are pushed; `sha` = the red commit, `files` = its test files (check's baseline) |
| `<!-- ralph:implemented sha=<sha> -->` | implement | implementation pushed at `<sha>` |
| `<!-- ralph:check result=pass\|fail -->` | check (and merge, on a red merge gate: `stage=merge`) | pushed head re-verified from scratch |
| `<!-- ralph:blind-check result=pass\|fail -->` | blind-check | an agent that never saw the grades re-did the blind check; `fail` = it disagreed beyond the task's bar |
| `<!-- ralph:review verdict=approve\|changes\|redo-red -->` | review | Opus review of the diff; `redo-red` (code only) sends a bad red test back to red |
| `<!-- ralph:blocked reason=<word> -->` | any stage, always inside the plain-language comment from RALPH `blocked-comment` | gave up (guardrail / unfixable); parks the task |
| `<!-- ralph:retry -->` **or a comment that is just `retry`** | **Matt only. A stage agent never posts either.** | un-parks a blocked task; clears its counters |

A `fail` from check or blind-check counts toward the same 3-failure limit.

**How to post a marker:** `gh pr comment <n> --body-file <file>`, **never `gh pr review`**: the
pipeline reads PR comments only, and GitHub refuses approve/request-changes on your own PR anyway.
One marker per comment, as its **last line**, with exact values (`result=pass`, never a template like
`pass|fail`); only the last marker in a comment counts. Put the human-readable detail (test list,
failures, findings) above it.

To restart a task whose PR was closed: `gh pr reopen <n>`, then comment `retry`.

**A PR Matt merges by hand counts as done.** The implement stage ticks the ledger inside the PR,
so his merge lands the tick on main and the next run skips the task.
That is the other way out of a block: fix the cause, then merge the PR yourself.

**The relayed chat message is the trigger, not your task.** The Workflow harness shows every stage
agent the last chat message Matt sent in the session that launched the run, as "the user request".
It is often not about the run at all: run 2 on 2026-10-13 was launched right after Matt answered a
product question with "remove it", and the preflight read that as its only instruction, saw that
preflight deletes worktrees, and refused, so the run did nothing. Ralph can't change what the
harness relays. So every prompt in `ralph-loop.js` opens with the same paragraph (`TRIGGER`):
sending that message is what started the run; don't answer it, act on it, or refuse over it; do
the job in the prompt. The parent session launches only in the same turn as a bare `/ralph <doc>`
message (skill Step 5). Pinned by the plugin's `dev/__tests__/ralph-loop-workflow.test.ts`.

---

## Shared rules (every stage)

### Setup: your worktree, a detached HEAD, never a local branch

1. You start in a fresh git worktree. Run **SETUP** first (your stage prompt lists it: typically
   the install, and any `.env` symlink from the main checkout the addendum asks for).
2. `git fetch origin --quiet`. Work on a **detached HEAD**:
   - task branch exists → `git switch --detach origin/<branch>`;
   - it doesn't (red, or the first stage of a docs/measure task) → `git switch --detach origin/main`.
3. Publish with `git push origin HEAD:refs/heads/<branch>`. **Never create a local branch:**
   worktrees share refs, so a local branch left checked out in a dead worktree blocks every later
   stage (`already checked out`).
4. End with a clean tree (`git status --porcelain` empty), everything pushed, and report your
   worktree's path (`git rev-parse --show-toplevel`) as `worktreePath`. **The loop deletes your
   worktree after you finish**: anything not pushed or posted on the PR is gone. A dirty or
   unpushed worktree is kept instead and listed for Matt, which is a leak, not a save.

### Git

- Scoped `git add <files>` only, never `-A` / `.`. Never commit to or push `main`. Never
  force-push and never rebase a pushed branch: to catch up with main, **merge** `origin/main` into
  the branch (the squash-merge flattens it anyway).
- Commit message: `ralph(<slug>): <what> [<task id>]`, with the repo's attribution trailer.
- Never `git commit --amend` a pushed commit.

### Ledger conflicts when merging `origin/main`

Task PRs all edit the ledger JSON and its rendered `.md`, so merging main into a task branch can
conflict there when another task merged meanwhile. Resolve it the same way every time: take
`origin/main`'s versions of both files, re-apply **only this task's** tick (its `status`,
`attempts`, `notes`, `updatedAt`), and re-render the `.md` with
RALPH `render-ledger <ledger.json>`. Any other conflict you can't resolve
trivially → the stage fails (check: `result=fail`; merge: `result=fail stage=merge`).

### Reading: only your slice

Read your task's section of the feature doc, found **by its heading** (line numbers are a hint),
plus any issue it names (`gh issue view <n>`). A task that batches several sections has a
pointer listing each (`<doc> §S12 — lines A,B; §S13 — lines C,D`): read every one, and every
section's acceptance applies. Never read the whole roadmap. If the task and its
issue disagree, the issue wins: say so in the PR.

### Guardrails: stop, post `ralph:blocked`, return `blocked`

Never do any of these, even if the task seems to ask for it. Ledger tagging is the first layer,
your judgement is the second.

- **apply a migration** (`db:migrate`, a push of the schema, deploy-script DDL). *Writing* one is
  fine. If merging a migration applies it somewhere in this repo, the addendum says so, and the
  merge guard decides which ones Ralph may merge (§merge step 0).
- **any live-DB write or data change**: backfills, grants, reloads, `--apply` modes, hand SQL.
  Read-only queries are fine where the addendum allows them.
- **flip a flag or env var on**, **change a hosting / auth / payments setting**, **deploy by
  hand**, **restart a worker**, or **SSH to a remote host**. A merge to `main` is the only change
  Ralph lands, through the merge stage only (what that merge deploys, if anything, is in the
  addendum); it never runs a release or ship script.
- **touch another repo**: a change there is its own PR in that repo, and a task that needs one
  waits on it through a gate (`"repo": "owner/name"`).
- **hand-edit a live DB**.
- anything the addendum adds to this list.
- **spend money outside the subscription** (OpenRouter/DeepInfra/paid APIs) beyond a cap the task
  states explicitly. Standing approval (Matt, 2026-10-27): a task may state a cap of
  **up to $3** without a human gate. Anything larger is a gate. Estimate before spending, stop at the
  cap, and record the actual spend in the PR.

If a stage can only be finished by crossing one: revert your uncommitted edits, post the blocked
comment (below) with `--reason guardrail` (if a PR exists), and return `blocked`.

### The blocked comment: plain words first, then the marker

Every block — guardrail, environment, failure limit, conflict — is posted with the helper, never
as a bare marker. Matt reads these, and on the first run he was told to type an HTML comment he
did not understand.

```
node "<ralph>/lib/blocked-comment.ts" --reason <guardrail|env|limit|conflict|too-big|other> \
  --why "<one plain sentence: what went wrong, no internal jargon>" \
  [--fix "<what Matt should do>"] [--detail-file <file with commands/output>] > body.md
gh pr comment <n> --body-file body.md
```

It renders "**Ralph stopped on this PR.** Blocked because …", then "To continue: fix it, then
either merge this PR yourself, or reply `retry` and run `/ralph` again", the details folded away,
and the `<!-- ralph:blocked reason=… -->` marker as the last line.

### House rules that bite autonomous edits

CLAUDE.md binds you; the addendum names the rules that bite autonomous edits most in this repo.
Don't fix unrelated things; note them in the PR.

### What `verify` means

- `gate`: TYPECHECK + the task's tests: red's and the ones the implementer added. Not
  a shell command.
- `manual`: no command. The PR is checked for consistency and reviewed, then waits for Matt.
- anything else: a shell command; run it as written.

### Tests you may run

TYPECHECK, the task's own tests (TESTS `<files>`), its `verify` command, and (merge stage only)
the full MERGE GATE plus single-file re-runs of its failures. Earlier stages never run the full
gate: it is the merge stage's. The addendum may add or rule out commands.

A test that depends on the machine (free disk, the clock, the network) rather than the code is a
test bug: note it in the PR and in an issue, never "fix" it by loosening what it checks.
(2026-10-12: a test read the host's real free disk and went red below 20 GB; the fix injected
the free space, the 20 GB guard itself stays tested.)

---

## red — failing acceptance tests (code tasks only)

1. Detach at `origin/main`. Read the slice and its issue.
2. Write the acceptance as **real failing tests** (`it(`, never `it.todo`) at an entry point that
   already exists or that the spec names: an exported decision function, a CLI, a route. Test
   behaviour, not internals. Where the function doesn't exist yet, import the name the spec
   gives; the implementer may change signatures, never assertions.
   - **Expected values come from outside the code.** Use a literal, a worked example or a number
     the spec states. Never compute the expected value the way the code will (`expect(add(a, b))
     .toBe(a + b)`), and never assert a constant equal to itself. A test like that passes by
     construction and can never catch a bug. Two kinds are exempt, because comparing one
     implementation against another is their whole point: an executed TS↔SQL parity test (the
     SQL twin's rows checked against the TS function's output) and a test that a derived list
     matches its source (e.g. a CHECK vocabulary derived from an array).
   - **Test through the entry point only.** Don't mock the code's internal helpers, call private
     functions, or check the result through a side channel the task isn't about (reading a table
     a route happens to update instead of the route's response). When the table IS the output,
     a loader's own table or a SQL twin's rows, querying it is the entry point. A test that breaks
     when the internals are rewritten but the behaviour is unchanged is testing the wrong thing.
   - **Keep red to the acceptance.** Write the few tests that prove the task's acceptance, not
     every edge case. Tests written before the code exists describe behaviour you imagined; the
     more of them red locks in, the more chances one is wrongly shaped. The implementer adds the
     detailed tests (implement step 3).
   - **A do-nothing implementation must fail.** Tests that only expect `false`, `null`, an error
     or an empty result pass against code that rejects everything. Each acceptance item needs at
     least one case that a do-nothing or always-reject implementation would fail.
3. Run them; confirm they fail **for the right reason** (missing behaviour, not a typo or a
   broken import elsewhere). A failed import of the module the spec names is the right reason:
   the module doesn't exist yet. Don't add stub files to turn it into an assertion failure.
   Touch no implementation code.
4. Commit with the message `⛔ do-not-merge: red` (the commit message only; it doesn't go in the
   PR body), push to `<branch>`, open a **draft** PR
   (`gh pr create --draft --base main --head <branch>`). Title: `ralph(<slug>): <title> [<id>]`.
   The body: the task pointer, the acceptance, the test files, and a **Seams** list: each entry
   point the tests go through, with one line on what it catches and one on what it misses. Review
   checks that list (review step 2).
5. Comment: the number of tests written, the failing count the runner reports (they can differ:
   a failed import fails the whole file as one), the test paths, then
   `<!-- ralph:red sha=<your pushed commit> files=<every test file you wrote, comma-separated> -->`.
   The marker is how check finds red's commit and files: both values must be exact.

If the branch/PR already exists (a previous red died midway), reuse it.

**Redo** (the latest `ralph:review` says `verdict=redo-red`): review found bad red tests.
Reuse the existing branch and PR; open nothing new.
1. Detach at `origin/<branch>` (it holds the implementation; don't start from `origin/main`).
2. Rewrite ONLY the tests the review names, as it says, following step 2's rules. Touch no other
   test and no implementation code. If a rewrite renames a test or changes what it covers, update
   that test's lines in the PR body (test list and Seams); change nothing else in the body.
3. The rewritten tests may already pass against the existing implementation; that's fine. Run
   them and report which pass and which fail. Implement still runs next either way: it must post
   a fresh `ralph:implemented` marker, which check needs.
4. Commit `⛔ do-not-merge: red (redo)`, push, and comment the tests you changed, pass/fail for
   each, then `<!-- ralph:red sha=<your pushed commit> files=<the test files you changed,
   comma-separated> -->`. Check takes its baseline from this marker and guards every red test
   file named on any red marker, so the unchanged ones stay covered.

## implement — make it real

1. Detach at `origin/<branch>` (docs/measure with no PR yet: at `origin/main`, then open the
   draft PR at the end as in red step 4).
2. If this is a fix round, read the **latest** `ralph:review`, `ralph:check` or
   `ralph:blind-check` comment and fix exactly its blocking items. **After a red redo** (the latest
   marker is a `ralph:red` that follows an earlier `ralph:implemented`): make the rewritten red
   tests pass, fix any blocking items the `redo-red` review listed for you, refresh the PR body's
   test list, counts and Seams, and always post a fresh `ralph:implemented`, even when there was
   nothing to fix: check needs that marker to match the new head. With no file to commit, the
   marker's `sha=` is the current branch head (red's redo commit); don't make an empty commit
   (editing the PR body with `gh pr edit` is not a commit).
   Act on the review's notes only where they name something you can fix (the body, a count).
3. Make the red tests pass **without weakening an assertion**. A harness-only test change is
   allowed but must be named in the PR body. For `code`, work in small steps: write one failing
   test of your own for the next piece of behaviour, write just enough code to pass it, repeat.
   Your own tests follow the same rules as red's (red step 2): expected values from outside the
   code, through an entry point, no mocking internals. Put them in new test files and never edit
   red's, so "red's tests are unchanged" stays a byte-for-byte comparison. For a decision the
   spec left open, the expected value is your recorded decision (step 6). Don't refactor code the task doesn't
   need; review may raise a refactor as a note. For `measure`, run the measurement (read-only) and
   record the numbers in the doc section the task names. For `docs`, write the doc.
   **Never do a "blind" or independent check of your own grades** — you have seen them, so it
   is not blind. If the task has `blind_check: true`, leave it to the blind-check stage (say in
   the PR which file holds the inputs and which holds your grades). If the slice asks for one and
   the task has no `blind_check`, say so in the PR so review flags the ledger.
4. Run TYPECHECK (skip for a docs-only diff), the task's tests (red's and your own), and its `verify`
   command. All must pass before you push.

   **Light code tasks** (`lane: "light"` / `size: "small"`, no red stage): with no PR yet, detach at `origin/main` and
   open the draft PR at the end as in red step 4. You write the acceptance tests yourself, to red
   step 2's rules (expected values from outside the code, through an entry point, no mocked
   internals), in the same PR, and list them with the **Seams** in the PR body. If the work turns
   out to belong in the full lane (a migration, money / auth / data-write / time-zone logic, core
   decision logic, security), stop and post the blocked comment (`--reason too-big`, "this task
   needs the full lane; set its lane to full in the ledger and reply retry"). Size alone is not a
   reason: a light task may batch several sections. Don't carry on unreviewed.
5. **Tick the ledger in this PR:** set the task's `status:"done"`, bump `attempts`, set
   `updatedAt`, one-line `notes` (PR number). Change no other task. Then re-render the `.md`:
   RALPH `render-ledger <ledger.json>`. The tick lands on main when the PR
   merges, and that is what marks the task done. (For a `verify:"manual"` task the merge is Matt's,
   so his merge *is* the review.)
6. Update the PR body: which tests cover which behaviour (CLAUDE.md rule), and any harness change.
   Keep red's **Seams** list (code tasks), adding any entry point your own tests go through; if
   red left it out, write it. Where the spec leaves a behaviour open (red's Seams "misses" often
   name these), pick the simplest reasonable answer, test it, and list it in the PR body under
   **Decisions the spec left open**. Test counts in the body and comments must match what the
   runner reported.
7. Push, then comment: the tests run and how many passed, any new test files, and any open
   decisions you took, then `<!-- ralph:implemented sha=<git rev-parse HEAD> -->`.

## check — verify the pushed head, trusting nothing reported (code tasks only)

docs/measure tasks and small code tasks skip this stage; their review runs steps 1–5 below itself
(a small code task has no red guard to run: step 4 is TYPECHECK + the PR's tests + `verify`).

1. Detach at `origin/<branch>`. Its head must equal the `sha=` on the latest `ralph:implemented`
   marker, **or** that sha must be an ancestor of the head with every later commit a merge of
   `origin/main` (an earlier check or merge stage caught the branch up). Anything else fails
   ("pushed head differs from the reported sha").
2. If `origin/main` has moved, merge it in (no rebase; ledger conflicts per the shared rule),
   re-run SETUP's install if the lockfile changed, and push.
3. **Migration numbers:** any numbered migration this PR adds must not reuse a number on
   `origin/main` (for drizzle: `drizzle/NNNN_*.sql`, and `drizzle/meta/_journal.json` must have
   unique `idx`es). A collision → fail. The addendum adds any schema-drift rule this repo has.
4. Run TYPECHECK, the task's tests (code: red's and the implementer's), and the task's `verify` (see "What `verify`
   means"; for `manual` just confirm the PR does what the slice says it records). For code, also
   run the **red guard**: the exact git commands in your stage prompt. The pipeline builds them
   from the red markers (`next-step.ts` `redFactsOf`), so never search commit messages for red's
   commit. They check that:
   - the latest red commit is on this branch (`git merge-base --is-ancestor`);
   - no red assertion was weakened since it (`git diff <latest red>..HEAD -- <every red test
     file named on any red marker>`);
   - after a redo, the redo stayed in scope (`git diff <previous red>..<latest red> -- <red test
     files>` changes only the tests the `redo-red` review named; a renamed or rewritten test
     counts as that test).
   Anything else → fail.
5. Check the ledger tick: exactly this task flipped to `done`, nothing else changed.
6. Comment the evidence + `<!-- ralph:check result=pass -->` or `result=fail` (with what failed).
   **A fail is a successful check stage:** return `done`.

## blind-check — an independent second judge (measure tasks with `blind_check: true`)

A measure task that grades a sample (is this company id right? is this search result relevant?) often
needs a blind live check: a second judge who has **not** seen the first grades. On the first run
(G1) the implement agent could not spawn a subagent, so it did its own "blind" check, which is
not blind. This stage is that second judge, as a fresh agent that never saw the grades.

1. Detach at `origin/<branch>`. Read the slice and its issue. From the PR, find the **inputs**
   only: the sample file / ids and the question being judged. **Do not open the implement stage's
   grades, its verdict columns, or its summary numbers yet** (skip those files and PR comments).
2. Judge every item in the sample yourself, from the inputs and the live sources the slice names
   (read-only). Write your verdicts to the file the slice names for the blind pass (or
   `<sample>-blind.<ext>` beside the sample), then **commit that file before step 3**, so the
   commit order shows you judged first.
3. Now open the implement stage's grades. Compare item by item. Record the agreement rate and the
   disagreements (each with both answers and your evidence) in the PR comment.
4. `result=pass` when agreement meets the bar the slice states (default: ≥ 90% agreement, and no
   disagreement the slice calls critical). Otherwise `result=fail`: the task goes back to
   implement, which must re-examine every disagreement, not just adopt either side.
5. Push, then comment the comparison + `<!-- ralph:blind-check result=pass -->` or `result=fail`.
   A fail is a successful stage: return `done`.

## review — Opus, against the task, not taste

**docs / measure tasks: do the check duties first.** These kinds have no check stage, so before
reviewing, run check steps 1–5 yourself (pushed head equals the `sha=` on the latest
`ralph:implemented`, merge `origin/main` if it moved, run the task's `verify` command — for
`manual`, confirm the PR records what the slice says — and confirm exactly this task's ledger
tick). Any failure there is a blocking finding (`verdict=changes`).

**Light code tasks: do the check duties first, too.** No red and no check stage ran, so run
check steps 1–5 yourself (step 4 = TYPECHECK + the PR's tests + `verify`; there is no red guard).
Then review the implementer's tests as strictly as you would red's (red step 2): they are the
task's only acceptance tests. Also confirm the task still fits the light lane (no migration, no
money / auth / data-write / time-zone / core decision logic, nothing security-sensitive); if it
doesn't, that is blocking: say the ledger task needs `lane: "full"`. A light task's review
never returns `redo-red` (there is no red stage); a bad test is an ordinary `changes` finding.

**A measure task's blind check must not be self-done.** If the slice asks for a blind or
independent check and the PR shows the implement agent did it itself (and no `ralph:blind-check`
stage ran), that is a blocking finding: say so, and say the ledger task needs `blind_check: true`
(a ledger refresh, not something this PR can fix by redoing the check itself).

1. Read the slice, its issue, and `gh pr diff <n>`. After a red redo, review the whole PR again,
   not just the redo; check has already confirmed the redo stayed in scope.
2. Review for: does it do what the task's acceptance says (no more, no less); CLAUDE.md rules
   (the addendum names the ones that matter most here; tests ship with code);
   correctness bugs; risk the PR doesn't name. For `code`, also check the tests against red
   step 2's rules (expected values from outside the code, through the entry point, no mocked
   internals), and check the PR body's **Seams** list.
   - A bad test the **implementer** added, a missing Seams list, or a seam that tests the wrong
     boundary (an internal helper when the spec names a CLI or route) is **blocking**: the
     implementer can fix all of these.
   - A bad test from **red** (code tasks) gets verdict **`redo-red`**: name each bad test and
     what it should assert instead. The implementer may not change red's assertions, so a
     `changes` round can't fix it; `redo-red` sends the task back to red, which rewrites only the
     named tests (red §Redo), then implement and check run again. If the same review also has
     implementer findings, list them too: implement fixes them after the redo. A redo counts as a
     review round, so it shares the three-round limit with `changes`.
   - A decision the PR lists under **Decisions the spec left open** is a **note** if you'd have
     chosen differently. It is **blocking** only if it contradicts the spec or the acceptance.
   - A test that requires something the spec doesn't ask for (say, a runtime freeze where the
     spec only says "readonly") is a **note**. So is a stale Seams entry (a "misses" line a later
     test now covers).
   - Test counts in the PR body or the implement comment that don't match what the runner reports
     are **blocking**: the body is the evidence review and Matt rely on, and the implementer can
     fix it.
3. Classify each finding **blocking** (wrong, unsafe, misses acceptance, breaks a rule) or
   **note**. Only blocking findings justify `changes` (or `redo-red` for a bad red test). Don't
   block on style.
4. Comment the findings, then `<!-- ralph:review verdict=approve -->`, `verdict=changes` or
   `verdict=redo-red`.
   Return `done` with `verdict` set.
5. On `approve` for a `verify:"manual"` task, also run `gh pr ready <n>`: the PR now waits for
   Matt to read and merge, so it should not still look like a draft.

## merge — land it

**What a merge does in this repo** is in your stage prompt and the addendum (a deploy to staging
or prod, a migration applied by CI, or nothing). That is the one change Ralph lands, and only
here, after check and an approving review.

**The script did the happy path.** You run only when RALPH `merge` handed the PR back, and your
stage prompt says what it found: a `red` gate (its first full run is done: start at step 2's red
path with the failing files it lists, never re-run that first gate), a red CI with a green local
gate (step 2's red path, from the CI failure), a TYPECHECK failure (never a flake: back to
implement), a refused guard (step 0), a `conflict` it could not resolve (do step 1 yourself), or
an `error` (do the whole stage). If the repo has a gate wrapper (a machine-wide lock), any full
MERGE GATE you run goes through it, as the addendum shows.

0. **The merge guard** (only if this repo has one: your stage prompt names it). It decides which
   PRs Ralph may merge at all (the app's: only purely additive migrations). It prints
   `{ok, reasons}`. `ok: true` → carry on. **Anything else parks** (`ok: false`, or the command
   fails): post the blocked comment with `--reason guardrail`, a plain `--why` with its reasons,
   and a `--fix` like "check it is safe, then merge this PR yourself", and return `blocked`.
   Matt's merge lands the ledger tick (a PR Matt merges counts as done). Never judge it yourself
   in place of the guard: the default is park.
1. Detach at `origin/<branch>`; merge `origin/main` in if it moved (ledger conflicts per the
   shared rule) and push. You may now be on a head nobody checked; step 2 covers it.
2. Run TYPECHECK and the MERGE GATE on that head, and, if this repo gates on CI (your stage prompt
   says so), wait for the PR's CI (`gh pr checks <n> --watch`); a red CI check is red like a local
   failure. If anything is red:
   - **Flake first — but passing alone proves nothing.** A failure that depends on test order or
     shared state always passes when its file runs alone, so a solo pass is never a flake verdict.
     The decision is `decideFlakes` in RALPH `known-flakes`; call it at each step and do what its
     `next` says, rather than judging yourself:
     a. Look the failing files up in the known-flakes list **as merged on main**
        (`F=$(mktemp); git show origin/main:<KNOWN FLAKES> > "$F"`, then
        RALPH `known-flakes check --file "$F" <file>...`).
     b. Re-run each failing file once, alone, with nothing changed, then
        RALPH `known-flakes decide --first <a,b> --alone-failed <the ones that failed again>`.
        `next=attribute` → a real failure (next bullet). `next=full-rerun` → (c).
     c. Re-run the FULL MERGE GATE once, then `decide` again with the same flags plus
        `--full-passed` (green) or `--full-failed <files>` (red). `next=attribute` → a real
        failure: attribute it (next bullet) and record nothing. `next=record` → every first-run
        failure was a flake; carry on to step 3 and record them at step 4, after the merge.
     Being on the list never excuses a failure: only a passing full re-run does.
   - **Flake rows never go on the task branch.** Recording them there pushes an unreviewed commit
     into a feature PR, and two PRs bumping the same row conflict. They go on the one standing
     branch `ralph/known-flakes` (`KNOWN_FLAKES_BRANCH`) after the merge — see step 4.
   - **Attribute it before blaming the PR** (CLAUDE.md): run the failing test files at `origin/main`
     in the same worktree (`git switch --detach origin/main`, run, switch back).
     - They fail there too → environmental or pre-existing (a broken install, low disk, a DB or
       CI outage, a heavy job holding the machine). Post the blocked comment with `--reason env`
       and a plain `--why` (for example "the tests also fail on main, so this PR did not break
       them"), with both runs in `--detail-file`, and return `blocked`.
     - They pass on main → the PR broke them. Comment the failures +
       `<!-- ralph:check result=fail stage=merge -->` (back to implement) and return `done`.
3. `gh pr ready <n>`, then `gh pr merge <n> --squash --delete-branch`.
4. **Only if `decide` said `next=record`:** record the flakes on the standing branch, in the same
   worktree. `git fetch origin`, then `git switch -C ralph/known-flakes origin/ralph/known-flakes`
   if that branch exists (and `git merge origin/main`), otherwise
   `git switch -C ralph/known-flakes origin/main`. For each file run
   RALPH `known-flakes record --file <KNOWN FLAKES> --test <file> --symptom "<what failed>"
   --evidence "PR #<n>: <first-run error> / full re-run passed"`, commit ONLY the known-flakes
   file, and `git push -u origin ralph/known-flakes`. If `gh pr list --head ralph/known-flakes
   --state open` shows a PR, the push updated it; otherwise `gh pr create --base main --head
   ralph/known-flakes --title "ralph: known flakes" --body "<plain summary + evidence>"` (not a
   draft: it is Matt's to read and merge). Never merge it yourself. A failure here does not undo
   the merge; mention it in your result.
5. Report any migration file the PR added as `migrationAdded`. **You never apply it.** What
   happens next is the repo's (adapter `merge.afterMigration`): the loop either carries on (the
   merge already applied it where the addendum says) or stops the run (`migration-pending`) so
   no later task tests against an un-migrated DB.

---

## Ledger hygiene

- The ledger JSON is canonical; the `.md` is rendered from it by RALPH `render-ledger` and
  never edited by hand.
- Only the implement stage writes the ledger, and only its own task's fields. The one other writer
  is `tick-gates.ts`, which only flips open gates to `done`.
- Status enum: `todo | in_progress | done | blocked | awaiting_review | batched`. The pipeline
  only ever sets `done`. `batched` (+ `batched_into: "<host>"`) marks a task folded into another
  task's PR: closed like `done`, and a dep on it is a dep on its host. Only a ledger refresh sets
  it; the host's PR ticks only the host. `blocked` / `awaiting_review` survive only from older
  ledgers and park the task.
- Every runnable task carries a `kind` (`code | docs | measure | decision`). The authorability
  validator enforces it.
- A code task carries a `lane`: `full` (standard route) or `light` (= `size: "small"`); gates are
  lane `human`. The lane sets the size; older ledgers may carry `size: "small" | "standard"`
  instead (absent = standard). The validator refuses `small` on any kind but code.
- A code task may carry `files` (the repo paths it edits) and `unbatched` (why it stays a separate
  PR from a same-file neighbour); the validator uses them to refuse an unbatched small same-file
  pair (authoring guide §Batch by default).
