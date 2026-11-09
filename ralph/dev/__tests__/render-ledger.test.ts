import { describe, it, expect } from "vitest";
import { renderLedgerMd, ledgerMdPath } from "../../lib/render-ledger.ts";

const ledger = {
  feature: {
    slug: "feat",
    title: "Feat follow-ups",
    featureMd: "docs/feat.md",
  },
  tasks: [
    { id: "A", title: "First", status: "done", deps: [], human_gate: false, kind: "code" },
    { id: "B", title: "Second", status: "todo", deps: ["A"], human_gate: false, kind: "measure" },
    { id: "G", title: "Ship it", status: "todo", deps: ["A", "B"], human_gate: true },
    { id: "C", title: "Old one", status: "blocked", deps: [], human_gate: false, kind: "code" },
  ],
};

describe("renderLedgerMd", () => {
  it("renders the checklist the repo's ledgers already use", () => {
    expect(renderLedgerMd(ledger, "docs/ralph/feat-LEDGER.json")).toBe(
      [
        "# Feat follow-ups — ledger (rendered from the JSON; never edit by hand)",
        "",
        "Doc: `docs/feat.md` · canonical: `docs/ralph/feat-LEDGER.json`",
        "",
        "- [x] **A** First",
        "- [ ] **B** Second (after A) · measure",
        "- [ ] **G** Ship it (after A, B) — 🔒 human-gate",
        "- [ ] **C** Old one — ⛔ blocked",
        "",
      ].join("\n"),
    );
  });

  it("is deterministic (same JSON → byte-identical output)", () => {
    expect(renderLedgerMd(ledger, "x.json")).toBe(renderLedgerMd(ledger, "x.json"));
  });
});

describe("ledgerMdPath", () => {
  it("swaps .json for .md", () => {
    expect(ledgerMdPath("docs/ralph/feat-LEDGER.json")).toBe("docs/ralph/feat-LEDGER.md");
  });
});
