// The plugin's two version fields (plugin.json for the installer, the
// marketplace.json entry for the catalog) must stay equal; the pre-push hook
// blocks an un-bumped push of plugin content.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

describe("ralph manifest version sync", () => {
  it("plugin.json and marketplace.json declare the same semver version", () => {
    const plugin = read("../../.claude-plugin/plugin.json");
    const entry = read("../../../.claude-plugin/marketplace.json").plugins.find((p: { name: string }) => p.name === "ralph");
    expect(entry, "ralph must be listed in marketplace.json").toBeTruthy();
    expect(entry.source).toBe("./ralph");
    expect(plugin.version).toBe(entry.version);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
