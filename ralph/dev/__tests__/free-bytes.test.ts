import { describe, expect, it } from "vitest";
import { freeBytesAt, parseCapacity, type FreeBytesDeps } from "../../lib/free-bytes.ts";

const GB = 1024 ** 3;

function deps(over: Partial<FreeBytesDeps>): FreeBytesDeps {
  return { platform: "linux", osascript: () => { throw new Error("not called"); }, statfs: () => 20 * GB, ...over };
}

describe("parseCapacity", () => {
  it("reads a positive integer byte count", () => {
    expect(parseCapacity("57504605720\n")).toBe(57504605720);
  });
  it("rejects empty, zero, non-numeric and 'undefined' output", () => {
    for (const s of ["", "0", "abc", "undefined", "12.5", "-3"]) expect(parseCapacity(s)).toBeNull();
  });
});

describe("freeBytesAt", () => {
  it("off macOS uses statfs and never runs osascript", () => {
    expect(freeBytesAt("/x", deps({ statfs: () => 7 * GB }))).toBe(7 * GB);
  });

  it("on macOS counts purgeable space (the important-usage capacity), not statfs", () => {
    let args: string[] = [];
    const n = freeBytesAt("/repo", deps({
      platform: "darwin",
      osascript: (a) => { args = a; return "57504605720\n"; },
      statfs: () => 20 * GB,
    }));
    expect(n).toBe(57504605720);
    expect(args.slice(0, 2)).toEqual(["-l", "JavaScript"]);
    expect(args[args.length - 1]).toBe("/repo");
    expect(args.join(" ")).toContain("NSURLVolumeAvailableCapacityForImportantUsageKey");
  });

  it("on macOS falls back to statfs when osascript fails or prints junk", () => {
    expect(freeBytesAt("/r", deps({ platform: "darwin", osascript: () => { throw new Error("boom"); }, statfs: () => 3 * GB }))).toBe(3 * GB);
    expect(freeBytesAt("/r", deps({ platform: "darwin", osascript: () => "undefined", statfs: () => 4 * GB }))).toBe(4 * GB);
  });

  it.runIf(process.platform === "darwin")("real macOS query returns at least statfs's free count", () => {
    expect(freeBytesAt(process.cwd())).toBeGreaterThan(0);
  });
});
