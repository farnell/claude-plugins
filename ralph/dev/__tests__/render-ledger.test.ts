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

describe("renderLedgerMd — batched rows", () => {
  it("renders a folded task as closed and names its host", () => {
    const md = renderLedgerMd(
      {
        feature: { slug: "f" },
        tasks: [
          { id: "A", title: "Host", status: "todo", kind: "code" },
          { id: "B", title: "Folded", status: "batched", batched_into: "A", kind: "measure" },
        ],
      },
      "x.json",
    );
    expect(md).toContain("- [x] **B** Folded — ↪ batched into A\n");
  });
});

describe("renderLedgerMd — lanes", () => {
  it("tags an open code task with its lane, and nothing else", () => {
    const md = renderLedgerMd(
      {
        feature: { slug: "f" },
        tasks: [
          { id: "A", title: "UI", status: "todo", kind: "code", lane: "light" },
          { id: "B", title: "Credits", status: "todo", kind: "code", lane: "full" },
          { id: "C", title: "Old", status: "done", kind: "code", lane: "light" },
          { id: "G", title: "Ship", status: "todo", human_gate: true, lane: "human" },
        ],
      },
      "x.json",
    );
    expect(md).toContain("- [ ] **A** UI · light\n");
    expect(md).toContain("- [ ] **B** Credits · full\n");
    expect(md).toContain("- [x] **C** Old\n");
    expect(md).toContain("- [ ] **G** Ship — 🔒 human-gate\n");
  });
});
