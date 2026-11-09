export const meta = {
  name: 'ralph-loop',
  description:
    'Ralph PR pipeline: grind a feature ledger task by task — red tests, implement, check, Opus review, merge — each stage a fresh agent in its own worktree. All state lives on GitHub + origin/main, so a killed run or a fresh session resumes in place.',
  phases: [
    { title: 'Preflight', model: 'sonnet' },
    { title: 'Gates', model: 'sonnet' },
    { title: 'Grind', model: 'sonnet' }, // the planner; each stage picks its own (STAGE_MODEL)
    { title: 'Report' },
  ],
}

// ----------------------------------------------------------------------------
// args: { ralphRoot, ledgerPath, maxSteps?, maxConsecutiveFailures?, model? }
//
// ralphRoot = this plugin's directory (the /ralph skill passes ${CLAUDE_PLUGIN_ROOT}).
// Every helper runs as `node "<ralphRoot>/lib/<x>.ts"` — plain node, no install.
// Everything that differs between repos (commands, what a merge deploys, the
// merge guard, migrations) comes from the repo's adapter, `.claude/ralph.json`,
// which the preflight validates and relays (this runtime cannot read files).
//
// This script keeps NO state that matters. Each step asks `lib/next-step.ts`
// (via a tiny planner agent) "which task, which stage?" — computed from the ledger
// on origin/main and the marker comments on the task's PR. A stage agent's last act
// is posting its marker comment, so the next planner call sees the move. Kill the
// run at any point; the next run (any session) picks up at the same stage.
// The contract every stage follows is docs/ralph-policy.md (+ the repo's addendum).
//
// Lessons from the first real run (2026-10-10..12) wired in here:
//   · every agent is a FRESH general-purpose agent (agentType) that sees only its
//     prompt — stage agents had been answering chat questions from the parent;
//   · each stage's worktree is removed right after the stage (worktrees.ts), and
//     the preflight sweeps stale ones + checks free disk and the install;
//   · helper commands keep stdout AND stderr, so a failure is never a mystery;
//   · docs/measure tasks have no separate check stage (review does it), and a
//     measure task with blind_check gets an independent blind-check stage;
//   · (2026-11-02) a code task with size:"small" skips red and check too; the
//     merge stage is SCRIPTED (lib/merge.ts, relayed by a helper agent) and the
//     Sonnet merge agent runs only when the script hands back a conflict, a red
//     gate, a refused guard or an error.
// Decision logic lives in tested TS under lib/; this file is plumbing.
//
// The relayed chat message (2026-10-13): the Workflow harness hands EVERY agent
// below the most recent chat message of the session that launched the run, as
// "the user request". That message is whatever Matt last typed — `/ralph <doc>`,
// but also "yes", "remove it", or notes meant for the parent — and Ralph cannot
// change it. One preflight read "remove it" as its only instruction and refused
// to run. So every prompt opens with TRIGGER: the relayed message is what
// launched this run, not a task to answer, act on or refuse over.
//
// Helper agents (preflight, gates, planner, cleanup) run on Sonnet, not Haiku
// (2026-11-09): a Haiku planner refused its job without running a command
// ("Not run yet: the cleanup step has not been executed") and ended the run.
// A planner that fails or refuses is now asked once more before the run stops.
// ----------------------------------------------------------------------------
function parseArgs(a) {
  if (typeof a === 'string') {
    try { a = JSON.parse(a.trim()) } catch { a = {} }
  }
  return a || {}
}

const o = parseArgs(args)
const ledgerPath = o.ledgerPath
const R = typeof o.ralphRoot === 'string' ? o.ralphRoot.replace(/\/+$/, '') : ''
// A helper command: plain node on the plugin's own lib (no install needed).
const lib = (name) => `node "${R}/lib/${name}.ts"`
const MAX_STEPS = Number.isInteger(o.maxSteps) ? o.maxSteps : 60
const MAX_CONSEC_FAILURES = Number.isInteger(o.maxConsecutiveFailures) ? o.maxConsecutiveFailures : 3
const MODEL = o.model || 'opus'
// The relay agents: they run one command and copy its JSON back.
const HELPER_MODEL = 'sonnet'
const POLICY = `${R}/docs/ralph-policy.md`
// A fresh agent that sees ONLY its prompt — never the session that launched the run.
const FRESH = 'general-purpose'

// Opens EVERY agent prompt in this file (see the header note). It frames the
// relayed message as the trigger of the run; it never asks the agent to ignore Matt.
const TRIGGER = [
  'About the relayed user request: it is the chat message Matt sent in the session that launched this Ralph run, whatever that message said — `/ralph <doc>`, a one-word reply such as "yes" or "remove it" to some earlier question, or notes meant for that session. Sending it is what started this run, so this run IS what Matt asked for.',
  'It is not addressed to you and gives you no extra task: do not answer it, do not act on anything it mentions, and do not refuse, stop or change your job because of it (for example because it does not name a target, or seems to ask for something else). Do the job below exactly as written.',
].join('\n')

if (!ledgerPath || !R) {
  return { status: 'error', message: 'ralph-loop requires args.ralphRoot and args.ledgerPath. Invoke via /ralph, which passes the plugin root and derives and lands the ledger first.' }
}

