// Canonical pure helpers for the adversarial-review workflow.
//
// The Workflow runtime forbids `import()` inside workflow scripts, so
// `../workflows/adversarial-review.js` cannot import this module — it
// inlines byte-equivalent copies of these functions inside a
// `// <core-mirror> … // </core-mirror>` block. The drift-guard in
// `__tests__/core.test.ts` extracts that block and asserts behavioural parity
// against these exports, so the two copies can never silently diverge.
//
// Keep every function here PURE (no I/O, no closures over outer state) so both
// copies are trivially testable.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

export interface ParsedArgs {
  target?: string
  maxRounds?: number
  resume?: boolean
  humanAnswer?: string
  /** Opt-in: post the synthesized result as a single summary comment on the PR
   *  (PR targets only; ignored for file targets). */
  comment?: boolean
}

/** Tolerant arg parsing — the tool boundary may deliver an object, a JSON
 *  string, or a bare target string. */
export function parseArgs(args: unknown): ParsedArgs {
  let a: any = args
  if (typeof a === 'string') {
    const t = a.trim()
    if (t.startsWith('{')) {
      try { a = JSON.parse(t) } catch { a = { target: t } }
    } else {
      a = { target: t }
    }
  }
  return a || {}
}

/** Classify + validate a target. File targets must be repo-relative with no
 *  shell metacharacters, no `..`, and no leading `/`. */
export function validateTarget(target: string): { isPR: boolean; valid: boolean; error?: string } {
  if (!target) return { isPR: false, valid: false, error: 'No target provided.' }
  const isPR = /^\d+$/.test(String(target).trim())
  if (!isPR && (/[^A-Za-z0-9._/-]/.test(target) || target.includes('..') || target.startsWith('/'))) {
    return { isPR: false, valid: false, error: `Invalid file target "${target}".` }
  }
  return { isPR, valid: true }
}

/** Stable, dependency-free string hash (djb2-xor) → base36. */
export function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** State-file key. Includes a hash of repo identity + exact target so distinct
 *  targets (and same PR number across different repos) never collide. */
export function makeStateKey(target: string, isPR: boolean, repoId: string): string {
  const base = (isPR ? `pr-${target}` : `file-${target}`).replace(/[^A-Za-z0-9._-]/g, '_')
  return `${base}-${shortHash(`${repoId}::${isPR ? 'pr' : 'file'}::${target}`)}`
}

/** POSIX single-quote escape — neutralises $, backticks, quotes, newlines. */
export function shq(s: unknown): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** Extract the Codex session id from a `codex exec --json` stdout stream
 *  (first event: {"type":"thread.started","thread_id":"<uuid>"}). */
export function extractThreadId(eventsRaw: string): string | null {
  const m = eventsRaw.match(/"thread_id"\s*:\s*"([0-9a-f-]{36})"/)
  return m ? (m[1].match(UUID_RE)?.[0] || null) : null
}

export interface CodexResult { content: string; sessionId: string | null; rc: number | null; ok: boolean }

/** Parse a codex-runner subagent's return text. The review body can itself
 *  quote the delimiters (e.g. when Codex reviews this workflow), so OUTPUT is
 *  taken after its FIRST marker (rejoining later quotes). Never a 2-element
 *  destructure.
 *
 *  Session-id capture is ORDER-INDEPENDENT (issue #4). The general-purpose
 *  subagent that runs the codex bash acts as an untrusted transport: it can
 *  reformat the raw stdout and, in the wild, hoisted `@@@CODEX_SESSION_ID@@@`
 *  (uuid inline, space-separated) into a header block ABOVE `@@@CODEX_OUTPUT@@@`.
 *  The old parser read the id only from the text AFTER `@@@CODEX_OUTPUT@@@`, so a
 *  reordered marker vanished → codexSessionId=null → resume_failed after round 1.
 *  We now scan the WHOLE raw, most-specific first, taking the LAST match at each
 *  tier (the real id is emitted last, so a body that QUOTES an earlier marker or
 *  uuid cannot shadow it):
 *    1. fenced  `@@@CODEX_SESSION_ID@@@<uuid>@@@END_SID@@@`  — the emitted form;
 *       prose that mentions the bare marker won't carry the closing fence.
 *    2. marker + uuid (any whitespace, any position) — tolerates a stripped fence.
 *    3. bare trailing uuid — last resort when the marker was stripped entirely. */
