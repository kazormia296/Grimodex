import { describe, expect, it } from "vitest";
import {
  assertEvidenceSpanCatalogCoverage,
  buildEvidenceSpanCatalog,
  type EvidenceSpanCatalog,
  type EvidenceSpanCatalogWindowInput,
} from "@/features/narrative-extraction/evidence/spanCatalog";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import type {
  NarrativeCorpusSnapshot,
  NarrativeSnapshotBuildInput,
} from "@/features/narrative-extraction/source/types";
import {
  DEFAULT_CONTEXT_RADIUS_CHARS,
  DEFAULT_MAX_WINDOW_OWNED_CHARS,
  assertOwnedRangesPartition,
  planExtractionWindows,
  type WindowPlan,
} from "./windowPlanner";

function prose(...paragraphs: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
    })),
  });
}

async function makeSnapshot(
  documents: readonly (readonly string[])[],
): Promise<NarrativeCorpusSnapshot> {
  const input: NarrativeSnapshotBuildInput = {
    snapshotId: "snapshot-window-evidence",
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "project-ewc" },
    documents: documents.map((paragraphs, index) => ({
      sourceKey: `project:scene:ewc-${index}`,
      parentSourceKey: null,
      title: `場面${index}`,
      orderIndex: index,
      proseMirrorJson: prose(...paragraphs),
      origin: {
        kind: "project-node" as const,
        projectId: "project-ewc",
        nodeId: `scene-ewc-${index}`,
        sourceVersion: 1,
        sourceUpdatedAt: "2026-11-05T00:00:00.000Z",
        sourceUri: null,
      },
    })),
    omissions: [],
    createdAt: "2026-11-05T00:00:00.000Z",
  };
  const result = await buildNarrativeCorpusSnapshot(input);
  if (!result.ok) throw new Error("fixture snapshot failed");
  return result.snapshot;
}

async function windowInputs(
  snapshot: NarrativeCorpusSnapshot,
  plan: WindowPlan,
): Promise<EvidenceSpanCatalogWindowInput[]> {
  const inputs: EvidenceSpanCatalogWindowInput[] = [];
  for (const window of plan.windows) {
    const document = snapshot.documents.find(
      (candidate) => candidate.ref === window.documentRef,
    );
    if (!document) throw new Error("fixture document missing");
    const ranges = [...window.ownedRanges, ...window.contextRanges];
    const sourceView = await buildNarrativeSourceView({
      ref: window.sourceRef,
      document,
      documentRange: {
        start: Math.min(...ranges.map((range) => range.start)),
        end: Math.max(...ranges.map((range) => range.end)),
      },
    });
    inputs.push({
      windowId: window.windowId,
      documentRef: window.documentRef,
      sourceView,
      ownedRanges: window.ownedRanges,
      contextRanges: window.contextRanges,
    });
  }
  return inputs;
}

async function plansFor(
  snapshot: NarrativeCorpusSnapshot,
  catalog: EvidenceSpanCatalog,
  options: { maxOwnedChars?: number; contextRadiusChars?: number } = {},
): Promise<{
  legacy: WindowPlan;
  widened: WindowPlan;
  legacyInputs: EvidenceSpanCatalogWindowInput[];
  widenedInputs: EvidenceSpanCatalogWindowInput[];
}> {
  const legacy = planExtractionWindows(snapshot, options);
  const widened = planExtractionWindows(snapshot, {
    ...options,
    evidenceCatalog: catalog,
  });
  return {
    legacy,
    widened,
    legacyInputs: await windowInputs(snapshot, legacy),
    widenedInputs: await windowInputs(snapshot, widened),
  };
}

/** English-style prose: '.' is not a catalog sentence terminal, no newline. */
function englishParagraph(length: number): string {
  const sentence = "The courier crossed the quiet bridge before dawn. ";
  return sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length);
}