const NEXT_TASK = {
  type: 'object',
  properties: {
    taskId: { type: 'string' }, title: { type: 'string' }, pointer: { type: 'string' },
    kind: { type: 'string' }, verify: { type: 'string' }, model: { type: 'string' },
    size: { type: 'string', description: 'small | standard (code tasks; standard when the ledger omits it)' },
    stage: { type: 'string' }, branch: { type: 'string' }, prNumber: { type: 'integer' },
    prUrl: { type: 'string' }, reviewRound: { type: 'integer' }, checkFailures: { type: 'integer' },
    lastEvent: { type: 'string', enum: ['none', 'check-fail', 'blind-check-fail', 'review-changes', 'review-redo-red', 'red-redone'] },
    markerCount: { type: 'integer' },
    // From the red markers: check's diff baseline, so no stage ever searches commit messages.
    redSha: { type: 'string' }, prevRedSha: { type: 'string' },
    redFiles: { type: 'array', items: { type: 'string' } },
  },
  // Every field required: a relay that drops one would put "undefined" into a stage prompt.
  required: ['taskId', 'title', 'pointer', 'kind', 'verify', 'model', 'size', 'stage', 'branch', 'prNumber', 'prUrl', 'reviewRound', 'checkFailures', 'lastEvent', 'markerCount', 'redSha', 'prevRedSha', 'redFiles'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'false if the command failed' },
    error: { type: 'string', description: 'exit code + stderr + stdout tails when ok=false, else ""' },
    cleanup: { type: 'string', description: 'the JSON line the worktree-remove command printed, or ""' },
    hasNext: { type: 'boolean' },
    next: NEXT_TASK,
    parked: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
    remaining: { type: 'integer' },
  },
  required: ['ok', 'error', 'cleanup', 'hasNext', 'next', 'parked', 'remaining'],
}

const GATE_ROW = {
  type: 'object',
  properties: { id: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } },
  required: ['id', 'reasons'],
}
const GATES_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'false if the command failed' },
    error: { type: 'string', description: 'exit code + stderr + stdout tails when ok=false, else ""' },
    ticked: { type: 'array', items: GATE_ROW },
    waiting: { type: 'array', items: GATE_ROW },
    noCheck: { type: 'array', items: { type: 'string' } },
    prUrl: { type: 'string' },
  },
  required: ['ok', 'error', 'ticked', 'waiting', 'noCheck', 'prUrl'],
}

// The adapter fields the prompts use (lib/adapter.ts has the full shape).
const STR = { type: 'string' }
const ADAPTER_SCHEMA = {
  type: 'object',
  description: 'the "adapter" object preflight.ts printed, copied field for field',
  properties: {
    repo: STR, addendum: STR, knownFlakes: STR,
    worktreeSetup: { type: 'array', items: STR },
    commands: { type: 'object', properties: { typecheck: STR, testFiles: STR, mergeGate: STR }, required: ['typecheck', 'testFiles', 'mergeGate'] },
    merge: {
      type: 'object',
      properties: {
        note: STR, guard: STR, gateWrapper: STR, migrationMessage: STR,
        afterMigration: { type: 'string', enum: ['continue', 'stop'] },
        waitForCi: { type: 'boolean' },
      },
      required: ['note', 'guard', 'gateWrapper', 'migrationMessage', 'afterMigration', 'waitForCi'],
    },
  },
  required: ['repo', 'addendum', 'knownFlakes', 'worktreeSetup', 'commands', 'merge'],
}

const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, error: { type: 'string', description: '"" when ok' }, warnings: { type: 'string' }, adapter: ADAPTER_SCHEMA },
  required: ['ok', 'error', 'adapter'],
}

const CLEANUP_SCHEMA = {
  type: 'object',
  properties: { output: { type: 'string', description: 'the JSON line the command printed' } },
  required: ['output'],
}

const STAGE_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked', 'failed'], description: 'done = stage finished AND its marker comment is posted; blocked = a guardrail / unfixable problem (blocked marker posted if a PR exists); failed = could not finish, nothing recorded' },
    prNumber: { type: 'integer', description: '0 if no PR exists' },
    sha: { type: 'string', description: 'branch head after this stage, "" if none' },
    verdict: { type: 'string', description: 'review stage only: approve | changes | redo-red (code tasks); "" otherwise' },
    migrationAdded: { type: 'string', description: 'merge stage only: migration file(s) this PR added, "" if none' },
    summary: { type: 'string', description: 'one line for the run log' },
    blockedReason: { type: 'string', description: '"" unless blocked/failed' },
    worktreePath: { type: 'string', description: 'absolute path of the worktree this stage ran in (`git rev-parse --show-toplevel`), so the loop can remove it' },
  },
  required: ['outcome', 'prNumber', 'summary', 'worktreePath'],
}

const SCRIPTED_MERGE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'false if the command did not print its JSON (crash, timeout, install failure)' },
    error: { type: 'string', description: 'exit code + stderr + stdout tails when ok=false, else ""' },
    status: { type: 'string', enum: ['merged', 'conflict', 'red', 'busy', 'guardrail', 'error', ''], description: 'the JSON\'s status; "" when ok=false' },
    sha: { type: 'string' },
    migrationAdded: { type: 'string' },
    typecheckFailed: { type: 'boolean' },
    ciFailed: { type: 'boolean' },
    failedFiles: { type: 'array', items: { type: 'string' } },
    guardReasons: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
    detail: { type: 'string' },
    afterMigration: { type: 'string', enum: ['continue', 'stop', ''], description: 'the JSON\'s afterMigration, copied exactly; "" when ok=false' },
    worktreePath: { type: 'string', description: 'git rev-parse --show-toplevel of your worktree' },
  },
  required: ['ok', 'error', 'status', 'sha', 'migrationAdded', 'typecheckFailed', 'ciFailed', 'failedFiles', 'guardReasons', 'message', 'detail', 'afterMigration', 'worktreePath'],
}

