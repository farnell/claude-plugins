import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import * as core from '../core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOW_PATH = resolve(__dirname, '../../workflows/adversarial-review.js')

// ─── parseArgs ───────────────────────────────────────────────────────────────
describe('parseArgs', () => {
  it('passes through an object', () => {
    expect(core.parseArgs({ target: '249', maxRounds: 3 })).toEqual({ target: '249', maxRounds: 3 })
  })
  it('parses a JSON string (the tool boundary may stringify)', () => {
    expect(core.parseArgs('{"target":"249","resume":true}')).toEqual({ target: '249', resume: true })
  })
  it('treats a bare string as the target', () => {
    expect(core.parseArgs('docs/x.md')).toEqual({ target: 'docs/x.md' })
  })
  it('falls back to {target} on malformed JSON', () => {
    expect(core.parseArgs('{not json')).toEqual({ target: '{not json' })
  })
  it('handles undefined', () => {
    expect(core.parseArgs(undefined)).toEqual({})
  })
})

// ─── validateTarget ──────────────────────────────────────────────────────────
describe('validateTarget', () => {
  it('accepts a PR number', () => {
    expect(core.validateTarget('249')).toEqual({ isPR: true, valid: true })
  })
  it('accepts a repo-relative file path', () => {
    expect(core.validateTarget('docs/architecture.md')).toEqual({ isPR: false, valid: true })
  })
  it('rejects shell metacharacters', () => {
    expect(core.validateTarget('docs/$(rm -rf /).md').valid).toBe(false)
    expect(core.validateTarget('a;b.md').valid).toBe(false)
    expect(core.validateTarget('a`b`.md').valid).toBe(false)
  })
  it('rejects path traversal and absolute paths', () => {
    expect(core.validateTarget('../etc/passwd').valid).toBe(false)
    expect(core.validateTarget('/etc/passwd').valid).toBe(false)
  })
  it('rejects an empty target', () => {
    expect(core.validateTarget('').valid).toBe(false)
  })
})

// ─── shortHash / makeStateKey ────────────────────────────────────────────────
describe('makeStateKey', () => {
  it('is deterministic', () => {
    expect(core.makeStateKey('249', true, '/r')).toBe(core.makeStateKey('249', true, '/r'))
  })
  it('distinguishes targets that the old slash→underscore key collided', () => {
    const a = core.makeStateKey('docs/a/b.md', false, '/r')
    const b = core.makeStateKey('docs/a_b.md', false, '/r')
    expect(a).not.toBe(b) // old key produced file-docs_a_b.md for both
  })
  it('distinguishes the same PR number across different repos', () => {
    expect(core.makeStateKey('249', true, '/repoA')).not.toBe(core.makeStateKey('249', true, '/repoB'))
  })
  it('produces a filesystem-safe key', () => {
    expect(core.makeStateKey('docs/a/b.md', false, '/r')).toMatch(/^[A-Za-z0-9._-]+$/)
  })
})

// ─── shq (injection safety) ──────────────────────────────────────────────────
describe('shq', () => {
  it('wraps in single quotes', () => {
    expect(core.shq('hello')).toBe("'hello'")
  })
  it('neutralises injection vectors', () => {
    const out = core.shq("x'; rm -rf / #")
    expect(out.startsWith("'")).toBe(true)
    expect(out.endsWith("'")).toBe(true)
    // every embedded single quote is closed/escaped/reopened
    expect(out).toBe("'x'\\''; rm -rf / #'")
  })
  it('preserves $, backticks, newlines literally', () => {
    expect(core.shq('`$HOME`\n$(x)')).toBe("'`$HOME`\n$(x)'")
  })
})

// ─── extractThreadId (race-free session capture) ─────────────────────────────
describe('extractThreadId', () => {
  it('extracts thread_id from a codex --json stream', () => {
    const ev = '{"type":"thread.started","thread_id":"019ee38e-38c3-7d30-a13e-dacb34f6c057"}\n{"type":"turn.started"}'
    expect(core.extractThreadId(ev)).toBe('019ee38e-38c3-7d30-a13e-dacb34f6c057')
  })
  it('returns null when absent', () => {
    expect(core.extractThreadId('{"type":"turn.started"}')).toBeNull()
  })
})

