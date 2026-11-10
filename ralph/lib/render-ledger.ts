// Render a Ralph ledger JSON into its human-glance `<slug>-LEDGER.md` sibling.
//
// The `.md` is a one-way projection: never edited by hand, never read back as
// truth. Stage agents tick the JSON and re-run this, so the two can't drift.
//
// CLI: `node <ralph>/lib/render-ledger.ts <ledger.json>` — writes the `.md`.

import { readFileSync, writeFileSync } from "node:fs";
import { isEntryPoint } from "./is-entry-point.ts";

interface RenderTask {
  id: string;
  title: string;
  status: string;
  deps?: string[];
  human_gate?: boolean;
  kind?: string;
  batched_into?: string;
}

interface RenderLedger {
  feature: { title?: string; slug: string; featureMd?: string };
  tasks: RenderTask[];
}

export function ledgerMdPath(jsonPath: string): string {
  return jsonPath.replace(/\.json$/, ".md");
}

export function renderLedgerMd(ledger: RenderLedger, jsonPath: string): string {
  const title = ledger.feature.title ?? ledger.feature.slug;
  const lines = [
    `# ${title} — ledger (rendered from the JSON; never edit by hand)`,
    "",
    `Doc: \`${ledger.feature.featureMd ?? "?"}\` · canonical: \`${jsonPath}\``,
    "",
  ];
  for (const t of ledger.tasks) {
    const box = t.status === "done" || t.status === "batched" ? "[x]" : "[ ]";
    const deps = t.deps && t.deps.length ? ` (after ${t.deps.join(", ")})` : "";
    // Only non-code kinds are worth a tag: code is the default shape.
    const kind = t.status !== "done" && t.status !== "batched" && !t.human_gate && t.kind && t.kind !== "code" ? ` · ${t.kind}` : "";
    const tail = t.status === "batched"
      ? ` — ↪ batched into ${t.batched_into ?? "?"}`
      : t.human_gate
      ? " — 🔒 human-gate"
      : t.status === "blocked"
        ? " — ⛔ blocked"
        : t.status === "awaiting_review"
          ? " — 👀 awaiting review"
          : "";
    lines.push(`- ${box} **${t.id}** ${t.title}${deps}${kind}${tail}`);
  }
  lines.push("");
  return lines.join("\n");
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node <ralph>/lib/render-ledger.ts <ledger.json>");
    process.exit(1);
  }
  const out = ledgerMdPath(path);
  writeFileSync(out, renderLedgerMd(JSON.parse(readFileSync(path, "utf8")) as RenderLedger, path));
  console.log(`wrote ${out}`);
}