const STAGE_MODEL = { red: 'opus', check: 'sonnet', 'blind-check': 'opus', review: 'opus', merge: 'sonnet' }
const ALLOWED_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable'])
function modelFor(n) {
  if (n.stage === 'implement') return ALLOWED_MODELS.has(n.model) ? n.model : MODEL
  return STAGE_MODEL[n.stage] || MODEL
}

// One way to run a helper command: keep stdout AND stderr (pnpm prints its own
// errors on stdout; `--silent` once hid an install failure completely), and on a
// non-zero exit hand both back verbatim.
function runHelper(cmd) {
  return [
    'Run exactly this with Bash (T is a fresh temp dir):',
    `  T=$(mktemp -d); ${cmd} >"$T/out" 2>"$T/err"; echo "exit=$?"`,
    'If it printed exit=0: read $T/out — it is one JSON object.',
    'If the exit code is not 0: ok=false and error = "exit <code>" + "\\n--- stderr ---\\n" + the last 40 lines of $T/err + "\\n--- stdout ---\\n" + the last 40 lines of $T/out, verbatim, nothing summarised.',
  ].join('\n')
}

function planPrompt(skip, cleanupPath) {
  const skipArg = skip.length ? ` --skip ${skip.join(',')}` : ''
  return [
    TRIGGER,
    '',
    'You run two commands for a Ralph pipeline and relay what they print. You have no other job and no conversation with anyone.',
    'Always run them, in order, yourself, now: nothing has run before you and nobody else will. Never answer without running them.',
    cleanupPath
      ? `FIRST remove the previous stage's worktree (it only removes a clean, pushed stage worktree): \`${lib('worktrees')} remove "${cleanupPath}"\`. Put the JSON line it prints in "cleanup" (whatever it says, carry on).`
      : 'There is no worktree to remove: cleanup="".',
    'THEN:',
    runHelper(`${lib('next-step')} "${ledgerPath}"${skipArg}`),
    'On exit=0, return that JSON object through the schema with ok=true and error="".',
    // -1, never 0: a failure relayed with ok=true must not read as "everything is done".
    'On failure also set hasNext=false, remaining=-1, parked=[], and a "next" object with empty strings / zeros.',
    'Do not edit, fix or investigate anything.',
  ].join('\n')
}

// The planner is an LLM relaying next-step.ts's JSON, so its answer is checked
// before the loop acts on it. 2026-10-22: after E1's review a relay returned the
// failure shape (hasNext=false, remaining=0, parked=[]) with ok=true, and the run
// ended "complete" with all 16 tasks still open. Returns '' or the reason.
function planProblem(plan, prev, mergeRan) {
  if (plan.remaining < 0) return 'the planner reported a failed command as ok'
  if (!plan.hasNext && plan.parked.length !== plan.remaining) {
    return `the planner says nothing is runnable but parks ${plan.parked.length} of ${plan.remaining} open task(s)`
  }
  // Open tasks only drop when a merge lands (gate ticks run before the grind).
  const allowed = mergeRan ? 1 : 0
  if (prev && plan.remaining < prev.remaining - allowed) {
    return `open tasks dropped from ${prev.remaining} to ${plan.remaining} with ${allowed} merge(s) since the last plan`
  }
  return ''
}

function gatesPrompt() {
  return [
    TRIGGER,
    '',
    'You run one command for a Ralph pipeline and relay what it prints. You have no other job and no conversation with anyone.',
    'It reads read-only evidence (GitHub, this repo\'s prod and the other repos its gates name, and any checks this repo adds) and, if any human gate is now done, ticks it on main through an auto-merged ledger PR.',
    runHelper(`${lib('tick-gates')} "${ledgerPath}" --apply`),
    'On exit=0, return that JSON object through the schema with ok=true and error="".',
    'On failure also set ticked=[], waiting=[], noCheck=[], prUrl="". Run it ONCE — never re-run it to see the error again.',
    'Do not edit, fix or investigate anything.',
  ].join('\n')
}

