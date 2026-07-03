import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
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
  it('falls back to a bare trailing uuid when the marker was stripped entirely', () => {
    const raw = `@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings\nsession 019f1bfd-144e-7f32-8677-3cba2c0a4f13`
    expect(core.parseCodex(raw).sessionId).toBe('019f1bfd-144e-7f32-8677-3cba2c0a4f13')
  })
  it('never captures a session id when none is present', () => {
    expect(core.parseCodex('@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\njust findings, no uuid anywhere').sessionId).toBeNull()
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
      `${block}\n;return { parseArgs, validateTarget, shortHash, makeStateKey, shq, parseCodex, agreementProblem, buildCritique, COMMENT_MARKER, heredocDelim, splitFindingsByCitation, summarizeAudit, postCommentScript };`
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
      // issue #4 shapes: hoisted-above-output, fenced one-line, bare-uuid fallback, none
      '@@@CODEX_RC@@@0\n@@@CODEX_SESSION_ID@@@ 019f1bfd-144e-7f32-8677-3cba2c0a4f13\n\n@@@CODEX_OUTPUT@@@\nfindings',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings\n\n@@@CODEX_SESSION_ID@@@019ee36e-742e-7272-9252-de4a771df7b2@@@END_SID@@@',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nThe @@@CODEX_SESSION_ID@@@ marker\n@@@CODEX_SESSION_ID@@@019ee36e-742e-7272-9252-de4a771df7b2@@@END_SID@@@',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\nfindings\nsession 019f1bfd-144e-7f32-8677-3cba2c0a4f13',
      '@@@CODEX_RC@@@0\n@@@CODEX_OUTPUT@@@\njust findings, no uuid',
    ]
    for (const v of codexVectors) expect(inline.parseCodex(v)).toEqual(core.parseCodex(v))

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
  })
})
