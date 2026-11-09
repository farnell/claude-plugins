# Ralph known flakes

Merge-gate tests that failed and then passed when the FULL merge gate was re-run with nothing
changed. Passing when the file is re-run alone does not count: a failure that depends on test
order or shared state always passes alone. The Ralph merge stage reads this (as merged on main)
before blaming a PR, and adds a row (or bumps the count) with evidence each time it proves one.
Rules: the Ralph plugin's `docs/ralph-policy.md` §merge.

Rows are recorded on the standing `ralph/known-flakes` branch and its one open PR for Matt to
merge, never on a task's branch.

Being listed never excuses a failure: the full re-run must still pass. The list only tells the
merge stage to re-run first, and makes a test that flakes often visible so someone fixes it. A row
whose count keeps growing is a bug to fix, not a list to grow.

Edit it with the helper (`<ralph>` = the Ralph plugin's directory), not by hand:

```
node <ralph>/lib/known-flakes.ts check <test-file>...
node <ralph>/lib/known-flakes.ts decide --first <a,b> [--alone-failed <c>] [--full-failed <d> | --full-passed]
node <ralph>/lib/known-flakes.ts record --test <file> --symptom "<what failed>" --evidence "PR #<n>: <first run> / full re-run passed"
```

| Test file | Symptom | Times seen | Last seen | Evidence |
|---|---|---|---|---|