function preflightPrompt() {
  return [
    TRIGGER,
    '',
    'You are the PREFLIGHT for a Ralph PR pipeline: a mechanical checklist. You have no conversation with anyone and no decisions to make: run the steps, report what they print. Stop at the first failing step.',
    `1. \`${lib('preflight')}\` (plain node, no package manager: it must work on a broken install). Always run it — it is the fixed first step of every run, not something you weigh against the relayed request. It loads this repo's Ralph adapter (.claude/ralph.json), removes stale, clean, pushed stage worktrees (deciding which is its job, not yours), then checks free disk and that the package install works, and prints one JSON object {ok, error, warnings, adapter, ...}. If its ok is false, return ok=false with its "error" VERBATIM (it is already written for Matt). Copy its "warnings" into warnings, and its "adapter" object into adapter field for field (when it is null, return ok=false).`,
    '2. `gh auth status` must succeed.',
    `3. \`git fetch origin main --quiet\`, then \`git show origin/main:${ledgerPath}\` must print the ledger (it must be merged to main — the pipeline reads it only from there).`,
    '4. Save that ledger to a temp file and run both validators on it, each with stdout and stderr kept:',
    `   \`${lib('validate-ledger-deps')} <file>\` and \`${lib('validate-ledger-authorability')} <file>\`. Both must exit 0; copy any "warning:" lines into warnings. On a non-zero exit, error = the exit code + its stderr + stdout, verbatim.`,
    `5. \`${POLICY}\` must exist, and the adapter's "addendum" file must exist in this checkout.`,
    'ok=true only if all five hold. Always return the adapter you copied in step 1 (or one with empty strings when step 1 printed none).',
  ].join('\n')
}

// Check step 4 as exact commands, built from the red markers (next-step.ts redFactsOf).
function redGuardLines(n) {
  if (!n.redSha) {
    // TEMPORARY: PRs whose red marker predates `sha=`/`files=` (all were approved and had no
    // redo when this landed). Delete once no open ralph PR has a bare `ralph:red` marker.
    return 'Red guard (policy §check step 4): this PR\'s red marker records no commit, so red\'s commit is the branch\'s first non-merge commit: `git log --format=%H --no-merges --reverse origin/main..HEAD | head -1`. Diff it to HEAD over the test files that commit added; any weakened assertion → fail.'
  }
  const files = n.redFiles.join(' ')
  const lines = [
    'Red guard (policy §check step 4), run exactly these:',
    `- \`git merge-base --is-ancestor ${n.redSha} HEAD\` must succeed (else fail: the red marker names a commit not on this branch).`,
    `- \`git diff ${n.redSha}..HEAD -- ${files}\`: no red assertion weakened, else fail.`,
  ]
  if (n.prevRedSha) lines.push(`- \`git diff ${n.prevRedSha}..${n.redSha} -- ${files}\`: confirm the redo stayed in scope (it changes only the tests the \`redo-red\` review named), else fail.`)
  return lines.join('\n')
}

const isSmall = (n) => n.kind === 'code' && n.size === 'small'

function stageInstruction(n, scripted) {
  const docsLike = n.kind !== 'code'
  // No separate check stage: docs/measure, and small code tasks.
  const noCheck = docsLike || isSmall(n)
  switch (n.stage) {
    case 'red':
      if (n.lastEvent === 'review-redo-red') return 'This is a red REDO (policy §red, "Redo"): review found bad red tests. Detach at origin/<branch>, rewrite ONLY the red tests the latest `ralph:review` comment names, as it says, commit `⛔ do-not-merge: red (redo)`, push, then post the changed tests with pass/fail for each, and `<!-- ralph:red sha=<sha> files=<comma-separated test files you changed> -->` (sha = your pushed commit).'
      return 'Write the acceptance as REAL failing tests, push, open the DRAFT PR, post `<!-- ralph:red sha=<sha> files=<comma-separated test files> -->` (sha = your pushed commit).'
    case 'implement':
      if (n.lastEvent === 'red-redone') return 'The red stage REWROTE some red tests after review (see the latest `ralph:red` comment). Make them pass without weakening an assertion, also fix any blocking findings in the latest `ralph:review` comment, refresh the PR body (tests, counts, Seams), then ALWAYS post a fresh `<!-- ralph:implemented sha=<sha> -->`, even with nothing to fix.'
      if (n.lastEvent === 'review-changes') return 'This is a FIX round: address ONLY the blocking findings in the latest `ralph:review` comment on the PR, then post `<!-- ralph:implemented sha=<sha> -->`.'
      if (n.lastEvent === 'check-fail') return 'The last check FAILED: read the latest `ralph:check` comment on the PR, fix exactly that, then post `<!-- ralph:implemented sha=<sha> -->`.'
      if (n.lastEvent === 'blind-check-fail') return 'The independent blind check DISAGREED: read the latest `ralph:blind-check` comment, re-examine the disputed items (do not just adopt either side), record the resolution, then post `<!-- ralph:implemented sha=<sha> -->`.'
      if (isSmall(n)) return 'This is a SMALL code task (policy §implement, "Small code tasks"): there is no red stage, so write the acceptance tests yourself, with the code, in this PR. Detach at origin/main, implement, tick the ledger in this PR, push, open the DRAFT PR, post `<!-- ralph:implemented sha=<sha> -->`.'
      return 'Implement the task, tick the ledger in this PR, push, post `<!-- ralph:implemented sha=<sha> -->`.'
    case 'check':
      return 'Re-verify the PUSHED head from scratch and post `<!-- ralph:check result=pass|fail -->` with the evidence.' + (noCheck ? '' : '\n' + redGuardLines(n))
    case 'blind-check':
      return 'Do the task\'s independent BLIND check (policy §blind-check): you have never seen the grades. Re-judge the sample from its inputs ALONE, write your verdicts to a file and commit it BEFORE you open the implement stage\'s grades, then compare, push, and post `<!-- ralph:blind-check result=pass|fail -->` with the agreement numbers.'
    case 'review':
      if (isSmall(n)) return 'Review the PR against the task, its issue and CLAUDE.md. This is a SMALL code task with NO red and NO check stage: first do the check duties yourself (policy §review, "Small code tasks": TYPECHECK + the PR\'s tests on the pushed head, the ledger tick, and that the tests really prove the slice), and confirm it still fits "small"; then post `<!-- ralph:review verdict=approve|changes -->` with findings.'
      return noCheck
        ? 'Review the PR against the task, its issue and CLAUDE.md. This task has NO separate check stage: first do the check duties yourself (policy §review, "docs/measure"), then post `<!-- ralph:review verdict=approve|changes -->` with findings.'
        : 'Review the PR against the task, its issue and CLAUDE.md; post `<!-- ralph:review verdict=approve|changes|redo-red -->` with findings. Use redo-red when a RED test is bad (policy §review): implement may not change red\'s assertions, so red rewrites it.'
    case 'merge':
      if (scripted) return scriptedHandoff(scripted) + '\n' + mergeInstruction()
      return mergeInstruction()
  }
  return ''
}