/** Japanese prose whose only long unit is a quoted run with inner terminals. */
function japaneseWithLongQuote(): string {
  const plain = "朝の光が静かに廊下へ差し込んだ。";
  const lead = plain.repeat(Math.ceil(5400 / plain.length)).slice(0, 5400);
  const quote = `「${"風は北から吹いていた。".repeat(100)}」`;
  const tail = plain.repeat(80);
  return `${lead}${quote}${tail}`;
}

describe("planExtractionWindows with an evidence catalog", () => {
  it("reproduces the hole for a 13k-char English paragraph without the catalog", async () => {
    const snapshot = await makeSnapshot([[englishParagraph(13_000)]]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const { legacyInputs } = await plansFor(snapshot, catalog);
    // The unchanged assertion still rejects the old plan: it is not loosened,
    // and no window is expanded after the fact.
    expect(() =>
      assertEvidenceSpanCatalogCoverage(catalog, legacyInputs),
    ).toThrow(/coverage|hole|E000002/i);
  });

  it("covers every entry of a 13k-char English paragraph with no newline", async () => {
    const snapshot = await makeSnapshot([[englishParagraph(13_000)]]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const { legacy, widened, widenedInputs } = await plansFor(
      snapshot,
      catalog,
    );
    expect(() =>
      assertEvidenceSpanCatalogCoverage(catalog, widenedInputs),
    ).not.toThrow();
    expect(assertOwnedRangesPartition(snapshot, widened)).toBe(true);
    expect(widened.windows.map((w) => [w.windowId, w.sourceRef])).toEqual(
      legacy.windows.map((w) => [w.windowId, w.sourceRef]),
    );
    expect(widened.windows.map((w) => w.ownedRanges)).toEqual(
      legacy.windows.map((w) => w.ownedRanges),
    );
  });

  it("covers every entry of a Japanese paragraph whose bracketed quote spans the cut", async () => {
    const snapshot = await makeSnapshot([[japaneseWithLongQuote()]]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const { legacy, widened, legacyInputs, widenedInputs } = await plansFor(
      snapshot,
      catalog,
    );
    expect(legacy.windows.length).toBeGreaterThan(1);
    expect(() =>
      assertEvidenceSpanCatalogCoverage(catalog, legacyInputs),
    ).toThrow(/coverage|hole|E000002/i);
    expect(() =>
      assertEvidenceSpanCatalogCoverage(catalog, widenedInputs),
    ).not.toThrow();
    expect(assertOwnedRangesPartition(snapshot, widened)).toBe(true);
    expect(widened.windows.map((w) => w.ownedRanges)).toEqual(
      legacy.windows.map((w) => w.ownedRanges),
    );
  });

  it("only widens context, and only for the window that needs it", async () => {
    const snapshot = await makeSnapshot([[englishParagraph(13_000)]]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const { legacy, widened } = await plansFor(snapshot, catalog);
    const maxExtension = 4_096;
    let widenedWindows = 0;
    widened.windows.forEach((window, index) => {
      const before = legacy.windows[index];
      const cover = (w: typeof window) => {
        const all = [...w.ownedRanges, ...w.contextRanges];
        return {
          start: Math.min(...all.map((r) => r.start)),
          end: Math.max(...all.map((r) => r.end)),
        };
      };
      const a = cover(before);
      const b = cover(window);
      expect(b.start).toBeLessThanOrEqual(a.start);
      expect(b.end).toBeGreaterThanOrEqual(a.end);
      const growth = a.start - b.start + (b.end - a.end);
      expect(growth).toBeLessThanOrEqual(maxExtension);
      if (growth > 0) widenedWindows += 1;
      // Context never overlaps the window's own owned range.
      for (const context of window.contextRanges) {
        for (const owned of window.ownedRanges) {
          expect(context.end <= owned.start || context.start >= owned.end).toBe(
            true,
          );
        }
      }
    });
    expect(widenedWindows).toBeGreaterThan(0);
    expect(widenedWindows).toBeLessThan(widened.windows.length);
  });

  it("keeps the plan byte-identical when every entry already fits a window", async () => {
    const sentence = "雨が降った。門が開いた。";
    const snapshot = await makeSnapshot([
      ["短い場面。"],
      [sentence.repeat(600)],
      [sentence.repeat(250), sentence.repeat(250), sentence.repeat(250)],
      [englishParagraph(900)],
    ]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const { legacy, widened, widenedInputs } = await plansFor(
      snapshot,
      catalog,
    );
    expect(legacy.windows.length).toBeGreaterThan(4);
    expect(widened).toEqual(legacy);
    expect(JSON.stringify(widened)).toBe(JSON.stringify(legacy));
    expect(() =>
      assertEvidenceSpanCatalogCoverage(catalog, widenedInputs),
    ).not.toThrow();
  });

  it("is identical to the legacy plan when no catalog is supplied", async () => {
    const snapshot = await makeSnapshot([[englishParagraph(13_000)]]);
    const without = planExtractionWindows(snapshot);
    const withUndefined = planExtractionWindows(snapshot, {
      evidenceCatalog: undefined,
    });
    expect(withUndefined).toEqual(without);
    expect(without.windows[0]?.contextRanges).toEqual([
      {
        start: DEFAULT_MAX_WINDOW_OWNED_CHARS,
        end: DEFAULT_MAX_WINDOW_OWNED_CHARS + DEFAULT_CONTEXT_RADIUS_CHARS,
      },
    ]);
  });

  it("handles an entry that spans several windows with a small budget", async () => {
    const quote = `「${"風は北から吹いていた。".repeat(12)}」`;
    const snapshot = await makeSnapshot([
      [`${"朝になった。".repeat(10)}${quote}${"夜になった。".repeat(10)}`],
    ]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const options = { maxOwnedChars: 40, contextRadiusChars: 5 };
    const { legacy, widened, legacyInputs, widenedInputs } = await plansFor(
      snapshot,
      catalog,
      options,
    );
    expect(() =>
      assertEvidenceSpanCatalogCoverage(catalog, legacyInputs),
    ).toThrow(/coverage|hole|E000002/i);
    expect(() =>
      assertEvidenceSpanCatalogCoverage(catalog, widenedInputs),
    ).not.toThrow();
    expect(assertOwnedRangesPartition(snapshot, widened)).toBe(true);
    expect(widened.windows.map((w) => w.ownedRanges)).toEqual(
      legacy.windows.map((w) => w.ownedRanges),
    );
  });

  it("adds no source-view failure to windows the legacy plan could already build (known constraint: context radius is not snapped to a UTF-16 boundary)", async () => {
    // Pre-existing and out of EWC scope: the default 240-char context edge can
    // land inside a surrogate pair, which buildNarrativeSourceView rejects.
    // The widening only moves context edges to catalog entry boundaries, so
    // it must never fail a window the legacy plan could build.
    const text = `${"あ".repeat(6239)}𠮷${"い。".repeat(300)}`;
    const snapshot = await makeSnapshot([[text]]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const failing = async (plan: WindowPlan): Promise<Set<string>> => {
      const failed = new Set<string>();
      for (const window of plan.windows) {
        try {
          await windowInputs(snapshot, {
            windows: [window],
          } as unknown as WindowPlan);
        } catch {
          failed.add(window.windowId);
        }
      }
      return failed;
    };
    const legacyFailed = await failing(planExtractionWindows(snapshot));
    const widenedFailed = await failing(
      planExtractionWindows(snapshot, { evidenceCatalog: catalog }),
    );
    for (const windowId of widenedFailed) {
      expect(legacyFailed.has(windowId)).toBe(true);
    }
  });

  it("is deterministic", async () => {
    const snapshot = await makeSnapshot([[englishParagraph(20_000)]]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const first = planExtractionWindows(snapshot, { evidenceCatalog: catalog });
    const second = planExtractionWindows(snapshot, {
      evidenceCatalog: catalog,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