// ─── parseCodex (delimiter robustness) ───────────────────────────────────────
describe('parseCodex', () => {
  const mk = (rc: number, body: string, sid?: string) =>
    `@@@CODEX_RC@@@${rc}\n@@@CODEX_OUTPUT@@@\n${body}\n@@@CODEX_SESSION_ID@@@\n${sid ?? ''}`

  it('parses a normal success', () => {
    const r = core.parseCodex(mk(0, 'findings here', '019ee36e-742e-7272-9252-de4a771df7b2'))
    expect(r.ok).toBe(true)
    expect(r.content).toBe('findings here')
    expect(r.sessionId).toBe('019ee36e-742e-7272-9252-de4a771df7b2')
  })
  it('survives a review body that QUOTES both delimiters (the real bug)', () => {
    const body = 'The @@@CODEX_OUTPUT@@@ handling and the @@@CODEX_SESSION_ID@@@ split are buggy.'
    const r = core.parseCodex(mk(0, body, '019ee36e-742e-7272-9252-de4a771df7b2'))
    expect(r.sessionId).toBe('019ee36e-742e-7272-9252-de4a771df7b2')
    expect(r.content).toContain('@@@CODEX_OUTPUT@@@')
    expect(r.content).toContain('@@@CODEX_SESSION_ID@@@')
  })
  it('reports failure on non-zero exit', () => {
    const r = core.parseCodex('@@@CODEX_RC@@@1\n@@@CODEX_OUTPUT@@@\n\n@@@CODEX_SESSION_ID@@@\n')
    expect(r.ok).toBe(false)
    expect(r.rc).toBe(1)
  })
  it('reports failure when content is empty even on rc 0', () => {
    expect(core.parseCodex(mk(0, '', '')).ok).toBe(false)
  })

  // ── issue #4: order-independent session-id capture ──
  it('captures the session id when a subagent HOISTS the marker above OUTPUT (issue #4)', () => {
    // The exact shape observed in the wild: the relaying subagent reformatted the
    // codex stdout, moving @@@CODEX_SESSION_ID@@@ (uuid inline, space-separated)
    // into a header block ABOVE @@@CODEX_OUTPUT@@@. The old parser read the id only
    // from after OUTPUT → null → resume_failed after round 1.
    const raw = `@@@CODEX_RC@@@0
@@@CODEX_SESSION_ID@@@ 019f1bfd-144e-7f32-8677-3cba2c0a4f13

@@@CODEX_OUTPUT@@@
**Completed Items** — findings go here.`
    const r = core.parseCodex(raw)
    expect(r.ok).toBe(true)
    expect(r.sessionId).toBe('019f1bfd-144e-7f32-8677-3cba2c0a4f13')
    expect(r.content).toBe('**Completed Items** — findings go here.')
  })
  it('parses the self-delimiting one-line fenced emit form', () => {
    const raw = `@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings\n\n@@@CODEX_SESSION_ID@@@019ee36e-742e-7272-9252-de4a771df7b2@@@END_SID@@@`
    const r = core.parseCodex(raw)
    expect(r.sessionId).toBe('019ee36e-742e-7272-9252-de4a771df7b2')
    expect(r.content).toBe('findings')
  })
  it('prefers the fenced id even when the body merely MENTIONS the bare marker', () => {
    // Prose in the review (or these very comments) quotes @@@CODEX_SESSION_ID@@@
    // without a uuid/fence; the real fenced id must still win.
    const raw = `@@@CODEX_RC@@@0
@@@CODEX_OUTPUT@@@
The @@@CODEX_SESSION_ID@@@ marker handling looks fragile.

@@@CODEX_SESSION_ID@@@019ee36e-742e-7272-9252-de4a771df7b2@@@END_SID@@@`
    expect(core.parseCodex(raw).sessionId).toBe('019ee36e-742e-7272-9252-de4a771df7b2')
  })
  it('does NOT fall back to a bare uuid when the marker was stripped — a uuid in review content must never become the session id', () => {
    // The old third fallback (pickLast of ANY uuid in raw) could capture a uuid
    // that merely appears in review content — a WRONG session id, worse than none.
    const raw = `@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings\nsession 019f1bfd-144e-7f32-8677-3cba2c0a4f13`
    expect(core.parseCodex(raw).sessionId).toBeNull()
  })
  it('never captures a session id when none is present', () => {
    expect(core.parseCodex('@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\njust findings, no uuid anywhere').sessionId).toBeNull()
  })

  // ── stderr diagnostic channel (@@@CODEX_STDERR@@@…@@@END_STDERR@@@) ──
  it('returns empty stderr when the marker is absent', () => {
    expect(core.parseCodex(mk(0, 'findings', '')).stderr).toBe('')
  })
  it('extracts a fenced stderr block on failure', () => {
    const r = core.parseCodex('@@@CODEX_RC@@@1\n@@@CODEX_OUTPUT@@@\n\n@@@CODEX_STDERR@@@codex: auth token expired@@@END_STDERR@@@')
    expect(r.ok).toBe(false)
    expect(r.stderr).toBe('codex: auth token expired')
  })
  it('tolerates multi-line stderr content between the fences', () => {
    const r = core.parseCodex('@@@CODEX_RC@@@1\n@@@CODEX_STDERR@@@line one\nline two\nline three@@@END_STDERR@@@')
    expect(r.stderr).toBe('line one\nline two\nline three')
  })
  it('the LAST stderr occurrence wins', () => {
    const raw = '@@@CODEX_RC@@@1\n@@@CODEX_STDERR@@@first@@@END_STDERR@@@\n@@@CODEX_OUTPUT@@@\n\n@@@CODEX_STDERR@@@second@@@END_STDERR@@@'
    expect(core.parseCodex(raw).stderr).toBe('second')
  })
  it('strips the stderr block from content when it appears after @@@CODEX_OUTPUT@@@', () => {
    const raw = '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings here\n@@@CODEX_STDERR@@@warning: slow network@@@END_STDERR@@@\n@@@CODEX_SESSION_ID@@@019ee36e-742e-7272-9252-de4a771df7b2@@@END_SID@@@'
    const r = core.parseCodex(raw)
    expect(r.content).toBe('findings here')
    expect(r.stderr).toBe('warning: slow network')
    expect(r.sessionId).toBe('019ee36e-742e-7272-9252-de4a771df7b2')
    expect(r.ok).toBe(true)
  })
  it('an empty fenced stderr block yields empty string', () => {
    expect(core.parseCodex('@@@CODEX_RC@@@1\n@@@CODEX_STDERR@@@@@@END_STDERR@@@').stderr).toBe('')
  })
  it('an unterminated stderr marker is not a block (no END fence → no capture, no strip)', () => {
    const r = core.parseCodex('@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nprose mentions @@@CODEX_STDERR@@@ without a fence')
    expect(r.stderr).toBe('')
    expect(r.content).toContain('@@@CODEX_STDERR@@@')
  })
})

// ─── codexLaunchCmd / codexPollCmd / codexHarvestCmd (launch→poll→harvest) ───
describe('codexLaunchCmd', () => {
  const FLAGS = '-c model="gpt-5.5" -c model_reasoning_effort="high"'
  const SID = '019ee36e-742e-7272-9252-de4a771df7b2'

  it('initial: creates a per-run temp dir, echoes it self-delimiting, and launches codex detached', () => {
    const s = core.codexLaunchCmd(FLAGS, core.shq('review this'), null, '')
    expect(s).toContain('D="$(mktemp -d -t adv_run.XXXXXX)"')
    expect(s).toContain('echo "@@@CODEX_RUNDIR@@@$D@@@END_RUNDIR@@@"')
    expect(s).toContain(`codex exec --json ${FLAGS} --output-last-message "$1/out" "$2"`)
    expect(s).toContain('nohup sh -c')
    expect(s).toContain('> /dev/null 2>&1 &')
    expect(s).toContain('disown')
    expect(s).toContain('ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"')
    // events + stderr are captured to files for the later harvest
    expect(s).toContain('> "$1/events.json" 2> "$1/stderr.log"')
  })
  it('the rc write is the LAST step of the detached wrapper — the completion signal', () => {
    const s = core.codexLaunchCmd(FLAGS, core.shq('p'), null, '')
    // rc is written after codex exits, inside the same sh -c, as its final command
    expect(s).toContain(`; echo $? > "$1/rc"' sh "$D"`)
    expect(s.indexOf('--output-last-message')).toBeLessThan(s.indexOf('echo $? > "$1/rc"'))
  })
  it('the prompt rides as a positional arg ($2), shq-quoted — never nested in the sh -c body', () => {
    const s = core.codexLaunchCmd(FLAGS, core.shq("it's a prompt"), null, '')
    expect(s).toContain(` sh "$D" 'it'\\''s a prompt' > /dev/null 2>&1 &`)
  })
  it('resume: codex exec resume <sid>, same detached shape', () => {
    const s = core.codexLaunchCmd(FLAGS, core.shq('p'), SID, '')
    expect(s).toContain(`codex exec resume ${SID} --json ${FLAGS} --output-last-message "$1/out" "$2"`)
    expect(s).toContain('mktemp -d -t adv_run.XXXXXX')
  })
  it('root override cds into the given root (shq-quoted) instead of deriving it in-shell', () => {
    const wt = '/home/u/.claude/adversarial-review-state/worktrees/pr-9-abc12345'
    const s = core.codexLaunchCmd(FLAGS, core.shq('p'), null, wt)
    expect(s).toContain(`ROOT='${wt}'`)
    expect(s).not.toContain('git rev-parse --show-toplevel')
    expect(s).toContain('cd "$ROOT" && nohup')
  })
})