// What the scripted merge already did, so the agent never re-runs a gate for nothing.
function scriptedHandoff(r) {
  const head = r.sha ? ` It left the branch caught up with origin/main and pushed at ${r.sha}.` : ''
  if (r.status === 'guardrail') {
    return [
      `The scripted merge (lib/merge.ts) ran this repo's merge guard (\`${A.merge.guard}\`) and it REFUSED: ${(r.guardReasons || []).join('; ') || r.message}.`,
      'Do NOT merge. Post the blocked comment with `--reason guardrail`, a plain `--why` naming those reasons, and a `--fix` like "check it is safe, then merge this PR yourself", and return `blocked` (policy §merge step 0).',
    ].join('\n')
  }
  if (r.status === 'red' && r.typecheckFailed) {
    return [
      `The scripted merge (lib/merge.ts) already ran on this PR: TYPECHECK (\`${A.commands.typecheck}\`) FAILED on the head caught up with origin/main${r.sha ? ` (${r.sha})` : ''}. A type error is never a flake: re-run it once to confirm, then comment the errors + \`<!-- ralph:check result=fail stage=merge -->\` (back to implement) and return done. Its output tail:`,
      '```', (r.detail || '').slice(-4000), '```',
    ].join('\n')
  }
  if (r.status === 'red') {
    const what = r.ciFailed
      ? `the local MERGE GATE passed but the PR's CI failed (${r.message})`
      : `the FIRST full MERGE GATE run is done; its failing files: ${(r.failedFiles || []).join(', ') || '(none reported — a crash or setup error)'}`
    return [
      `The scripted merge (lib/merge.ts) already ran on this PR: status=red — ${r.message}.${head}`,
      `Do NOT re-run the first gate: ${what}. Detach at origin/<branch> (it must equal that sha), then start at step 2's red path ("Flake first" / "Attribute it") with those failures. Its output tail:`,
      '```', (r.detail || '').slice(-4000), '```',
    ].join('\n')
  }
  if (r.status === 'conflict') return `The scripted merge could not merge origin/main itself (${r.message}); it aborted that merge. Do step 1 yourself, resolving the conflict per the shared rules, then the rest of the stage.`
  return `The scripted merge did not finish (${r.message || r.error || 'no result'}). Do the whole merge stage yourself.`
}

function mergeInstruction() {
  const guard = A.merge.guard
    ? ` FIRST (policy §merge step 0) run this repo's merge guard \`${A.merge.guard.replaceAll('{pr}', '<n>')}\`: if it prints ok=false (or fails), do NOT merge — post the blocked comment with \`--reason guardrail\` and its reasons, and return \`blocked\`.`
    : ''
  const ci = A.merge.waitForCi ? ' Also wait for the PR\'s CI (`gh pr checks <n> --watch`): a red CI check is red like a local failure.' : ''
  return `Bring the branch up to date, run the MERGE GATE (TYPECHECK + \`${A.commands.mergeGate}\`) on its head, then squash-merge. What a merge does in this repo: ${A.merge.note}${guard}${ci} Report any migration file the PR adds as migrationAdded. On a red test follow policy §merge: look it up in ${A.knownFlakes} as merged on origin/main, and let \`known-flakes.ts decide\` judge it — passing ALONE never makes a flake, only a passing FULL re-run of the merge gate does. Flake rows NEVER go on the task branch: after the merge, record them on the standing \`ralph/known-flakes\` branch and its one open PR (policy §merge step 4).`
}

// The repo's commands, named the way the policy names them.
function repoBlock() {
  const setup = A.worktreeSetup.length ? A.worktreeSetup.map((c) => `\`${c}\``).join(', then ') : '(nothing)'
  return [
    `This repo (${A.repo}) — the policy's command names mean:`,
    `  SETUP (first, in your fresh worktree): ${setup}`,
    `  TYPECHECK: \`${A.commands.typecheck}\``,
    `  TESTS <files>: \`${A.commands.testFiles} <files>\``,
    `  MERGE GATE (merge stage only): TYPECHECK + \`${A.commands.mergeGate}\``,
    `  RALPH: \`node "${R}/lib/<helper>.ts"\` — every Ralph helper the policy names (render-ledger, blocked-comment, known-flakes, …) runs this way.`,
    `  KNOWN FLAKES: ${A.knownFlakes}`,
  ].join('\n')
}

