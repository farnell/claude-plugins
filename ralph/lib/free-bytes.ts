// Free disk space for the Ralph preflight. The preflight may only import `node:`
// builtins and relative `.ts` siblings, so it runs with no node_modules.
//
// On macOS, statfs's free count leaves out "purgeable" space (Time Machine local
// snapshots, caches) that the system frees as soon as a write needs it, so it can
// report ~20 GB while Finder shows ~57 GB available. On darwin we ask the system
// for the "available for important usage" capacity instead (Finder's figure, which
// counts purgeable space), and fall back to statfs if that query fails.

import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";

/** Free bytes available to an unprivileged writer on the filesystem holding `path` (statfs bavail × bsize). */
export function statfsFreeBytes(path: string = "/"): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

/** JXA that prints NSURLVolumeAvailableCapacityForImportantUsageKey for the volume holding argv[0]. */
const JXA = `function run(argv) {
  ObjC.import("Foundation");
  var key = "NSURLVolumeAvailableCapacityForImportantUsageKey";
  var r = $.NSURL.fileURLWithPath(argv[0]).resourceValuesForKeysError($([key]), null);
  return String(ObjC.unwrap(r.objectForKey(key)));
}`;

/** Parse the JXA output: a positive integer byte count, else null. */
export function parseCapacity(out: string): number | null {
  const s = out.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

export interface FreeBytesDeps {
  platform: string;
  /** runs osascript with the given args and returns stdout; throws on failure */
  osascript: (args: string[]) => string;
  statfs: (path: string) => number;
}

const realDeps: FreeBytesDeps = {
  platform: process.platform,
  osascript: (args) => execFileSync("osascript", args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }),
  statfs: statfsFreeBytes,
};

/**
 * Bytes a writer can use on the filesystem holding `path`. On macOS this includes
 * purgeable space (what Finder calls "available"); elsewhere, or if the macOS
 * query fails, it is statfs's free count.
 */
export function freeBytesAt(path: string = "/", deps: FreeBytesDeps = realDeps): number {
  if (deps.platform === "darwin") {
    try {
      const n = parseCapacity(deps.osascript(["-l", "JavaScript", "-e", JXA, path]));
      if (n !== null) return n;
    } catch {
      // fall through to statfs
    }
  }
  return deps.statfs(path);
}
