// Ralph ledger dependency-graph validator.
//
// A malformed ledger fails SILENTLY today: a typo'd dep id, a task depending on
// itself, or a dependency cycle just makes tasks un-pickable forever, and the
// loop reports them as `parked` with reason `deps-not-met` — indistinguishable
// from a legitimate human-gate. This validator makes that FAIL LOUD, before any
// iteration runs.
//
// `validateLedgerDeps(ledger)` is a pure, deterministic function. The CLI
// wrapper at the bottom reads a ledger path from argv and exits non-zero on any
// problem. It is wired into the /ralph skill (derivation time) and the
// ralph-loop workflow preflight — see docs/ralph/README.md.

import { readFileSync } from "node:fs";
import { isEntryPoint } from "./is-entry-point.ts";
import { BATCHED } from "./ledger-status.ts";

export interface LedgerTaskLike {
  id?: unknown;
  deps?: unknown;
  status?: unknown;
  batched_into?: unknown;
  human_gate?: unknown;
  kind?: unknown;
}

export interface LedgerLike {
  tasks?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a Ralph ledger's task dependency graph. Detects:
 *   (a) duplicate task ids,
 *   (b) a `deps` entry referencing a non-existent task id,
 *   (c) a task depending on itself,
 *   (d) any dependency cycle (reported as a path, e.g. `T1 -> T2 -> T1`),
 *   (e) a malformed fold: a `status:"batched"` row whose `batched_into` is
 *       missing, itself, unknown, another batched row or a gate; a
 *       `batched_into` on a row that is not batched; a gate that is batched; a
 *       host that depends on a task folded into it; or a host that doesn't
 *       carry (directly or transitively) a dep of a task folded into it.
 *
 * A dep on a batched row is read as a dep on its host (ledger-status.ts), and a
 * batched row's own deps are the host's job, so the cycle pass runs on the
 * remapped graph.
 *
 * Pure and side-effect-free; errors are human-readable strings. Edges are
 * read as "task -> dep" (the task depends on dep), so a reported cycle path
 * `A -> B -> A` means A depends on B and B depends on A.
 */
export function validateLedgerDeps(ledger: LedgerLike): ValidationResult {
  const errors: string[] = [];

  const rawTasks = ledger?.tasks;
  if (!Array.isArray(rawTasks)) {
    return { ok: false, errors: ['ledger has no "tasks" array'] };
  }

  // Normalise to { index, id, deps[] }. FAIL LOUD on a malformed `deps` rather
  // than silently coercing it: the old code turned a non-array `deps` into `[]`
  // and filtered out non-string elements, which can make a task pickable BEFORE
  // its real prerequisite is done — the exact sequencing break this validator
  // exists to catch. A missing `deps` is legitimate ("no dependencies"); any
  // present-but-not-array-of-strings value is an error.
  const tasks = rawTasks.map((t, index) => {
    const obj = (t ?? {}) as LedgerTaskLike;
    const id = typeof obj.id === "string" ? obj.id : "";
    const label = id !== "" ? `task "${id}"` : `task at index ${index}`;

    const deps: string[] = [];
    if (obj.deps !== undefined) {
      if (!Array.isArray(obj.deps)) {
        errors.push(`${label} has a non-array "deps" (${describeType(obj.deps)})`);
      } else {
        obj.deps.forEach((d, di) => {
          if (typeof d === "string") {
            deps.push(d);
          } else {
            errors.push(
              `${label} has a non-string dep at index ${di} (${describeType(d)})`,
            );
          }
        });
      }
    }
    return { index, id, deps, raw: obj };
  });

  // (a) duplicate ids — and collect the set of declared ids.
  const idCounts = new Map<string, number>();
  for (const t of tasks) {
    if (t.id === "") {
      errors.push(`task at index ${t.index} has a missing or non-string "id"`);
      continue;
    }
    idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push(`duplicate task id "${id}" (appears ${count} times)`);
    }
  }

  const idSet = new Set(idCounts.keys());
  const byId = new Map<string, (typeof tasks)[number]>();
  for (const t of tasks) if (t.id !== "" && !byId.has(t.id)) byId.set(t.id, t);
  const gateLike = (o: LedgerTaskLike) => o.human_gate === true || o.kind === "decision";

  // (e) fold shape. `hostOf` maps each well-formed batched row to its host.
  const hostOf = new Map<string, string>();
  for (const t of tasks) {
    const label = t.id !== "" ? `task "${t.id}"` : `task at index ${t.index}`;
    const batched = t.raw.status === BATCHED;
    const into = t.raw.batched_into;
    if (!batched) {
      if (into !== undefined && into !== null) {
        errors.push(`${label} has "batched_into" but its status is not "batched" — set status:"batched" to fold it, or drop "batched_into".`);
      }
      continue;
    }
    if (gateLike(t.raw)) {
      errors.push(`${label} is a human gate / decision with status:"batched" — a gate is Matt's step and can't be folded into a PR.`);
      continue;
    }
    if (typeof into !== "string" || into.trim() === "") {
      errors.push(`${label} has status:"batched" but no "batched_into" — name the task whose PR ships its section.`);
    } else if (into === t.id) {
      errors.push(`${label} is batched into itself.`);
    } else if (!byId.has(into)) {
      errors.push(`${label} is batched into unknown task id "${into}".`);
    } else if (byId.get(into)!.raw.status === BATCHED) {
      errors.push(`${label} is batched into "${into}", which is itself batched — point it at the final host.`);
    } else if (gateLike(byId.get(into)!.raw)) {
      errors.push(`${label} is batched into "${into}", a human gate / decision — fold it into a code/docs/measure task.`);
    } else if (t.id !== "") {
      hostOf.set(t.id, into);
    }
  }