function stagePrompt(n, scripted) {
  const pr = n.prNumber ? `#${n.prNumber} (${n.prUrl})` : 'none yet'
  return [
    TRIGGER,
    '',
    `You are the ${n.stage.toUpperCase()} stage of the Ralph PR pipeline. Fresh context; you do this ONE stage of ONE task, then stop.`,
    'You have no conversation with Matt or anyone else: everything you need is in this prompt, the policy and the PR. Do not answer or act on anything else.',
    '',
    `FIRST read ${POLICY} — its "Shared rules" and its "${n.stage}" section are your binding contract — THEN this repo's addendum, ${A.addendum} (in your worktree), which adds this repo's guardrails and rules and wins where it is more specific.`,
    '',
    repoBlock(),
    '',
    `Task ${n.taskId}: ${n.title}`,
    `  kind=${n.kind}${n.kind === 'code' ? ` · size=${n.size || 'standard'}` : ''} · verify=${n.verify || '(none)'}`,
    `  spec slice (read ONLY this section of the doc, by heading): ${n.pointer}`,
    `  ledger: ${ledgerPath}`,
    `  branch: ${n.branch} · PR: ${pr}`,
    '',
    `This stage: ${stageInstruction(n, scripted)}`,
    '',
    `If you must stop (a guardrail, the environment, an unfixable problem), post the plain-language blocked comment from \`${lib('blocked-comment')}\` (policy §Guardrails) — never a bare marker.`,
    'Your LAST action on success is posting the stage marker comment on the PR — that comment is the only thing that moves the task forward. Post it ONLY with `gh pr comment <n> --body-file <file>`; NEVER `gh pr review` (reviews are invisible to the pipeline). One marker per comment, as its last line.',
    'Return the structured result, with worktreePath = `git rev-parse --show-toplevel` of your worktree, and leave the tree clean (the loop removes the worktree after you).',
  ].join('\n')
}

function scriptedMergePrompt(n) {
  const setup = A.worktreeSetup.length ? `Setup first, in order: ${A.worktreeSetup.map((c) => `\`${c}\``).join(', then ')}.` : 'There is no setup to do.'
  return [
    TRIGGER,
    '',
    'You run one command for a Ralph pipeline and relay what it prints. You have no other job and no conversation with anyone.',
    'Always run it yourself, now: nothing has run before you and nobody else will. Never answer without running it.',
    `You are in a fresh git worktree. ${setup}`,
    'Then run the command below ONCE, with the Bash tool\'s timeout set to 600000 ms (it may wait for a lock, run the full tests and wait for CI, which takes minutes). Never re-run it, never run anything else, and do not edit, fix or investigate anything.',
    runHelper(`${lib('merge')} --pr ${n.prNumber} --branch "${n.branch}" --ledger "${ledgerPath}" --task "${n.taskId}"`),
    'On exit=0, return that JSON object\'s fields through the schema with ok=true and error="".',
    'On failure (or a Bash timeout): ok=false, status="", and empty strings / false / [] for the other fields.',
    'Always set worktreePath = `git rev-parse --show-toplevel`, and leave the tree as the command left it.',
  ].join('\n')
}

function cleanupPrompt(path) {
  return `${TRIGGER}\n\nRun exactly this with Bash and nothing else: \`${lib('worktrees')} remove "${path}"\`. Return the JSON line it prints as output.`
}

// The adapter must carry every field the prompts use: a relay that dropped one
// would put "undefined" into a stage prompt.
function adapterProblem(a) {
  if (!a || typeof a !== 'object') return 'the preflight returned no adapter'
  const missing = []
  for (const k of ['repo', 'addendum', 'knownFlakes']) if (typeof a[k] !== 'string' || !a[k]) missing.push(k)
  if (!Array.isArray(a.worktreeSetup)) missing.push('worktreeSetup')
  for (const k of ['typecheck', 'testFiles', 'mergeGate']) if (!a.commands || typeof a.commands[k] !== 'string' || !a.commands[k]) missing.push(`commands.${k}`)
  if (!a.merge || typeof a.merge.note !== 'string' || !a.merge.note) missing.push('merge.note')
  if (!a.merge || (a.merge.afterMigration !== 'continue' && a.merge.afterMigration !== 'stop')) missing.push('merge.afterMigration')
  return missing.length ? `the relayed adapter is missing ${missing.join(', ')}` : ''
}

// ---------------------------------------------------------------------------
phase('Preflight')
const pf = await agent(preflightPrompt(), { label: 'ralph:preflight', phase: 'Preflight', model: HELPER_MODEL, effort: 'low', schema: PREFLIGHT_SCHEMA, agentType: FRESH })
if (!pf || !pf.ok) {
  return { status: 'preflight-failed', ledgerPath, message: (pf && pf.error) || 'preflight agent returned nothing' }
}
const adapterFault = adapterProblem(pf.adapter)
if (adapterFault) {
  return { status: 'preflight-failed', ledgerPath, message: `${adapterFault}. Check .claude/ralph.json (\`${lib('preflight')}\` prints it), then re-run /ralph.` }
}
const A = pf.adapter
if (pf.warnings) log(`Preflight: ${pf.warnings}`)