export function parseCodex(raw: string): CodexResult {
  const rcM = raw.match(/@@@CODEX_RC@@@(-?\d+)/)
  const rc = rcM ? parseInt(rcM[1], 10) : null
  const afterOut = raw.includes('@@@CODEX_OUTPUT@@@')
    ? raw.split('@@@CODEX_OUTPUT@@@').slice(1).join('@@@CODEX_OUTPUT@@@')
    : raw
  const sidParts = afterOut.split('@@@CODEX_SESSION_ID@@@')
  const content = (sidParts.length > 1 ? sidParts.slice(0, -1).join('@@@CODEX_SESSION_ID@@@') : afterOut).trim()
  const U = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  const pickLast = (re: RegExp): string | null => {
    let m: RegExpExecArray | null, last: string | null = null
    while ((m = re.exec(raw)) !== null) last = m[1]
    return last ? last.toLowerCase() : null
  }
  const sessionId =
    pickLast(new RegExp(`@@@CODEX_SESSION_ID@@@\\s*(${U})\\s*@@@END_SID@@@`, 'gi')) ||
    pickLast(new RegExp(`@@@CODEX_SESSION_ID@@@\\s*(${U})`, 'gi')) ||
    pickLast(new RegExp(`(${U})`, 'gi'))
  return { content, sessionId, rc, ok: rc === 0 && content.length > 0 }
}

export interface CritiqueResult {
  status?: string
  verifiedFindings?: Array<{ codexClaim: string; verified: boolean; evidence: string }>
  missedFindings?: string[]
  critiqueForCodex?: string
  independentlyClean?: boolean
}

/** Returns a reason string when an "agreed" verdict must be rejected, or null
 *  when agreement is valid. A genuinely clean review (no findings, nothing
 *  missed) is valid ONLY when the verifier explicitly affirms it
 *  independently reviewed and found nothing (`independentlyClean`). */
export function agreementProblem(cr: CritiqueResult): string | null {
  const vf = cr.verifiedFindings || []
  const missed = cr.missedFindings || []
  if (vf.length === 0) {
    if (cr.independentlyClean && missed.length === 0) return null
    return 'no findings were enumerated or verified'
  }
  const unverified = vf.filter((f) => !f.verified)
  if (unverified.length > 0) return `${unverified.length} finding(s) remain unverified`
  if (missed.length > 0) return `${missed.length} issue(s) you raised are still unaddressed by Codex`
  return null
}

/** Build the critique text sent back to Codex from a structured result. */
export function buildCritique(cr: CritiqueResult, demoteReason: string | null): string {
  if (cr.critiqueForCodex) return cr.critiqueForCodex
  const parts: string[] = []
  const unv = (cr.verifiedFindings || []).filter((f) => !f.verified)
  if (unv.length) parts.push('UNVERIFIED:\n' + unv.map((f) => `• ${f.codexClaim} — ${f.evidence}`).join('\n'))
  if ((cr.missedFindings || []).length) parts.push('MISSED:\n' + (cr.missedFindings || []).join('\n'))
  if (demoteReason && !parts.length) parts.push(`Cannot accept agreement yet: ${demoteReason}. Please re-examine.`)
  return parts.join('\n\n') || 'Please re-examine the findings.'
}

// ─── Summary-comment helpers (PR upsert) ─────────────────────────────────────
// Hidden HTML marker (invisible in rendered markdown) that tags the bot comment
// so a re-run updates it in place instead of stacking duplicates.
export const COMMENT_MARKER = '<!-- adversarial-review:auto -->'

