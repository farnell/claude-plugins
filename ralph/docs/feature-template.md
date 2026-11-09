# <Feature title> — Ralph feature doc

<!--
  SCAFFOLD — `/ralph --scaffold <name>` copies this file. Fill it in, then run
  `/ralph docs/<name>.md --dry-run` to derive the ledger and see the plan.

  Read the Ralph plugin's docs/authoring-guide.md first, and this repo's Ralph
  addendum (the `addendum` in .claude/ralph.json). The rules that make the loop converge:
    • one clean task list (this checkbox summary), one `###` section per box,
      heading MATCHES the box text;
    • each task sized to ~one context window ("one sentence without 'and'");
    • EVERY non-gated task has a `Kind:` line (code | docs | measure | decision)
      and a `Verify:` line — a concrete command, or `gate` (the typecheck + its
      red tests; code only), or `manual` (Matt reads + merges the PR; never for code);
    • a small, low-risk code task can add `Size: small` (no red, no check stage);
    • deps stated in prose (they must form a DAG);
    • irreversible/prod steps (hosting/auth/payments settings, env flags, live-DB
      writes, deploys, any other-repo change) go in their OWN task, tagged
      HUMAN-GATED — Ralph surfaces them, never runs them;
    • a schema change + its migration is its own small code task (the addendum
      says what Ralph's merge does with a migration in this repo).
  Delete these comments once filled in.
-->

One-paragraph summary of the desired end state and how "done" is tested overall.

## Tasks

- [ ] **W1** — <short imperative title>
- [ ] **W2** — <short imperative title> (depends on W1)
- [ ] **W3** — <apply/deploy step> ← HUMAN-GATED

---

### W1 — <short imperative title>
<What to build. Reference the exact files/modules.>
Acceptance: <observable, testable outcome — not "works correctly">.
Kind: <code | docs | measure>
Verify: <a concrete command, e.g. `pnpm vitest run src/lib/foo.test.ts`; or `gate` if the
feature suite (typecheck + test) covers it; or, for a doc artifact,
`test -f docs/x.md && grep -q "## Section" docs/x.md`; or `manual` for a judgment call>.
Model: <optional — opus|sonnet|haiku|fable; omit to use --model>

### W2 — <short imperative title> (depends on W1)
Only after W1. <What to build.>
Acceptance: <observable outcome>.
Kind: <code | docs | measure>
Verify: <command | gate | manual>.

### W3 — <apply/deploy step>   (HUMAN-GATED)
<The irreversible/production step — e.g. set `FOO_ENABLED=1` in the host's env,
change an auth setting, or ship the change this feature needs in another repo.>
This is a **human's deliberate step** — Ralph must **surface** it and stop; it must
never run it. (Writing the code for it earlier is fine; only applying/deploying is gated.)
Done when: <the evidence Ralph reads to tick it itself — e.g. "prod includes the W2 PR",
"Matt merged the migration PR #45", "owner/other's prod includes its PR #1601",
"issue #123 closed". Optional: Ralph derives one from the step if you leave it out.>
<!-- When there's a decision, record it in the doc or close its issue: that is the
     evidence Ralph checks. -->