// ---------------------------------------------------------------------------
// Human gates are never run, but Ralph ticks the ones whose `done_when` evidence
// now exists (lib/gate-checks.ts), so the work behind them runs this run.
// A failure here is not fatal: the gates just stay waiting until the next run.
phase('Gates')
const gates = await agent(gatesPrompt(), { label: 'ralph:gates', phase: 'Gates', model: HELPER_MODEL, effort: 'low', schema: GATES_SCHEMA, agentType: FRESH })
if (!gates || !gates.ok) {
  log(`Gate check failed (gates stay waiting): ${(gates && gates.error) || 'agent returned nothing'}`)
} else {
  for (const t of gates.ticked) log(`${t.id}: gate done, ticked — ${t.reasons.join('; ')}`)
  if (gates.prUrl) log(`Gate ticks landed: ${gates.prUrl}`)
}

// ---------------------------------------------------------------------------
phase('Grind')
const skip = []
const history = []
const migrations = []
const keptWorktrees = []
let lastKey = ''
let repeats = 0
let consecutiveFailures = 0
let final = null
let lastPlan = null
let lastStageWasMerge = false
let pendingCleanup = ''

function noteCleanup(line, path) {
  if (!path) return
  let r = null
  try { r = JSON.parse(line) } catch { r = null }
  if (!r || !r.removed) keptWorktrees.push({ path, reason: (r && r.reason) || line || 'cleanup did not report' })
}

// Did the planner run the worktree-remove command (it printed a JSON object)?
function cleanupReported(line) {
  try { const r = JSON.parse(line); return !!r && typeof r === 'object' } catch { return false }
}

function askPlanner(label, cleanupPath) {
  return agent(planPrompt(skip, cleanupPath), { label, phase: 'Grind', model: HELPER_MODEL, effort: 'low', schema: PLAN_SCHEMA, agentType: FRESH })
}

// '' if the plan can be acted on, else why not (a failed/refused command or an impossible answer).
function planFault(plan) {
  if (!plan) return 'the planner returned nothing'
  if (!plan.ok) return `next-step failed: ${plan.error || 'no error given'}`
  return planProblem(plan, lastPlan, lastStageWasMerge)
}

