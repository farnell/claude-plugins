// "Was this file run directly?" — the ONE check every ralph helper CLI uses.
//
// The old one-liner compared import.meta.url with "file://" + argv[1]. It was false
// whenever the checkout path held a space or `%` (import.meta.url is
// percent-encoded, argv[1] is not) or a symlink (Node realpaths the main module,
// argv[1] keeps the link — macOS's /var → /private/var is one). The script then
// exited 0 having printed nothing: the silent failure preflight exists to remove.
// Guarded by __tests__/cli-entry.test.ts.
//
// Only `node:` imports: preflight.ts and worktrees.ts load this under Node's
// native type stripping, with no node_modules.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isEntryPoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
