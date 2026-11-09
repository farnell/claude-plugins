// Free disk space for the Ralph preflight. The preflight may only import `node:`
// builtins and relative `.ts` siblings, so it runs with no node_modules.

import { statfsSync } from "node:fs";

/** Free bytes available to an unprivileged writer on the filesystem holding `path` (statfs bavail × bsize). */
export function freeBytesAt(path: string = "/"): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}