for (let i = 0; i < MAX_STEPS; i++) {
  const cleaning = pendingCleanup
  pendingCleanup = ''
  let plan = await askPlanner(`ralph:plan:${i + 1}`, cleaning)
  // A planner that never ran the remove command leaves the worktree to the recheck,
  // so it is not lost; one that ran it (whatever it said) is recorded now.
  let stillCleaning = cleaning
  if (plan && cleanupReported(plan.cleanup)) {
    noteCleanup(plan.cleanup, cleaning)
    stillCleaning = ''
  }
  const fault = planFault(plan)
  if (fault) {
    // Ask once more: a failed, refused or impossible answer gets one recheck. Two bad
    // answers stop the run as an error, never as "complete"; resuming is free, the
    // state is on GitHub.
    log(`Planner answer unusable (${fault}); asking again.`)
    const again = await askPlanner(`ralph:plan:${i + 1}:recheck`, stillCleaning)
    noteCleanup(again ? again.cleanup : '', stillCleaning)
    const againFault = planFault(again)
    if (againFault) {
      final = { status: 'error', message: `the planner failed twice (${fault}; then ${againFault}). Nothing was lost: re-run /ralph to continue.` }
      break
    }
    plan = again
  } else {
    noteCleanup(plan.cleanup, stillCleaning)
  }
  lastPlan = plan
  if (!plan.hasNext) {
    final = { status: plan.remaining === 0 ? 'complete' : 'parked' }
    break
  }

  const n = plan.next
  // A stage that "finished" without posting its marker leaves the planner on the
  // same (task, stage, markerCount). Allow one re-run, then give up on the task.
  const key = `${n.taskId}:${n.stage}:${n.markerCount}`
  repeats = key === lastKey ? repeats + 1 : 0
  lastKey = key
  if (repeats >= 2) {
    log(`${n.taskId}: ${n.stage} ran twice without recording a marker — skipping the task this run.`)
    skip.push(n.taskId)
    history.push({ task: n.taskId, stage: n.stage, outcome: 'stalled' })
    continue
  }

  let res = null
  let scripted = null
  if (n.stage === 'merge') {
    scripted = await agent(scriptedMergePrompt(n), {
      label: `ralph:${n.taskId}:merge:script`,
      phase: 'Grind',
      model: HELPER_MODEL,
      effort: 'low',
      isolation: 'worktree',
      schema: SCRIPTED_MERGE_SCHEMA,
      agentType: FRESH,
    })
    const scriptTree = (scripted && scripted.worktreePath) || ''
    if (scripted && scripted.ok && scripted.status === 'merged') {
      res = { outcome: 'done', prNumber: n.prNumber, sha: scripted.sha, verdict: '', migrationAdded: scripted.migrationAdded, afterMigration: scripted.afterMigration, summary: `scripted merge: ${scripted.message}`, blockedReason: '', worktreePath: scriptTree }
    } else if (scripted && scripted.ok && scripted.status === 'busy') {
      // Another heavy job holds the gate's lock: not a failure of this task. Park it for this run.
      pendingCleanup = scriptTree
      lastStageWasMerge = false
      log(`${n.taskId}: merge waiting — ${scripted.message}; skipping it this run (re-run /ralph later)`)
      history.push({ task: n.taskId, stage: 'merge', outcome: 'busy', pr: n.prNumber, verdict: '', summary: scripted.message })
      skip.push(n.taskId)
      continue
    } else {
      log(`${n.taskId}: scripted merge handed back ${scripted ? (scripted.status || 'a failure') : 'nothing'} — ${(scripted && (scripted.message || scripted.error)) || ''}; running the merge agent`)
      // The agent gets its own worktree; remove the script's now (the next planner call removes the agent's).
      if (scriptTree) {
        const c = await agent(cleanupPrompt(scriptTree), { label: `ralph:${n.taskId}:merge:script-cleanup`, phase: 'Grind', model: HELPER_MODEL, effort: 'low', schema: CLEANUP_SCHEMA, agentType: FRESH })
        noteCleanup(c ? c.output : '', scriptTree)
      }
    }
  }
  if (!res) {
    res = await agent(stagePrompt(n, scripted && scripted.ok ? scripted : (scripted ? { status: 'error', message: '', error: scripted.error } : null)), {
      label: `ralph:${n.taskId}:${n.stage}`,
      phase: 'Grind',
      model: modelFor(n),
      isolation: 'worktree',
      schema: STAGE_SCHEMA,
      agentType: FRESH,
    })
  }
  pendingCleanup = (res && res.worktreePath) || ''
  lastStageWasMerge = n.stage === 'merge' // even a "failed" merge may have landed

  const outcome = res ? res.outcome : 'failed'
  history.push({ task: n.taskId, stage: n.stage, outcome, pr: res ? res.prNumber : n.prNumber, verdict: (res && res.verdict) || '', summary: (res && res.summary) || '' })

  if (outcome === 'done') {
    consecutiveFailures = 0
    log(`${n.taskId}: ${n.stage} done${res.verdict ? ` (${res.verdict})` : ''} — ${res.summary}`)
    // Only a merge counts as a merged migration. What happens next is the repo's
    // call (adapter merge.afterMigration): keep grinding, or stop for Matt.
    if (n.stage === 'merge' && res.migrationAdded) {
      migrations.push({ task: n.taskId, files: res.migrationAdded })
      const note = A.merge.migrationMessage || 'see the repo addendum for what happens to it'
      // Two independent reads of the adapter (preflight's copy, and the merge script's own load of
      // .claude/ralph.json): either saying stop stops, so one mis-copied value can't carry a run past
      // a migration the repo wants applied first.
      if (A.merge.afterMigration === 'stop' || res.afterMigration === 'stop') {
        final = { status: 'migration-pending', message: `${n.taskId} merged migration ${res.migrationAdded}: ${note}` }
        break
      }
      log(`${n.taskId}: merged migration ${res.migrationAdded} — ${note}`)
    }
    continue
  }
  log(`${n.taskId}: ${n.stage} ${outcome} — ${(res && (res.blockedReason || res.summary)) || 'agent returned nothing'}`)
  if (outcome === 'blocked') {
    // A guardrail refusal is the system working, not a failure: park the task
    // and keep grinding the others.
    skip.push(n.taskId)
    continue
  }
  consecutiveFailures++
  if (consecutiveFailures >= MAX_CONSEC_FAILURES) {
    final = { status: 'stuck', message: `${consecutiveFailures} stages in a row failed` }
    break
  }
}
if (!final) final = { status: 'cap-reached', message: `hit maxSteps=${MAX_STEPS}; re-run to continue (state is on GitHub)` }

// ---------------------------------------------------------------------------
phase('Report')
// The last stage's worktree has no next planner call to remove it.
if (pendingCleanup) {
  const c = await agent(cleanupPrompt(pendingCleanup), { label: 'ralph:cleanup', phase: 'Report', model: HELPER_MODEL, effort: 'low', schema: CLEANUP_SCHEMA, agentType: FRESH })
  noteCleanup(c ? c.output : '', pendingCleanup)
}
const merged = history.filter((h) => h.stage === 'merge' && h.outcome === 'done').map((h) => `${h.task} #${h.pr}`)
log(`${final.status}: ${merged.length} merged (${merged.join(', ') || 'none'}); ${lastPlan ? lastPlan.parked.length : '?'} parked.`)
if (keptWorktrees.length) log(`${keptWorktrees.length} stage worktree(s) kept (they may hold work): ${keptWorktrees.map((k) => `${k.path} (${k.reason})`).join('; ')}`)

return {
  status: final.status, // complete | parked | migration-pending | stuck | cap-reached | error
  message: final.message || '',
  ledgerPath,
  merged,
  migrationsMerged: migrations, // migrations merged this run; what that means is the repo's (adapter merge.migrationMessage)
  parked: lastPlan ? lastPlan.parked : [],
  gatesTicked: gates && gates.ok ? gates.ticked : [],
  gatesWaiting: gates && gates.ok ? gates.waiting : [], // Matt's to-do, with what each check still sees
  gatesNoCheck: gates && gates.ok ? gates.noCheck : [], // Ralph adds a done_when on the next ledger refresh
  skippedThisRun: skip,
  remaining: lastPlan ? lastPlan.remaining : null,
  keptWorktrees, // stage worktrees NOT removed (dirty / unpushed): look before deleting
  history, // one compact row per stage — JS values, not session context
}
