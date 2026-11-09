// The bridge to a repo's own gate checks (adapter `gateChecks`).
//
// A repo can add `done_when` check types the core does not know (checks that
// read its own database, say). The core runs `<gateChecks.command> validate|check` through
// the shell with ONE check object as JSON on stdin and reads the last JSON
// object it prints:
//   validate → {"errors": ["..."]}       ([] = the shape is fine)
//   check    → {"pass": bool, "reason": "..."}
// Anything else — a non-zero exit, no JSON, a missing field — FAILS CLOSED.
//
// Only `node:` imports.

import { spawnSync } from "node:child_process";

import type { Adapter } from "./adapter.ts";
import type { CheckResult } from "./gate-checks.ts";

/** Run a repo gate-check command with `input` on stdin. */
export type RunCheck = (command: string, mode: "check" | "validate", input: string) => { code: number; stdout: string; stderr: string };

/** `<command> <mode>` through the shell, the check JSON on stdin. */
export const realRunCheck: RunCheck = (command, mode, input) => {
  const r = spawnSync("sh", ["-c", `${command} ${mode}`], { input, encoding: "utf8", maxBuffer: 64 << 20, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
};

/** The last JSON value a command printed on stdout (tolerates log lines above it). */
export function lastJson(stdout: string): unknown {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      /* keep widening */
    }
  }
  return null;
}

/** Judge one repo-provided check through the adapter's command. Fails closed. */
export function runExtraCheck(adapter: Adapter, check: Record<string, unknown>, run: RunCheck = realRunCheck): CheckResult {
  const r = run(adapter.gateChecks.command, "check", JSON.stringify(check));
  const out = lastJson(r.stdout) as { pass?: unknown; reason?: unknown } | null;
  if (r.code !== 0 || !out || typeof out.pass !== "boolean") {
    const why = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" / ");
    return { pass: false, reason: `${String(check.type)}: the repo's gate check failed (exit ${r.code}${why ? `: ${why}` : ""})` };
  }
  return { pass: out.pass, reason: String(out.reason ?? "") };
}

/** Shape errors for one repo-provided check, from the repo's validator. A broken validator is an error, never a pass. */
export function validateExtraCheck(adapter: Adapter, check: Record<string, unknown>, run: RunCheck = realRunCheck): string[] {
  const r = run(adapter.gateChecks.command, "validate", JSON.stringify(check));
  const out = lastJson(r.stdout) as { errors?: unknown } | null;
  if (r.code !== 0 || !out || !Array.isArray(out.errors)) {
    return [`${String(check.type)}: the repo's gate-check validator failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`];
  }
  return out.errors.map(String);
}