  // (b) unknown dep ids + (c) self-deps. Build the adjacency for the cycle pass
  // from valid, non-self edges only (a dangling/self edge can't form a cycle and
  // is already reported here, so excluding it avoids double-reporting). A dep
  // on a folded row becomes an edge to its host; a folded row adds no edges.
  const adjacency = new Map<string, string[]>();
  for (const id of idSet) adjacency.set(id, []);

  for (const t of tasks) {
    if (t.id === "") continue;
    for (const dep of t.deps) {
      if (dep === t.id) {
        errors.push(`task "${t.id}" depends on itself`);
        continue;
      }
      if (!idSet.has(dep)) {
        errors.push(`task "${t.id}" depends on unknown task id "${dep}"`);
        continue;
      }
      if (hostOf.has(t.id)) continue;
      const target = hostOf.get(dep) ?? dep;
      if (target === t.id) {
        errors.push(`task "${t.id}" depends on "${dep}", which is batched into "${t.id}" — drop the dep (its section is part of "${t.id}" now).`);
        continue;
      }
      const edges = adjacency.get(t.id);
      if (edges && !edges.includes(target)) edges.push(target);
    }
  }

  // (e) a host must wait on everything its folded tasks waited on.
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(adjacency.get(from) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(adjacency.get(n) ?? []));
    }
    return false;
  };
  for (const [folded, host] of hostOf) {
    for (const dep of byId.get(folded)!.deps) {
      if (!idSet.has(dep)) continue;
      const target = hostOf.get(dep) ?? dep;
      if (target === host || target === folded) continue;
      if (!reaches(host, target)) {
        errors.push(`task "${folded}" is batched into "${host}" but "${host}" doesn't depend on "${target}" (a dep of "${folded}") — add it to "${host}"'s deps so the batch still waits for it.`);
      }
    }
  }

  // (d) cycle detection via DFS with an explicit recursion stack so we can
  // report the offending path. 0 = unvisited, 1 = on stack, 2 = done.
  const state = new Map<string, 0 | 1 | 2>();
  for (const id of idSet) state.set(id, 0);
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const s = state.get(next);
      if (s === 1) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next]; // closed path e.g. [A,B,A]
        const key = canonicaliseCycle(cycle);
        if (!reported.has(key)) {
          reported.add(key);
          errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);
        }
      } else if (s === 0) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const id of idSet) {
    if (state.get(id) === 0) visit(id);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Canonicalise a closed cycle path (e.g. `[A, B, A]`) so the same cycle reached
 * from different DFS roots is only reported once: drop the closing duplicate,
 * rotate to start at the lexicographically smallest node, and join.
 */
function canonicaliseCycle(closedPath: string[]): string {
  const nodes = closedPath.slice(0, -1);
  if (nodes.length === 0) return closedPath.join(">");
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if ((nodes[i] ?? "") < (nodes[minIdx] ?? "")) minIdx = i;
  }
  return [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)].join(">");
}

/** Human-readable type label for an error message (distinguishes null/array from typeof). */
function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ---------------------------------------------------------------------------
// CLI wrapper: `node <ralph>/lib/validate-ledger-deps.ts <ledger.json>`
// Prints each error to stderr and exits 1 on failure; on success prints
// `ledger ok: <n> tasks, deps valid` and exits 0.
// ---------------------------------------------------------------------------
export function runCli(argv: string[]): number {
  const path = argv[2];
  if (!path) {
    console.error("usage: node <ralph>/lib/validate-ledger-deps.ts <ledger.json>");
    return 1;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`cannot read ledger file "${path}": ${(err as Error).message}`);
    return 1;
  }

  let ledger: unknown;
  try {
    ledger = JSON.parse(raw);
  } catch (err) {
    console.error(`ledger "${path}" is not valid JSON: ${(err as Error).message}`);
    return 1;
  }

  if (
    typeof ledger !== "object" ||
    ledger === null ||
    !Array.isArray((ledger as LedgerLike).tasks)
  ) {
    console.error(`ledger "${path}" has no "tasks" array`);
    return 1;
  }

  const result = validateLedgerDeps(ledger as LedgerLike);
  if (!result.ok) {
    for (const e of result.errors) console.error(`ledger dep error: ${e}`);
    console.error(
      `ledger invalid: ${result.errors.length} dependency error(s) in "${path}"`,
    );
    return 1;
  }

  const n = ((ledger as LedgerLike).tasks as unknown[]).length;
  console.log(`ledger ok: ${n} tasks, deps valid`);
  return 0;
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) {
  process.exit(runCli(process.argv));
}