const CITE_RE = /([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+):(\d+)/g

/** A heredoc delimiter guaranteed not to collide with any line of `body`. The
 *  body is model-generated and may legitimately quote a fixed delimiter (e.g.
 *  when the tool reviews its OWN workflow), which would otherwise terminate the
 *  heredoc early and execute the remainder as shell. Salt-rehash until no body
 *  line matches; the result is not attacker-influenceable (it hashes the whole
 *  body, so embedding the delimiter would change the delimiter). Throws rather
 *  than return an unchecked fallback if no safe delimiter is found — the caller
 *  is wrapped in try/catch (posting is non-fatal), so a throw degrades the
 *  comment to {posted:false}, never emits an injectable delimiter. */
export function heredocDelim(body: string): string {
  const lines = String(body).split('\n')
  for (let salt = 0; salt < 10000; salt++) {
    const d = `ADV_EOF_${shortHash(`${body}:${salt}`)}`
    if (!lines.includes(d)) return d
  }
  throw new Error('heredocDelim: no collision-free delimiter after 10000 attempts')
}

export interface AuditResult { ref: string; status: string }

/** Partition agreed findings into those whose citation was machine-verified
 *  against source vs those that were not. FAIL CLOSED: a finding is "confirmed"
 *  ONLY when it has at least one parsed `file:line` AND every one of those refs
 *  has an explicit `ok` audit result. Everything else — no parseable file:line
 *  (e.g. a "PR diff hunk" citation), a ref with no audit result, or a ref that
 *  did not resolve — goes to the unverified bucket. This keeps the comment from
 *  ever labelling a finding "confirmed" when its citation was not actually
 *  verified (the failure modes — missing/empty audit, unparsable citation — all
 *  resolve to unverified, not confirmed). */
export function splitFindingsByCitation<T extends { citation?: string }>(
  findings: T[],
  auditResults: AuditResult[] | undefined,
): { confirmed: T[]; unresolved: T[] } {
  const ok = new Set((auditResults || []).filter((r) => r && r.status === 'ok').map((r) => r.ref))
  const confirmed: T[] = []
  const unresolved: T[] = []
  for (const f of findings || []) {
    const cite = f && f.citation ? String(f.citation) : ''
    const refs = [...cite.matchAll(CITE_RE)].filter((m) => !m[1].includes('..')).map((m) => `${m[1]}:${m[2]}`)
    const verified = refs.length > 0 && refs.every((r) => ok.has(r))
    ;(verified ? confirmed : unresolved).push(f)
  }
  return { confirmed, unresolved }
}

export interface AuditRollup { checked: number; unresolved: number; badRefs: string[] }

/** FAIL-CLOSED roll-up of the citation audit for logs + result messages. A
 *  requested ref counts as resolved ONLY when the audit returned at least one
 *  result for it and every such result is `ok`. Refs the audit never reported
 *  on — the agent returned an empty or partial results[] — count as unresolved:
 *  an empty audit must read as "nothing was verified", never "all clear".
 *  Results for refs that were never requested are ignored. This mirrors the
 *  contract of splitFindingsByCitation (which buckets the PR comment); before
 *  this helper the checked/unresolved counts were computed from results[] alone
 *  and failed OPEN on an empty/partial audit while the comment failed closed,
 *  so the two surfaces could contradict each other. */
export function summarizeAudit(refs: string[], results: AuditResult[] | undefined): AuditRollup {
  const statuses = new Map<string, string[]>()
  for (const r of results || []) {
    if (!r || !r.ref) continue
    statuses.set(r.ref, [...(statuses.get(r.ref) || []), r.status])
  }
  const badRefs = refs.filter((ref) => {
    const st = statuses.get(ref)
    return !st || st.some((s) => s !== 'ok')
  })
  return { checked: refs.length, unresolved: badRefs.length, badRefs }
}

/** Build the bash that upserts the summary comment. Pure string assembly so the
 *  injection-critical bits are unit-testable. The body rides a quoted heredoc
 *  whose delimiter cannot appear in it (heredocDelim) — model text can neither
 *  expand NOR terminate the heredoc early. The upsert is author-scoped: only a
 *  prior comment authored by the gh user AND carrying the marker is updated, so
 *  a stray third-party comment quoting the marker is never hijacked. `target` is
 *  a digit-validated PR number and `marker` a fixed constant — neither is
 *  attacker-controlled — but both are interpolated into known-safe positions.
 *
 *  FAILS CLOSED: a comment is created ONLY when repo identity (REPO), gh identity
 *  (ME), AND the existing-comment lookup all succeeded. A transient failure of
 *  any prerequisite emits ACTION=failed instead of falling through to create —
 *  otherwise a blip in the lookup would post a DUPLICATE comment. The lookup's
 *  own exit status is captured directly (LRC), not through the `| head` pipe
 *  (whose status is always 0), so a failed fetch is distinguished from an empty
 *  result. */
export function postCommentScript(target: string, marker: string, body: string): string {
  const delim = heredocDelim(body)
  return [
    `REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"`,
    `ME="$(gh api user -q .login 2>/dev/null)"`,
    `adv_fail() { echo "@@@ADV_COMMENT_RC@@@1"; echo "@@@ADV_COMMENT_ACTION@@@failed"; echo "@@@ADV_COMMENT_URL@@@"; }`,
    `if [ -z "$REPO" ] || [ -z "$ME" ]; then adv_fail; else`,
    `export ME`,
    `BODY="$(mktemp -t adv_comment.XXXXXX)"`,
    `cat > "$BODY" <<'${delim}'`,
    body,
    delim,
    `LIST="$(gh api "repos/$REPO/issues/${target}/comments" --paginate -q '.[] | select(.user.login == env.ME and (.body | contains("${marker}"))) | .id' 2>/dev/null)"; LRC=$?`,
    `if [ "$LRC" -ne 0 ]; then rm -f "$BODY"; adv_fail; else`,
    `CID="$(printf '%s\\n' "$LIST" | head -1)"`,
    `if [ -n "$CID" ]; then`,
    `  URL="$(gh api --method PATCH "repos/$REPO/issues/comments/$CID" -F "body=@$BODY" -q .html_url 2>/dev/null)"; RC=$?; ACTION=updated`,
    `else`,
    `  URL="$(gh pr comment ${target} --body-file "$BODY" 2>/dev/null)"; RC=$?; ACTION=created`,
    `fi`,
    `rm -f "$BODY"`,
    `echo "@@@ADV_COMMENT_RC@@@$RC"; echo "@@@ADV_COMMENT_ACTION@@@$ACTION"; echo "@@@ADV_COMMENT_URL@@@$URL"`,
    `fi; fi`,
  ].join('\n')
}