describe('codexPollCmd', () => {
  it('probes the rc completion file', () => {
    expect(core.codexPollCmd('/tmp/adv_run.abc123')).toBe(`D='/tmp/adv_run.abc123'\ntest -f "$D/rc" && echo DONE || echo RUNNING`)
  })
})

describe('codexHarvestCmd', () => {
  it('emits the exact marker grammar parseCodex expects (initial variant)', () => {
    const s = core.codexHarvestCmd('/tmp/adv_run.abc', true)
    expect(s).toContain(`D='/tmp/adv_run.abc'`)
    expect(s).toContain('echo "@@@CODEX_RC@@@${RC:-1}"')
    expect(s).toContain('echo "@@@CODEX_OUTPUT@@@"')
    expect(s).toContain('[ "$RC" = "0" ] && cat "$D/out"')
    expect(s).toContain(`printf '@@@CODEX_STDERR@@@%s@@@END_STDERR@@@\\n' "$(tail -c 2000 "$D/stderr.log")"`)
    expect(s).toContain('echo "@@@CODEX_SESSION_ID@@@$SID@@@END_SID@@@"')
  })
  it('the resume variant omits the session-id capture entirely', () => {
    const s = core.codexHarvestCmd('/tmp/adv_run.abc', false)
    expect(s).not.toContain('CODEX_SESSION_ID')
    expect(s).not.toContain('thread_id')
  })
  it('the stderr tail is gated on failure', () => {
    expect(core.codexHarvestCmd('/t/adv_run.x', true)).toContain('if [ "$RC" != "0" ] && [ -s "$D/stderr.log" ]; then')
  })
  it('rm -rf is guarded by the mktemp prefix pattern and is the ONLY rm in the script', () => {
    const s = core.codexHarvestCmd('/tmp/adv_run.abc', true)
    expect(s).toContain('case "$D" in */adv_run.*) rm -rf "$D";; esac')
    expect(s.match(/rm /g)).toHaveLength(1)
  })
  it('every marker is emitted BEFORE the run dir is removed', () => {
    const s = core.codexHarvestCmd('/tmp/adv_run.abc', true)
    for (const marker of ['@@@CODEX_RC@@@', '@@@CODEX_OUTPUT@@@', '@@@END_STDERR@@@', '@@@END_SID@@@']) {
      expect(s.indexOf(marker)).toBeLessThan(s.indexOf('rm -rf'))
    }
  })

  // Executed round-trips: run the REAL harvest bash over a synthesized run dir
  // and feed its stdout to parseCodex — proves the launch/poll/harvest protocol
  // preserves the exact marker grammar the parser expects.
  it('executed harvest of a SUCCESSFUL initial run round-trips through parseCodex (and removes the dir)', () => {
    const d = mkdtempSync(join(tmpdir(), 'adv_run.'))
    writeFileSync(join(d, 'rc'), '0\n')
    writeFileSync(join(d, 'out'), 'the review body\n')
    writeFileSync(join(d, 'events.json'), '{"type":"thread.started","thread_id":"019ee36e-742e-7272-9252-de4a771df7b2"}\n')
    writeFileSync(join(d, 'stderr.log'), '')
    const stdout = execFileSync('bash', ['-c', core.codexHarvestCmd(d, true)], { encoding: 'utf8' })
    const p = core.parseCodex(stdout)
    expect(p.ok).toBe(true)
    expect(p.rc).toBe(0)
    expect(p.content).toBe('the review body')
    expect(p.sessionId).toBe('019ee36e-742e-7272-9252-de4a771df7b2')
    expect(p.stderr).toBe('')
    expect(existsSync(d)).toBe(false) // run dir cleaned up
  })
  it('executed harvest of a FAILED run round-trips through parseCodex with the stderr tail', () => {
    const d = mkdtempSync(join(tmpdir(), 'adv_run.'))
    writeFileSync(join(d, 'rc'), '1\n')
    writeFileSync(join(d, 'stderr.log'), 'codex: auth token expired\n')
    const stdout = execFileSync('bash', ['-c', core.codexHarvestCmd(d, true)], { encoding: 'utf8' })
    const p = core.parseCodex(stdout)
    expect(p.ok).toBe(false)
    expect(p.rc).toBe(1)
    expect(p.content).toBe('')
    expect(p.stderr).toBe('codex: auth token expired')
    expect(p.sessionId).toBeNull()
    expect(existsSync(d)).toBe(false)
  })
  it('executed harvest with a MISSING rc file reports rc 1 (never a false success)', () => {
    const d = mkdtempSync(join(tmpdir(), 'adv_run.'))
    writeFileSync(join(d, 'out'), 'never shown\n')
    const stdout = execFileSync('bash', ['-c', core.codexHarvestCmd(d, false)], { encoding: 'utf8' })
    const p = core.parseCodex(stdout)
    expect(p.rc).toBe(1)
    expect(p.ok).toBe(false)
    expect(p.content).toBe('')
  })
  it('executed harvest NEVER removes a dir that does not match the adv_run. prefix', () => {
    const d = mkdtempSync(join(tmpdir(), 'other.'))
    try {
      writeFileSync(join(d, 'rc'), '0\n')
      writeFileSync(join(d, 'out'), 'x\n')
      writeFileSync(join(d, 'events.json'), '')
      execFileSync('bash', ['-c', core.codexHarvestCmd(d, true)], { encoding: 'utf8' })
      expect(existsSync(d)).toBe(true) // rm guard held
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

// ─── shouldRetryCodex (one auto-retry, except the poll-budget timeout) ────────
describe('shouldRetryCodex', () => {
  it('never retries a success', () => {
    expect(core.shouldRetryCodex({ ok: true, rc: 0 })).toBe(false)
  })
  it('retries a nonzero exit', () => {
    expect(core.shouldRetryCodex({ ok: false, rc: 1 })).toBe(true)
  })
  it('retries rc 0 with empty content (ok=false)', () => {
    expect(core.shouldRetryCodex({ ok: false, rc: 0 })).toBe(true)
  })
  it('retries a missing rc marker (relay failure)', () => {
    expect(core.shouldRetryCodex({ ok: false, rc: null })).toBe(true)
  })
  it('does NOT retry the poll-budget timeout (rc 124) — a second hour-long grind will not fix "too large"', () => {
    expect(core.shouldRetryCodex({ ok: false, rc: 124 })).toBe(false)
  })
})

// ─── agreementProblem ────────────────────────────────────────────────────────
describe('agreementProblem', () => {
  it('accepts all-verified, nothing missed', () => {
    expect(core.agreementProblem({ verifiedFindings: [{ codexClaim: 'x', verified: true, evidence: 'f:1' }], missedFindings: [] })).toBeNull()
  })
  it('rejects unverified findings', () => {
    expect(core.agreementProblem({ verifiedFindings: [{ codexClaim: 'x', verified: false, evidence: '?' }] })).toMatch(/unverified/)
  })
  it('rejects unaddressed missed findings', () => {
    expect(core.agreementProblem({ verifiedFindings: [{ codexClaim: 'x', verified: true, evidence: 'f:1' }], missedFindings: ['y'] })).toMatch(/unaddressed/)
  })
  it('rejects an empty list by default (lazy agreement)', () => {
    expect(core.agreementProblem({ verifiedFindings: [] })).toMatch(/no findings/)
  })
  it('ACCEPTS a genuinely clean review when independentlyClean is affirmed', () => {
    expect(core.agreementProblem({ verifiedFindings: [], missedFindings: [], independentlyClean: true })).toBeNull()
  })
  it('still rejects independentlyClean if something was missed', () => {
    expect(core.agreementProblem({ verifiedFindings: [], missedFindings: ['z'], independentlyClean: true })).toMatch(/no findings|unaddressed/)
  })
})

// ─── buildCritique ───────────────────────────────────────────────────────────
describe('buildCritique', () => {
  it('prefers an explicit critiqueForCodex', () => {
    expect(core.buildCritique({ critiqueForCodex: 'do X' }, null)).toBe('do X')
  })
  it('assembles from unverified + missed', () => {
    const out = core.buildCritique({ verifiedFindings: [{ codexClaim: 'a', verified: false, evidence: 'e' }], missedFindings: ['m'] }, null)
    expect(out).toContain('UNVERIFIED')
    expect(out).toContain('MISSED')
  })
  it('uses the demote reason when nothing else is present', () => {
    expect(core.buildCritique({ verifiedFindings: [] }, 'no findings were enumerated')).toMatch(/Cannot accept agreement/)
  })
})

// ─── decideResumeAction (pure resume state-machine) ──────────────────────────
describe('decideResumeAction', () => {
  const SID = '019ee36e-742e-7272-9252-de4a771df7b2'
  const claude = (content: string, round = 3) => ({ agent: 'claude', round, content })
  const codex = (content: string, round = 3) => ({ agent: 'codex', round, content })
  const human = (content: string, round = 3) => ({ agent: 'human', round, content })
  const st = (over: Partial<core.ResumeState> = {}): core.ResumeState =>
    ({ target: 'docs/x.md', history: [], codexSessionId: SID, round: 3, pausedReason: undefined, ...over })

  it('errors when paused on a human question and no humanAnswer was given — message repeats the question', () => {
    const d = core.decideResumeAction(
      st({ history: [codex('r'), claude('[ASKED HUMAN] Is the cutover date fixed?')], pausedReason: 'needs_human' }),
      { maxRounds: 3, humanAnswer: null },
    )
    expect(d.action).toBe('error')
    expect((d as any).message).toContain('Is the cutover date fixed?')
    expect((d as any).message).not.toContain('[ASKED HUMAN]')
    expect((d as any).message).toContain('humanAnswer')
    expect((d as any).message).toContain('docs/x.md')
  })
  it('answer_human when paused on a human question and an answer was given', () => {
    const d = core.decideResumeAction(
      st({ history: [claude('[ASKED HUMAN] Q?')], pausedReason: 'needs_human' }),
      { maxRounds: 3, humanAnswer: 'yes, fixed' },
    )
    expect(d).toEqual({ action: 'answer_human' })
  })
  it('the [ASKED HUMAN] prefix is the discriminator — no trailing-space requirement', () => {
    const d = core.decideResumeAction(st({ history: [claude('[ASKED HUMAN]tight')] }), { maxRounds: 3, humanAnswer: null })
    expect(d.action).toBe('error')
  })
  it('needs_approval when paused at the round cap and maxRounds was not raised', () => {
    const d = core.decideResumeAction(
      st({ history: [claude('critique text')], pausedReason: 'needs_approval', round: 3 }),
      { maxRounds: 3, humanAnswer: null },
    )
    expect(d.action).toBe('needs_approval')
    expect((d as any).message).toContain('maxRounds: 5') // round + 2 suggested
    expect((d as any).message).toContain('3-round cap')
  })
  it('replay_critique WITHOUT a bump when maxRounds was raised above the completed rounds (approval given)', () => {
    const d = core.decideResumeAction(
      st({ history: [claude('critique text')], pausedReason: 'needs_approval', round: 3 }),
      { maxRounds: 5, humanAnswer: null },
    )
    expect(d).toEqual({ action: 'replay_critique', bumpMaxRoundsTo: null })
  })
  it('replay_critique WITH a one-round bump on a failure retry at the cap (codex_failed)', () => {
    const d = core.decideResumeAction(
      st({ history: [claude('critique text')], pausedReason: 'codex_failed', round: 3 }),
      { maxRounds: 3, humanAnswer: null },
    )
    expect(d).toEqual({ action: 'replay_critique', bumpMaxRoundsTo: 4 })
  })
  it('replay_critique with no bump on a failure retry below the cap', () => {
    const d = core.decideResumeAction(
      st({ history: [claude('critique text')], pausedReason: 'codex_failed', round: 2 }),
      { maxRounds: 3, humanAnswer: null },
    )
    expect(d).toEqual({ action: 'replay_critique', bumpMaxRoundsTo: null })
  })
  it('resume_failed when a claude critique is pending but no session id was captured', () => {
    const d = core.decideResumeAction(
      st({ history: [claude('critique text')], codexSessionId: null, pausedReason: 'resume_failed' }),
      { maxRounds: 3, humanAnswer: null },
    )
    expect(d.action).toBe('resume_failed')
    expect((d as any).message).toMatch(/no Codex session id/)
  })
  it('the needs_approval gate outranks the missing-sid check (matches the original inline order)', () => {
    const d = core.decideResumeAction(
      st({ history: [claude('critique text')], codexSessionId: null, pausedReason: 'needs_approval', round: 3 }),
      { maxRounds: 3, humanAnswer: null },
    )
    expect(d.action).toBe('needs_approval')
  })
  it('proceed when the last turn is Codex (nothing pending)', () => {
    expect(core.decideResumeAction(st({ history: [claude('c'), codex('reply')] }), { maxRounds: 3, humanAnswer: null }))
      .toEqual({ action: 'proceed' })
  })
  it('proceed when the last turn is a human answer', () => {
    expect(core.decideResumeAction(st({ history: [claude('[ASKED HUMAN] Q?'), human('Human answer to the open question: yes')] }), { maxRounds: 3, humanAnswer: null }))
      .toEqual({ action: 'proceed' })
  })
  it('proceed on an empty history', () => {
    expect(core.decideResumeAction(st({ history: [] }), { maxRounds: 3, humanAnswer: null })).toEqual({ action: 'proceed' })
    expect(core.decideResumeAction(st({ history: undefined }), { maxRounds: 3, humanAnswer: null })).toEqual({ action: 'proceed' })
  })
})

// ─── checkStaleness (resume content-identity gate) ───────────────────────────
describe('checkStaleness', () => {
  it('not stale when ids match', () => {
    expect(core.checkStaleness('abc', 'abc', false)).toEqual({ stale: false, block: false })
  })
  it('unknown ids never block (version-2 state, hash/gh failure)', () => {
    expect(core.checkStaleness('', 'abc', false)).toEqual({ stale: false, block: false })
    expect(core.checkStaleness('abc', '', false)).toEqual({ stale: false, block: false })
    expect(core.checkStaleness('', '', false)).toEqual({ stale: false, block: false })
    expect(core.checkStaleness(undefined, 'abc', false)).toEqual({ stale: false, block: false })
    expect(core.checkStaleness(null, 'abc', false)).toEqual({ stale: false, block: false })
  })
  it('differing ids are stale and BLOCK by default', () => {
    expect(core.checkStaleness('abc', 'def', false)).toEqual({ stale: true, block: true })
  })
  it('allowStale keeps stale=true but unblocks', () => {
    expect(core.checkStaleness('abc', 'def', true)).toEqual({ stale: true, block: false })
  })
})

// ─── heredocDelim (injection: no early heredoc termination) ──────────────────
describe('heredocDelim', () => {
  it('is deterministic', () => {
    expect(core.heredocDelim('a\nb')).toBe(core.heredocDelim('a\nb'))
  })
  it('never collides with a body line — including the old fixed delimiter', () => {
    for (const body of ['plain', 'a\n__ADV_COMMENT_EOF__\nrm -rf ~', '🔬 emoji\nADV_EOF_x', '', 'one']) {
      const d = core.heredocDelim(body)
      expect(d.startsWith('ADV_EOF_')).toBe(true)
      expect(body.split('\n')).not.toContain(d) // the heredoc cannot be terminated by body
    }
  })
})

// ─── splitFindingsByCitation (FAIL CLOSED: confirmed ⟺ every ref resolves) ────
describe('splitFindingsByCitation', () => {
  const audit = [
    { ref: 'a.ts:5', status: 'ok' },
    { ref: 'b.ts:9', status: 'nofile' },
    { ref: 'c.ts:3', status: 'badline' },
  ]
  it('confirms only findings whose every parsed ref has an ok result', () => {
    const findings = [
      { id: 0, citation: 'a.ts:5' },                 // ok → confirmed
      { id: 1, citation: 'b.ts:9' },                 // nofile → unresolved
      { id: 2, citation: 'see c.ts:3 vs a.ts:5' },   // one bad ref → unresolved
      { id: 3, citation: 'prose, no file:line' },    // no parsable ref → unresolved (fail closed)
      { id: 4 },                                     // no citation → unresolved (fail closed)
      { id: 5, citation: 'd.ts:7' },                 // ref absent from audit → unresolved (fail closed)
    ]
    const { confirmed, unresolved } = core.splitFindingsByCitation(findings, audit)
    expect(confirmed.map((f: any) => f.id)).toEqual([0])
    expect(unresolved.map((f: any) => f.id)).toEqual([1, 2, 3, 4, 5])
  })
  it('fails closed (all unverified) when the audit is missing entirely', () => {
    const { confirmed, unresolved } = core.splitFindingsByCitation([{ citation: 'x.ts:1' }], undefined)
    expect(confirmed).toHaveLength(0)
    expect(unresolved).toHaveLength(1)
  })
})

// ─── summarizeAudit (FAIL CLOSED: resolved ⟺ explicit ok for every requested ref) ─
describe('summarizeAudit', () => {
  const refs = ['a.ts:5', 'b.ts:9']
  it('all ok → nothing unresolved', () => {
    expect(core.summarizeAudit(refs, [{ ref: 'a.ts:5', status: 'ok' }, { ref: 'b.ts:9', status: 'ok' }]))
      .toEqual({ checked: 2, unresolved: 0, badRefs: [] })
  })
  it('a non-ok status is unresolved', () => {
    expect(core.summarizeAudit(refs, [{ ref: 'a.ts:5', status: 'ok' }, { ref: 'b.ts:9', status: 'nofile' }]).badRefs).toEqual(['b.ts:9'])
  })
  it('fails closed on an EMPTY results[] — previously counted as "all clear"', () => {
    expect(core.summarizeAudit(refs, [])).toEqual({ checked: 2, unresolved: 2, badRefs: refs })
  })
  it('fails closed on a PARTIAL audit — unreported refs count as unresolved', () => {
    expect(core.summarizeAudit(refs, [{ ref: 'a.ts:5', status: 'ok' }]).badRefs).toEqual(['b.ts:9'])
  })
  it('fails closed on conflicting duplicate results for one ref', () => {
    expect(core.summarizeAudit(['a.ts:5'], [{ ref: 'a.ts:5', status: 'ok' }, { ref: 'a.ts:5', status: 'badline' }]).unresolved).toBe(1)
  })
  it('ignores results for refs that were never requested', () => {
    expect(core.summarizeAudit(['a.ts:5'], [{ ref: 'a.ts:5', status: 'ok' }, { ref: 'evil.ts:1', status: 'ok' }]))
      .toEqual({ checked: 1, unresolved: 0, badRefs: [] })
  })
  it('handles undefined results and empty refs', () => {
    expect(core.summarizeAudit(refs, undefined)).toEqual({ checked: 2, unresolved: 2, badRefs: refs })
    expect(core.summarizeAudit([], [])).toEqual({ checked: 0, unresolved: 0, badRefs: [] })
  })
})

// ─── postCommentScript (injection-safe + author-scoped idempotent upsert) ─────
describe('postCommentScript', () => {
  const body = 'hello\n__ADV_COMMENT_EOF__\nrm -rf ~ # not executed\n🔬'
  const script = () => core.postCommentScript('256', core.COMMENT_MARKER, body)
  it('wraps the body in a collision-proof quoted heredoc', () => {
    const d = core.heredocDelim(body)
    expect(script()).toContain(`cat > "$BODY" <<'${d}'\n${body}\n${d}\n`)
    expect(body.split('\n')).not.toContain(d)
  })
  it('scopes the upsert to the gh user AND the marker (no third-party hijack)', () => {
    const s = script()
    expect(s).toContain('ME="$(gh api user -q .login')
    expect(s).toContain('.user.login == env.ME')
    expect(s).toContain(core.COMMENT_MARKER)
  })
  it('has both an update (PATCH existing) and create branch', () => {
    const s = script()
    expect(s).toContain('gh api --method PATCH "repos/$REPO/issues/comments/$CID"')
    expect(s).toContain('gh pr comment 256 --body-file')
  })
  it('fails closed: create is gated behind repo+identity+lookup success', () => {
    const s = script()
    // missing repo identity → fail, never reach create
    expect(s).toContain('if [ -z "$REPO" ] || [ -z "$ME" ]; then adv_fail; else')
    // lookup exit status captured directly (not through the `| head` pipe) and gated
    expect(s).toContain('2>/dev/null)"; LRC=$?')
    expect(s).toContain('if [ "$LRC" -ne 0 ]; then rm -f "$BODY"; adv_fail; else')
    // the create branch lives INSIDE the LRC-ok block (so a failed lookup can't create)
    expect(s.indexOf('LRC=$?')).toBeLessThan(s.indexOf('gh pr comment 256'))
  })
})

// ─── buildCommentBody (summary comment renderer + audit-locus caveat) ─────────
describe('buildCommentBody', () => {
  const syn: core.SynthesisLike = {
    summary: 'One-line summary.',
    agreedFindings: [
      { finding: 'F-ok', severity: 'high', actionItem: 'fix it', citation: 'a.ts:5' },
      { finding: 'F-bad', severity: 'critical', actionItem: 'check it', citation: 'b.ts:9' },
    ],
    unresolvedPoints: [{ point: 'P1', codexView: 'cv', claudeView: 'clv' }],
    prioritizedActionItems: ['do x first'],
  }
  const audit: core.CitationAuditLike = {
    checked: 2, unresolved: 1, badRefs: ['b.ts:9'],
    results: [{ ref: 'a.ts:5', status: 'ok' }, { ref: 'b.ts:9', status: 'nofile' }],
  }

  it('carries the marker, status counts, and fail-closed confirmed/unverified buckets', () => {
    const body = core.buildCommentBody(syn, audit, true, 2, false)
    expect(body).toContain(core.COMMENT_MARKER)
    expect(body).toContain('✅ Full agreement after 2 round(s)')
    expect(body).toContain('**1** confirmed · **1** unverified · **1** disputed')
    // confirmed section lists the resolving finding; unresolved bucket the other
    expect(body.indexOf('F-ok')).toBeGreaterThan(body.indexOf('### ✅ Confirmed findings'))
    expect(body.indexOf('F-bad')).toBeGreaterThan(body.indexOf('citation not verified'))
    expect(body).toContain('- **P1**')
    expect(body).toContain('1. do x first')
  })
  it('audit caveat is checkout-relative when auditedPrHead=false (keeps the not-on-this-branch excuse)', () => {
    const body = core.buildCommentBody(syn, audit, true, 2, false)
    expect(body).toContain('did not resolve against the current checkout')
    expect(body).toContain('not on this branch')
    expect(body).not.toContain('PR head')
  })
  it('audit caveat says PR head when auditedPrHead=true — the branch-mismatch excuse disappears', () => {
    const body = core.buildCommentBody(syn, audit, true, 2, true)
    expect(body).toContain('did not resolve against the PR head')
    expect(body).not.toContain('not on this branch')
    expect(body).not.toContain('current checkout')
  })
  it('no audit caveat when everything resolved (either locus)', () => {
    const clean: core.CitationAuditLike = { checked: 1, unresolved: 0, badRefs: [], results: [{ ref: 'a.ts:5', status: 'ok' }] }
    for (const flag of [true, false]) {
      const body = core.buildCommentBody(syn, clean, false, 3, flag)
      expect(body).toContain('⚠️ 3 round(s), no full agreement')
      expect(body).not.toContain('did not resolve')
    }
  })
  it('tolerates an empty synthesis and a missing audit (everything unverified, no caveat)', () => {
    const body = core.buildCommentBody({}, undefined, false, 0, false)
    expect(body).toContain('_None._')
    expect(body).toContain('**0** confirmed · **0** unverified · **0** disputed')
  })
})

// ─── DRIFT GUARD ─────────────────────────────────────────────────────────────
// The workflow inlines copies of these helpers (it cannot import). Extract that
// block and assert behavioural parity with the canonical core across shared
// vectors, so the two can never silently diverge.
describe('workflow inline helpers mirror core.ts (drift guard)', () => {
  const src = readFileSync(WORKFLOW_PATH, 'utf8')
  const block = src.split('// <core-mirror>')[1]?.split('// </core-mirror>')[0]

  it('the workflow contains a // <core-mirror> … // </core-mirror> block', () => {
    expect(block, 'workflow must wrap its inlined helpers in core-mirror sentinels').toBeTruthy()
  })

  it('inline helpers behave identically to core for every vector', () => {
    const inline: any = new Function(
      `${block}\n;return { parseArgs, validateTarget, shortHash, makeStateKey, shq, parseCodex, codexLaunchCmd, codexPollCmd, codexHarvestCmd, shouldRetryCodex, agreementProblem, buildCritique, decideResumeAction, checkStaleness, COMMENT_MARKER, heredocDelim, splitFindingsByCitation, summarizeAudit, postCommentScript, buildCommentBody };`
    )()

    const argVectors = [{ target: '249', maxRounds: 3 }, '{"target":"249","resume":true}', 'docs/x.md', '{bad', undefined]
    for (const v of argVectors) expect(inline.parseArgs(v)).toEqual(core.parseArgs(v))

    const tgtVectors = ['249', 'docs/a.md', '../x', '/x', 'a;b', '']
    for (const v of tgtVectors) expect(inline.validateTarget(v)).toEqual(core.validateTarget(v))

    const keyVectors: Array<[string, boolean, string]> = [['249', true, '/r'], ['docs/a/b.md', false, '/r'], ['docs/a_b.md', false, '/r'], ['249', true, '/other']]
    for (const [t, p, r] of keyVectors) expect(inline.makeStateKey(t, p, r)).toBe(core.makeStateKey(t, p, r))

    const shqVectors = ['hello', "x'; rm -rf / #", '`$HOME`\n$(x)']
    for (const v of shqVectors) expect(inline.shq(v)).toBe(core.shq(v))

    const codexVectors = [
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings\n@@@CODEX_SESSION_ID@@@\n019ee36e-742e-7272-9252-de4a771df7b2',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nquotes @@@CODEX_SESSION_ID@@@ inside\n@@@CODEX_SESSION_ID@@@\n019ee36e-742e-7272-9252-de4a771df7b2',
      '@@@CODEX_RC@@@1\n@@@CODEX_OUTPUT@@@\n\n@@@CODEX_SESSION_ID@@@\n',
      // issue #4 shapes: hoisted-above-output, fenced one-line, bare-uuid (now null — no tier-3 fallback), none
      '@@@CODEX_RC@@@0\n@@@CODEX_SESSION_ID@@@ 019f1bfd-144e-7f32-8677-3cba2c0a4f13\n\n@@@CODEX_OUTPUT@@@\nfindings',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings\n\n@@@CODEX_SESSION_ID@@@019ee36e-742e-7272-9252-de4a771df7b2@@@END_SID@@@',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nThe @@@CODEX_SESSION_ID@@@ marker\n@@@CODEX_SESSION_ID@@@019ee36e-742e-7272-9252-de4a771df7b2@@@END_SID@@@',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings\nsession 019f1bfd-144e-7f32-8677-3cba2c0a4f13',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\njust findings, no uuid',
      // stderr diagnostic channel shapes: failure with stderr, multi-line, last-wins,
      // stderr-after-OUTPUT stripped from content, empty fence, unterminated marker
      '@@@CODEX_RC@@@1\n@@@CODEX_OUTPUT@@@\n\n@@@CODEX_STDERR@@@codex: auth token expired@@@END_STDERR@@@',
      '@@@CODEX_RC@@@1\n@@@CODEX_STDERR@@@line one\nline two@@@END_STDERR@@@',
      '@@@CODEX_RC@@@1\n@@@CODEX_STDERR@@@first@@@END_STDERR@@@\n@@@CODEX_OUTPUT@@@\n\n@@@CODEX_STDERR@@@second@@@END_STDERR@@@',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings here\n@@@CODEX_STDERR@@@warning: slow@@@END_STDERR@@@\n@@@CODEX_SESSION_ID@@@019ee36e-742e-7272-9252-de4a771df7b2@@@END_SID@@@',
      '@@@CODEX_RC@@@1\n@@@CODEX_STDERR@@@@@@END_STDERR@@@',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nprose mentions @@@CODEX_STDERR@@@ without a fence',
    ]
    for (const v of codexVectors) expect(inline.parseCodex(v)).toEqual(core.parseCodex(v))

    // Launch/poll/harvest builders + retry policy
    const FLAGS = '-c model="gpt-5.5" -c model_reasoning_effort="high"'
    const RESUME_SID = '019ee36e-742e-7272-9252-de4a771df7b2'
    const launchVectors: Array<[string, string | null, string]> = [
      [core.shq('review this'), null, ''],
      [core.shq("it's a prompt"), RESUME_SID, ''],
      [core.shq('p'), null, '/home/u/.claude/adversarial-review-state/worktrees/pr-9-abc12345'],
      [core.shq('p'), RESUME_SID, '/home/u/.claude/adversarial-review-state/worktrees/pr-9-abc12345'],
    ]
    for (const [p, s, r] of launchVectors) expect(inline.codexLaunchCmd(FLAGS, p, s, r)).toBe(core.codexLaunchCmd(FLAGS, p, s, r))
    for (const d of ['/tmp/adv_run.abc123', '__RUNDIR__']) {
      expect(inline.codexPollCmd(d)).toBe(core.codexPollCmd(d))
      expect(inline.codexHarvestCmd(d, true)).toBe(core.codexHarvestCmd(d, true))
      expect(inline.codexHarvestCmd(d, false)).toBe(core.codexHarvestCmd(d, false))
    }
    const retryVectors = [
      { ok: true, rc: 0 }, { ok: false, rc: 1 }, { ok: false, rc: 0 },
      { ok: false, rc: null }, { ok: false, rc: 124 },
    ]
    for (const v of retryVectors) expect(inline.shouldRetryCodex(v)).toBe(core.shouldRetryCodex(v))

    const agreeVectors = [
      { verifiedFindings: [{ codexClaim: 'x', verified: true, evidence: 'f:1' }], missedFindings: [] },
      { verifiedFindings: [{ codexClaim: 'x', verified: false, evidence: '?' }] },
      { verifiedFindings: [], independentlyClean: true, missedFindings: [] },
      { verifiedFindings: [] },
    ]
    for (const v of agreeVectors) expect(inline.agreementProblem(v)).toBe(core.agreementProblem(v))

    const critVectors: Array<[any, string | null]> = [
      [{ critiqueForCodex: 'do X' }, null],
      [{ verifiedFindings: [{ codexClaim: 'a', verified: false, evidence: 'e' }], missedFindings: ['m'] }, null],
      [{ verifiedFindings: [] }, 'reason'],
    ]
    for (const [c, d] of critVectors) expect(inline.buildCritique(c, d)).toBe(core.buildCritique(c, d))

    // Resume state-machine: one vector per action + the ordering edge cases
    const cl = (content: string) => ({ agent: 'claude', round: 3, content })
    const cx = (content: string) => ({ agent: 'codex', round: 3, content })
    const SID = '019ee36e-742e-7272-9252-de4a771df7b2'
    const resumeVectors: Array<[any, any]> = [
      [{ target: 'docs/x.md', history: [cl('[ASKED HUMAN] Q?')], codexSessionId: SID, round: 3, pausedReason: 'needs_human' }, { maxRounds: 3, humanAnswer: null }],
      [{ target: 'docs/x.md', history: [cl('[ASKED HUMAN] Q?')], codexSessionId: SID, round: 3, pausedReason: 'needs_human' }, { maxRounds: 3, humanAnswer: 'yes' }],
      [{ target: '242', history: [cl('critique')], codexSessionId: SID, round: 3, pausedReason: 'needs_approval' }, { maxRounds: 3, humanAnswer: null }],
      [{ target: '242', history: [cl('critique')], codexSessionId: SID, round: 3, pausedReason: 'needs_approval' }, { maxRounds: 5, humanAnswer: null }],
      [{ target: '242', history: [cl('critique')], codexSessionId: SID, round: 3, pausedReason: 'codex_failed' }, { maxRounds: 3, humanAnswer: null }],
      [{ target: '242', history: [cl('critique')], codexSessionId: SID, round: 2, pausedReason: 'codex_failed' }, { maxRounds: 3, humanAnswer: null }],
      [{ target: '242', history: [cl('critique')], codexSessionId: null, round: 3, pausedReason: 'resume_failed' }, { maxRounds: 3, humanAnswer: null }],
      [{ target: '242', history: [cl('critique')], codexSessionId: null, round: 3, pausedReason: 'needs_approval' }, { maxRounds: 3, humanAnswer: null }],
      [{ target: '242', history: [cl('c'), cx('reply')], codexSessionId: SID, round: 3, pausedReason: 'codex_failed' }, { maxRounds: 3, humanAnswer: null }],
      [{ target: '242', history: [], codexSessionId: SID, round: 0, pausedReason: undefined }, { maxRounds: 3, humanAnswer: null }],
    ]
    for (const [s, o] of resumeVectors) expect(inline.decideResumeAction(s, o)).toEqual(core.decideResumeAction(s, o))

    const staleVectors: Array<[any, any, boolean]> = [
      ['abc', 'abc', false], ['abc', 'def', false], ['abc', 'def', true],
      ['', 'abc', false], ['abc', '', false], ['', '', false], [undefined, 'abc', false],
    ]
    for (const [a, b, allow] of staleVectors) expect(inline.checkStaleness(a, b, allow)).toEqual(core.checkStaleness(a, b, allow))

    // Summary-comment helpers (mirrored from core.ts; injection-critical)
    expect(inline.COMMENT_MARKER).toBe(core.COMMENT_MARKER)

    const bodyVectors = ['plain', 'a\n__ADV_COMMENT_EOF__\nx', '🔬\nADV_EOF_x', '', 'l1\nl2\nl3']
    for (const b of bodyVectors) expect(inline.heredocDelim(b)).toBe(core.heredocDelim(b))

    const splitVectors: Array<[any[], any[]]> = [
      [[{ id: 0, citation: 'a.ts:5' }, { id: 1, citation: 'b.ts:9' }, { id: 2 }], [{ ref: 'a.ts:5', status: 'ok' }, { ref: 'b.ts:9', status: 'nofile' }]],
      [[{ citation: 'see c.ts:3 vs a.ts:5' }], [{ ref: 'c.ts:3', status: 'badline' }]],
    ]
    for (const [f, a] of splitVectors) expect(inline.splitFindingsByCitation(f, a)).toEqual(core.splitFindingsByCitation(f, a))

    const auditVectors: Array<[string[], any]> = [
      [['a.ts:5', 'b.ts:9'], [{ ref: 'a.ts:5', status: 'ok' }, { ref: 'b.ts:9', status: 'ok' }]],
      [['a.ts:5', 'b.ts:9'], [{ ref: 'a.ts:5', status: 'ok' }]],
      [['a.ts:5'], []],
      [['a.ts:5'], [{ ref: 'a.ts:5', status: 'ok' }, { ref: 'a.ts:5', status: 'badline' }]],
      [[], undefined],
    ]
    for (const [r, a] of auditVectors) expect(inline.summarizeAudit(r, a)).toEqual(core.summarizeAudit(r, a))

    for (const b of bodyVectors) expect(inline.postCommentScript('256', inline.COMMENT_MARKER, b)).toBe(core.postCommentScript('256', core.COMMENT_MARKER, b))

    // buildCommentBody (severity sort, fail-closed buckets, audit-locus caveat)
    const synV = {
      summary: 'sum\nmary',
      agreedFindings: [
        { finding: 'F-ok', severity: 'high', actionItem: 'fix', citation: 'a.ts:5' },
        { finding: 'F-bad', severity: 'critical', actionItem: 'check', citation: 'b.ts:9' },
        { finding: 'F-prose', severity: 'weird', citation: 'no ref here' },
      ],
      unresolvedPoints: [{ point: 'P', codexView: 'cv', claudeView: 'clv' }],
      prioritizedActionItems: ['do x'],
    }
    const auditV = {
      checked: 2, unresolved: 1, badRefs: ['b.ts:9'],
      results: [{ ref: 'a.ts:5', status: 'ok' }, { ref: 'b.ts:9', status: 'nofile' }],
    }
    const commentVectors: Array<[any, any, boolean, number, boolean]> = [
      [synV, auditV, true, 2, false],
      [synV, auditV, true, 2, true],
      [synV, { checked: 1, unresolved: 0, badRefs: [], results: [{ ref: 'a.ts:5', status: 'ok' }] }, false, 3, true],
      [{}, undefined, false, 0, false],
    ]
    for (const [sy, au, ag, ro, ph] of commentVectors) expect(inline.buildCommentBody(sy, au, ag, ro, ph)).toBe(core.buildCommentBody(sy, au, ag, ro, ph))
  })
})
