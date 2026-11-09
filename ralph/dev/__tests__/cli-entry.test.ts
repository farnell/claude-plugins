import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The ralph helper CLIs decide "am I the entry point?" by comparing
// import.meta.url with argv[1]. A hand-built `file://${argv[1]}` is not
// percent-encoded, so from a checkout path with a space the check is false and
// the script exits 0 having printed NOTHING — the silent failure the preflight
// exists to remove. These run the real files under plain `node` from such a path.

const RALPH = fileURLToPath(new URL("../../lib", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "ralph cli entry "));
// lib/ is self-contained: node: builtins and .ts siblings only.
cpSync(RALPH, join(root, "lib"), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ralph CLIs run from a path with a space", () => {
  it.each(["worktrees.ts", "known-flakes.ts", "blocked-comment.ts", "merge.ts", "render-ledger.ts", "validate-ledger-deps.ts"])("%s prints its usage and exits 1 with no args", (file) => {
    const r = spawnSync(process.execPath, [join(root, "lib", file)], { encoding: "utf8", cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/usage/);
  });

  it("every ralph module decides 'am I the entry point?' through isEntryPoint, never by hand", () => {
    for (const f of readdirSync(RALPH).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(RALPH, f), "utf8");
      expect(src, f).not.toMatch(/import\.meta\.url\s*===/);
      if (/const isMain\b/.test(src)) expect(src, f).toMatch(/const isMain = isEntryPoint\(import\.meta\.url\);/);
    }
  });
});
