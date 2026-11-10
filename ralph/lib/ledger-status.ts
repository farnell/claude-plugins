// Ledger task statuses every helper must agree on.
//
// `done`    — merged (or a gate ticked).
// `batched` — FOLDED into another task (`batched_into: "<host id>"`): its doc
//             section ships in the host's PR. The row stays in the ledger so a
//             fold is visible and accounted for (2026-11-10: a mid-run fold that
//             deleted two rows made the loop stop with "open tasks dropped from
//             13 to 11 with 0 merge(s)"). A batched row is closed: never run,
//             never parked, not counted as open. A dep on it is a dep on its host.
//
// Plain node (type stripping): imports nothing.

export const DONE = "done";
export const BATCHED = "batched";

export interface StatusTaskLike {
  id?: unknown;
  status?: unknown;
  batched_into?: unknown;
}

/** Closed = the loop never runs it again: done, or folded into another task. */
export function isClosed(t: StatusTaskLike): boolean {
  return t.status === DONE || t.status === BATCHED;
}

export function isBatched(t: StatusTaskLike): boolean {
  return t.status === BATCHED;
}

/**
 * The task a dep on `id` really waits on: follows `batched_into` from a batched
 * row to its host (a short chain is tolerated; a loop or a dangling host
 * resolves to the last id reached — the deps validator reports those).
 */
export function resolveHost(id: string, tasks: StatusTaskLike[]): string {
  const byId = new Map<string, StatusTaskLike>();
  for (const t of tasks) if (typeof t.id === "string" && !byId.has(t.id)) byId.set(t.id, t);
  let cur = id;
  const seen = new Set<string>();
  for (;;) {
    const t = byId.get(cur);
    if (!t || !isBatched(t) || typeof t.batched_into !== "string" || seen.has(cur)) return cur;
    seen.add(cur);
    cur = t.batched_into;
  }
}

/**
 * Ids a dep can count as met: every `done` task, plus every batched task whose
 * host is done (its section shipped in the host's PR).
 */
export function satisfiedIds(tasks: StatusTaskLike[]): Set<string> {
  const done = new Set(
    tasks.filter((t) => t.status === DONE && typeof t.id === "string").map((t) => t.id as string),
  );
  const out = new Set(done);
  for (const t of tasks) {
    if (isBatched(t) && typeof t.id === "string" && done.has(resolveHost(t.id, tasks))) out.add(t.id);
  }
  return out;
}
