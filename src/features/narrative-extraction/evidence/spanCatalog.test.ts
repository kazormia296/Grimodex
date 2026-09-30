import { describe, expect, it } from "vitest";
import { buildNarrativeCorpusSnapshot } from "../source/buildSnapshot";
import { buildNarrativeSourceView } from "../source/sourceView";
import type {
  NarrativeCorpusSnapshot,
  NarrativeSnapshotBuildInput,
} from "../source/types";
import {
  EVIDENCE_SPAN_CATALOG_KIND,
  EVIDENCE_SPAN_CATALOG_VERSION,
  EVIDENCE_SPAN_SEGMENTATION_VERSION,
  assertEvidenceSpanCatalogCoverage,
  bindEvidenceSpanCatalog,
  bindCapturedEvidenceSpanCatalog,
  buildEvidenceSpanCatalog,
  captureEvidenceSpanCatalog,
  createEvidenceSpanCatalogSelectionResolver,
  getEvidenceSpanCatalogBuildExpectedEntriesCountForTests,
  resolveSelectedEvidenceRefs,
  resetEvidenceSpanCatalogInstrumentationForTests,
  validateEvidenceSpanCatalogBinding,
  validateEvidenceSpanCatalog,
  type EvidenceSpanCatalog,
  type EvidenceSpanCatalogEntry,
  type EvidenceSpanCatalogWindowInput,
} from "./spanCatalog";

function prose(...paragraphs: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
    })),
  });
}

function blockquoteProse(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text }],
          },
        ],
      },
    ],
  });
}

function snapshotInput(
  documents: NarrativeSnapshotBuildInput["documents"],
): NarrativeSnapshotBuildInput {
  return {
    snapshotId: "snapshot-citation-catalog",
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "project-citation" },
    documents,
    omissions: [],
    createdAt: "2026-09-05T00:00:00.000Z",
  };
}

async function makeSnapshot(
  paragraphs: readonly string[],
): Promise<NarrativeCorpusSnapshot> {
  const result = await buildNarrativeCorpusSnapshot(
    snapshotInput([
      {
        sourceKey: "project:scene:one",
        parentSourceKey: null,
        title: "第一場",
        orderIndex: 0,
        proseMirrorJson: prose(...paragraphs),
        origin: {
          kind: "project-node",
          projectId: "project-citation",
          nodeId: "scene-one",
          sourceVersion: 1,
          sourceUpdatedAt: "2026-09-04T00:00:00.000Z",
          sourceUri: null,
        },
      },
    ]),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("fixture snapshot failed");
  return result.snapshot;
}

function fullWindowInput(
  snapshot: NarrativeCorpusSnapshot,
  windowId = "window-001",
  ownedRanges?: EvidenceSpanCatalogWindowInput["ownedRanges"],
): Promise<EvidenceSpanCatalogWindowInput> {
  const document = snapshot.documents[0];
  if (!document) throw new Error("fixture document missing");
  return buildNarrativeSourceView({
    ref: `window:${windowId}`,
    document,
    documentRange: { start: 0, end: document.canonical.text.length },
  }).then((sourceView) => ({
    windowId,
    documentRef: document.ref,
    sourceView,
    ownedRanges: ownedRanges ?? [
      { start: 0, end: document.canonical.text.length },
    ],
    contextRanges: [],
  }));
}

function windowForEntryInput(
  snapshot: NarrativeCorpusSnapshot,
  entry: EvidenceSpanCatalogEntry,
  windowId: string,
): Promise<EvidenceSpanCatalogWindowInput> {
  const document = snapshot.documents.find(
    (candidate) => candidate.ref === entry.documentRef,
  );
  if (!document) throw new Error("fixture document missing");
  return buildNarrativeSourceView({
    ref: `window:${windowId}`,
    document,
    documentRange: entry.canonicalRange,
  }).then((sourceView) => ({
    windowId,
    documentRef: document.ref,
    sourceView,
    ownedRanges: [entry.canonicalRange],
    contextRanges: [],
  }));
}

describe("evidence span catalog", () => {
  it("assigns distinct occurrence identities and exact source views to repeated text", async () => {
    const snapshot = await makeSnapshot(["同じ文。別の文。", "同じ文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);

    expect(catalog.kind).toBe(EVIDENCE_SPAN_CATALOG_KIND);
    expect(catalog.version).toBe(EVIDENCE_SPAN_CATALOG_VERSION);
    expect(catalog.segmentationVersion).toBe(
      EVIDENCE_SPAN_SEGMENTATION_VERSION,
    );
    expect(catalog.entries.map((entry) => entry.sourceRef)).toEqual([
      "E000001",
      "E000002",
      "E000003",
    ]);
    expect(catalog.entries[0]?.quote).toBe("同じ文。");
    expect(catalog.entries[2]?.quote).toBe("同じ文。");
    expect(catalog.entries[0]?.canonicalId).not.toBe(
      catalog.entries[2]?.canonicalId,
    );
    for (const entry of catalog.entries) {
      expect(entry.sourceView.ref).toBe(entry.sourceRef);
      expect(entry.sourceView.text).toBe(entry.quote);
      expect(entry.sourceView.documentRange).toEqual(entry.canonicalRange);
      expect(
        snapshot.documents
          .find((document) => document.ref === entry.documentRef)
          ?.canonical.text.slice(
            entry.canonicalRange.start,
            entry.canonicalRange.end,
          ),
      ).toBe(entry.quote);
    }
  });

  it("keeps structural ancestry, brackets, graphemes, and the 4096-unit cap", async () => {
    const longSentence = `「${"👨‍👩‍👧‍👦".repeat(900)}。」`;
    const snapshot = await makeSnapshot([
      "前の文。",
      `${longSentence}後の文。`,
    ]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);

    expect(catalog.entries.length).toBeGreaterThan(2);
    expect(catalog.entries.every((entry) => entry.quote.length <= 4096)).toBe(
      true,
    );
    const document = snapshot.documents[0];
    if (!document) throw new Error("fixture document missing");
    let previousEnd = 0;
    for (const entry of catalog.entries) {
      expect(entry.canonicalRange.start).toBeGreaterThanOrEqual(previousEnd);
      expect(
        document.canonical.text.slice(
          entry.canonicalRange.start,
          entry.canonicalRange.end,
        ),
      ).toBe(entry.quote);
      previousEnd = entry.canonicalRange.end;
    }
    const graphemeBoundaries = new Set<number>([
      0,
      document.canonical.text.length,
    ]);
    for (const segment of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(document.canonical.text)) {
      graphemeBoundaries.add(segment.index);
      graphemeBoundaries.add(segment.index + segment.segment.length);
    }
    expect(
      catalog.entries.every(
        (entry) =>
          graphemeBoundaries.has(entry.canonicalRange.start) &&
          graphemeBoundaries.has(entry.canonicalRange.end),
      ),
    ).toBe(true);
    expect(
      catalog.entries.every((entry) => {
        const first = entry.quote.charCodeAt(0);
        const last = entry.quote.charCodeAt(entry.quote.length - 1);
        return (
          !(first >= 0xdc00 && first <= 0xdfff) &&
          !(last >= 0xd800 && last <= 0xdbff)
        );
      }),
    ).toBe(true);
  });

  it("records the enclosing structural block IDs without duplicating nested block text", async () => {
    const result = await buildNarrativeCorpusSnapshot(
      snapshotInput([
        {
          sourceKey: "project:scene:nested",
          parentSourceKey: null,
          title: "入れ子",
          orderIndex: 0,
          proseMirrorJson: blockquoteProse("引用の文。"),
          origin: {
            kind: "project-node",
            projectId: "project-citation",
            nodeId: "scene-nested",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-09-04T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("nested fixture snapshot failed");
    const catalog = await buildEvidenceSpanCatalog(result.snapshot);
    expect(catalog.entries.map((entry) => entry.quote)).toEqual(["引用の文。"]);
    expect(catalog.entries[0]?.parentBlockIds).toEqual(["B000001"]);
  });

  it("validates against the sealed snapshot and rejects forged entries even with a copied digest", async () => {
    const snapshot = await makeSnapshot(["一文。", "二文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const valid = await validateEvidenceSpanCatalog(snapshot, catalog);
    expect(valid.ok).toBe(true);

    const forged = JSON.parse(JSON.stringify(catalog)) as EvidenceSpanCatalog;
    const first = forged.entries[0];
    if (!first) throw new Error("fixture catalog entry missing");
    (first as { quote: string }).quote = "二文。";
    (first as { text: string }).text = "二文。";
    const invalid = await validateEvidenceSpanCatalog(snapshot, forged);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("forged catalog unexpectedly validated");
    expect(invalid.reason).toMatch(/entry|source|digest|range/i);

    const wrongVersion = JSON.parse(
      JSON.stringify(catalog),
    ) as EvidenceSpanCatalog;
    (wrongVersion as { segmentationVersion: string }).segmentationVersion =
      "sentence-like-v2";
    const versionResult = await validateEvidenceSpanCatalog(
      snapshot,
      wrongVersion,
    );
    expect(versionResult.ok).toBe(false);
  });

  it("preserves compatibility errors for uncopyable snapshot and catalog inputs", async () => {
    const snapshot = await makeSnapshot(["一文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const window = await fullWindowInput(snapshot);
    const input = {
      requestIdentity: "request-uncopyable-input",
      windows: [window],
    };
    const uncopyableSnapshot = {
      ...snapshot,
      documents: null,
    } as unknown as NarrativeCorpusSnapshot;
    const uncopyableCatalog = {
      ...catalog,
      entries: null,
    } as unknown as EvidenceSpanCatalog;

    await expect(
      bindEvidenceSpanCatalog(uncopyableSnapshot, catalog, input),
    ).rejects.toMatchObject({ code: "EVIDENCE_SPAN_BINDING_INVALID_INPUT" });
    await expect(
      captureEvidenceSpanCatalog(uncopyableSnapshot, catalog),
    ).rejects.toMatchObject({
      code: "EVIDENCE_SPAN_CATALOG_CAPTURE_INVALID",
    });
    await expect(
      bindEvidenceSpanCatalog(snapshot, uncopyableCatalog, input),
    ).rejects.toMatchObject({ code: "EVIDENCE_SPAN_BINDING_INVALID_INPUT" });
    await expect(
      captureEvidenceSpanCatalog(snapshot, uncopyableCatalog),
    ).rejects.toMatchObject({
      code: "EVIDENCE_SPAN_CATALOG_CAPTURE_INVALID",
    });
  });

  it("preserves the compatibility error for a validation-invalid catalog", async () => {
    const snapshot = await makeSnapshot(["一文。二文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const first = catalog.entries[0];
    if (!first) throw new Error("fixture catalog entry missing");
    const forgedCatalog = {
      ...catalog,
      entries: catalog.entries.map((entry) =>
        entry === first ? { ...entry, quote: "改竄", text: "改竄" } : entry,
      ),
    };
    const window = await fullWindowInput(snapshot);

    await expect(
      bindEvidenceSpanCatalog(snapshot, forgedCatalog, {
        requestIdentity: "request-invalid-catalog",
        windows: [window],
      }),
    ).rejects.toMatchObject({
      code: "EVIDENCE_SPAN_BINDING_INVALID_CATALOG",
    });
    await expect(
      captureEvidenceSpanCatalog(snapshot, forgedCatalog),
    ).rejects.toMatchObject({
      code: "EVIDENCE_SPAN_CATALOG_CAPTURE_INVALID",
    });
  });

  it("assigns aliases in canonical catalog order and stabilizes window IDs when windows are reversed", async () => {
    const snapshot = await makeSnapshot(["一文。", "二文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const first = catalog.entries[0];
    const second = catalog.entries[1];
    if (!first || !second) throw new Error("fixture catalog entries missing");
    const firstWindow = await windowForEntryInput(
      snapshot,
      first,
      "window-first",
    );
    const secondWindow = await windowForEntryInput(
      snapshot,
      second,
      "window-second",
    );

    const ordered = await bindEvidenceSpanCatalog(snapshot, catalog, {
      requestIdentity: "request-reversed-windows",
      windows: [firstWindow, secondWindow],
    });
    const reversed = await bindEvidenceSpanCatalog(snapshot, catalog, {
      requestIdentity: "request-reversed-windows",
      windows: [secondWindow, firstWindow],
    });

    expect(reversed.bindingToken).toBe(ordered.bindingToken);
    expect(reversed.aliases).toEqual(ordered.aliases);
    expect(ordered.aliases.map((alias) => alias.canonicalSourceRef)).toEqual([
      first.sourceRef,
      second.sourceRef,
    ]);
    expect(ordered.aliases[0]?.alias).toBe(`E${ordered.bindingToken}-001`);
    expect(ordered.aliases[1]?.alias).toBe(`E${ordered.bindingToken}-002`);
    expect(ordered.aliases[0]?.windowIds).toEqual(["window-first"]);
    expect(ordered.aliases[1]?.windowIds).toEqual(["window-second"]);
  });

  it("fails closed when one combining-mark grapheme exceeds the UTF-16 quote limit", async () => {
    const giantCombiningGrapheme = `a${"\u0301".repeat(4_096)}。`;
    const snapshot = await makeSnapshot([giantCombiningGrapheme]);

    await expect(buildEvidenceSpanCatalog(snapshot)).rejects.toMatchObject({
      code: "EVIDENCE_SPAN_GRAPHEME_TOO_LARGE",
    });
  });

  it("fails closed when one ZWJ grapheme exceeds the UTF-16 quote limit", async () => {
    const giantZwjGrapheme = `${"👩‍".repeat(1_400)}👩。`;
    const snapshot = await makeSnapshot([giantZwjGrapheme]);

    await expect(buildEvidenceSpanCatalog(snapshot)).rejects.toMatchObject({
      code: "EVIDENCE_SPAN_GRAPHEME_TOO_LARGE",
    });
  });

  it("validates block ranges using from/to, accepting empty blocks and rejecting surrogate splits", async () => {
    const emptySnapshot = await makeSnapshot([""]);
    const emptyDocument = emptySnapshot.documents[0];
    if (!emptyDocument) throw new Error("empty fixture document missing");
    expect(emptyDocument.canonical.blocks).toEqual([
      expect.objectContaining({ range: { from: 0, to: 0 } }),
    ]);
    await expect(
      buildEvidenceSpanCatalog(emptySnapshot),
    ).resolves.toBeDefined();

    const emojiSnapshot = await makeSnapshot(["😀"]);
    const emojiDocument = emojiSnapshot.documents[0];
    if (!emojiDocument) throw new Error("emoji fixture document missing");
    const forged = JSON.parse(
      JSON.stringify(emojiSnapshot),
    ) as NarrativeCorpusSnapshot;
    const block = forged.documents[0]?.canonical.blocks[0];
    if (!block) throw new Error("emoji fixture block missing");
    (block as { range: { from: number; to: number } }).range = {
      from: 1,
      to: 2,
    };
    const validation = await validateEvidenceSpanCatalog(
      forged,
      await buildEvidenceSpanCatalog(emojiSnapshot),
    );
    expect(validation.ok).toBe(false);
    if (validation.ok)
      throw new Error("surrogate-split block unexpectedly validated");
    expect(validation.reason).toBe("invalid-snapshot");
    expect(validation.diagnostics).toContain(`invalid block range ${block.id}`);
  });

  it("binds only fully visible occurrences and preserves exact window text with unlabeled partial context", async () => {
    const snapshot = await makeSnapshot(["前の文。対象の文。後の文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const document = snapshot.documents[0];
    if (!document) throw new Error("fixture document missing");
    const target = catalog.entries.find(
      (entry) => entry.quote === "対象の文。",
    );
    if (!target) throw new Error("target catalog entry missing");
    const sourceView = await buildNarrativeSourceView({
      ref: "window:partial",
      document,
      documentRange: {
        start: Math.max(0, target.canonicalRange.start - 1),
        end: Math.min(
          document.canonical.text.length,
          target.canonicalRange.end + 1,
        ),
      },
    });
    const window: EvidenceSpanCatalogWindowInput = {
      windowId: "window-partial",
      documentRef: document.ref,
      sourceView,
      ownedRanges: [target.canonicalRange],
      contextRanges: [
        {
          start: Math.max(0, target.canonicalRange.start - 1),
          end: target.canonicalRange.start,
        },
        {
          start: target.canonicalRange.end,
          end: Math.min(
            document.canonical.text.length,
            target.canonicalRange.end + 1,
          ),
        },
      ],
    };
    const binding = await bindEvidenceSpanCatalog(snapshot, catalog, {
      requestIdentity: "request-001",
      windows: [window],
    });
    const boundWindow = binding.windows[0];
    if (!boundWindow) throw new Error("bound window missing");
    expect(boundWindow.segments.map((segment) => segment.text).join("")).toBe(
      sourceView.text,
    );
    const labeled = boundWindow.segments.filter(
      (segment) => segment.evidenceRef !== undefined,
    );
    expect(labeled).toHaveLength(1);
    expect(labeled[0]?.text).toBe(target.quote);
    expect(
      boundWindow.segments.some(
        (segment) =>
          segment.kind === "context" && segment.partialContext === true,
      ),
    ).toBe(true);
    expect(binding.aliases[0]?.alias).toMatch(/^E[a-f0-9]+-001$/);
    expect(binding.aliases[0]?.canonicalSourceRef).toBe(target.sourceRef);
  });

  it("keeps aliases request-bound and resolves only catalog-owned evidence", async () => {
    const snapshot = await makeSnapshot(["一文。二文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const window = await fullWindowInput(snapshot);
    const binding = await bindEvidenceSpanCatalog(snapshot, catalog, {
      requestIdentity: "request-identity-a",
      windows: [window],
    });
    const alias = binding.aliases[0]?.alias;
    if (!alias) throw new Error("fixture alias missing");

    const resolved = await resolveSelectedEvidenceRefs([alias], binding);
    expect(resolved.rawEvidenceReferences).toHaveLength(1);
    expect(resolved.rawEvidenceReferences[0]?.sourceRef).toBe("E000001");
    expect(resolved.rawEvidenceReferences[0]?.quote).toBe("一文。");
    expect(resolved.anchors[0]?.sourceRef).toBe("E000001");
    expect(resolved.anchors[0]?.canonicalRange).toEqual(
      catalog.entries[0]?.canonicalRange,
    );

    await expect(resolveSelectedEvidenceRefs([], binding)).rejects.toThrow(
      /empty|evidence/i,
    );
    await expect(
      resolveSelectedEvidenceRefs([alias, alias], binding),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      resolveSelectedEvidenceRefs(["Eforeign-001"], binding),
    ).rejects.toThrow(/unknown|foreign/i);

    const otherBinding = await bindEvidenceSpanCatalog(snapshot, catalog, {
      requestIdentity: "request-identity-b",
      windows: [window],
    });
    await expect(
      resolveSelectedEvidenceRefs([alias], otherBinding),
    ).rejects.toThrow(/unknown|foreign|request/i);
  });

  it("captures request identity before asynchronous validation", async () => {
    const snapshot = await makeSnapshot(["一文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const window = await fullWindowInput(snapshot);
    const mutableInput = {
      requestIdentity: "request-before-await",
      windows: [window],
    };
    const pending = bindEvidenceSpanCatalog(snapshot, catalog, mutableInput);
    mutableInput.requestIdentity = "request-after-await";
    const binding = await pending;
    expect(binding.requestIdentity).toBe("request-before-await");
    expect(binding.aliases[0]?.alias).toMatch(/^E[a-f0-9]+-001$/);
  });

  it("rejects a forged persisted window segment instead of resolving unseen display IDs", async () => {
    const snapshot = await makeSnapshot(["一文。二文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const window = await fullWindowInput(snapshot);
    const binding = await bindEvidenceSpanCatalog(snapshot, catalog, {
      requestIdentity: "request-forged-segment",
      windows: [window],
    });
    const alias = binding.aliases[0]?.alias;
    if (!alias) throw new Error("fixture alias missing");
    const forged = JSON.parse(JSON.stringify(binding)) as typeof binding;
    const segment = forged.windows[0]?.segments[0];
    if (!segment) throw new Error("fixture window segment missing");
    (segment as { text: string }).text = "偽造された本文";
    await expect(resolveSelectedEvidenceRefs([alias], forged)).rejects.toThrow(
      /segment|window|stale|binding/i,
    );
  });

  it("keeps anchor IDs tied to canonical occurrences across independent selections", async () => {
    const snapshot = await makeSnapshot(["一文。二文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const window = await fullWindowInput(snapshot);
    const binding = await bindEvidenceSpanCatalog(snapshot, catalog, {
      requestIdentity: "request-anchor-identity",
      windows: [window],
    });
    const firstAlias = binding.aliases[0]?.alias;
    const secondAlias = binding.aliases[1]?.alias;
    if (!firstAlias || !secondAlias) throw new Error("fixture aliases missing");
    const first = await resolveSelectedEvidenceRefs([firstAlias], binding);
    const second = await resolveSelectedEvidenceRefs([secondAlias], binding);
    expect(first.anchors[0]?.id).not.toBe(second.anchors[0]?.id);

    const captured = await validateEvidenceSpanCatalogBinding(binding);
    const resolveWithCaptured =
      await createEvidenceSpanCatalogSelectionResolver(captured);
    const repeated = await resolveWithCaptured([firstAlias]);
    expect(repeated.anchors[0]?.id).toBe(first.anchors[0]?.id);
  });

  it("serializes concurrent selections through one resolver without crossing occurrences", async () => {
    const snapshot = await makeSnapshot(["一文。二文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const window = await fullWindowInput(snapshot);
    const binding = await bindEvidenceSpanCatalog(snapshot, catalog, {
      requestIdentity: "request-concurrent-selection",
      windows: [window],
    });
    const resolve = await createEvidenceSpanCatalogSelectionResolver(binding);
    const firstEntry = catalog.entries[0];
    const secondEntry = catalog.entries[1];
    const firstAlias = binding.aliases[0]?.alias;
    const secondAlias = binding.aliases[1]?.alias;
    if (!firstEntry || !secondEntry || !firstAlias || !secondAlias) {
      throw new Error("fixture concurrent selection entries missing");
    }

    const [first, second] = await Promise.all([
      resolve([firstAlias]),
      resolve([secondAlias]),
    ]);
    expect(first.rawEvidenceReferences).toEqual([
      { sourceRef: firstEntry.sourceRef, quote: firstEntry.quote },
    ]);
    expect(second.rawEvidenceReferences).toEqual([
      { sourceRef: secondEntry.sourceRef, quote: secondEntry.quote },
    ]);
    expect(first.anchors[0]).toMatchObject({
      id: `catalog-anchor-${binding.bindingToken}-${firstEntry.canonicalId.slice(-16)}`,
      sourceRef: firstEntry.sourceRef,
      canonicalRange: firstEntry.canonicalRange,
    });
    expect(second.anchors[0]).toMatchObject({
      id: `catalog-anchor-${binding.bindingToken}-${secondEntry.canonicalId.slice(-16)}`,
      sourceRef: secondEntry.sourceRef,
      canonicalRange: secondEntry.canonicalRange,
    });
    expect(first.anchors[0]?.id).not.toBe(second.anchors[0]?.id);

    const [firstAgain, secondAgain] = await Promise.all([
      resolve([firstAlias]),
      resolve([secondAlias]),
    ]);
    expect(firstAgain.anchors[0]?.id).toBe(first.anchors[0]?.id);
    expect(secondAgain.anchors[0]?.id).toBe(second.anchors[0]?.id);
    expect(firstAgain.rawEvidenceReferences).toEqual(
      first.rawEvidenceReferences,
    );
    expect(secondAgain.rawEvidenceReferences).toEqual(
      second.rawEvidenceReferences,
    );
  });

  it("captures a JSON-restored catalog once and shares its verified copy across windows", async () => {
    const snapshot = await makeSnapshot(["一文。二文。三文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const persistedSnapshot = JSON.parse(
      JSON.stringify(snapshot),
    ) as NarrativeCorpusSnapshot;
    const persistedCatalog = JSON.parse(
      JSON.stringify(catalog),
    ) as EvidenceSpanCatalog;

    resetEvidenceSpanCatalogInstrumentationForTests();
    const capture = await captureEvidenceSpanCatalog(
      persistedSnapshot,
      persistedCatalog,
    );
    expect(getEvidenceSpanCatalogBuildExpectedEntriesCountForTests()).toBe(1);

    const firstEntry = persistedCatalog.entries[0];
    const secondEntry = persistedCatalog.entries[1];
    if (!firstEntry || !secondEntry) {
      throw new Error("fixture persisted catalog entries missing");
    }
    const firstWindow = await windowForEntryInput(
      snapshot,
      catalog.entries[0]!,
      "window-captured-first",
    );
    const secondWindow = await windowForEntryInput(
      snapshot,
      catalog.entries[1]!,
      "window-captured-second",
    );

    const firstBinding = await bindCapturedEvidenceSpanCatalog(capture, {
      requestIdentity: "request-captured-first",
      windows: [firstWindow],
    });
    const secondBinding = await bindCapturedEvidenceSpanCatalog(capture, {
      requestIdentity: "request-captured-second",
      windows: [secondWindow],
    });

    expect(getEvidenceSpanCatalogBuildExpectedEntriesCountForTests()).toBe(1);
    expect(firstBinding.catalog).toBe(secondBinding.catalog);
    expect(firstBinding.snapshot).toBe(secondBinding.snapshot);
    expect(Object.isFrozen(firstBinding.catalog)).toBe(true);
    expect(Object.isFrozen(firstBinding.snapshot)).toBe(true);
    expect(firstBinding.catalog.entries[0]?.quote).toBe(firstEntry.quote);
    expect(secondBinding.catalog.entries[1]?.quote).toBe(secondEntry.quote);

    // A persisted caller object may be changed after capture; the binding still
    // uses only the module-owned verified snapshot/catalog.
    const persistedDocument = persistedSnapshot.documents[0];
    const persistedEntry = persistedCatalog.entries[0];
    if (!persistedDocument || !persistedEntry) {
      throw new Error("fixture persisted catalog mutation target missing");
    }
    const originalFirstQuote = firstBinding.catalog.entries[0]?.quote;
    (persistedDocument.canonical as { text: string }).text = "改竄された本文";
    (persistedEntry as { quote: string }).quote = "改竄された引用";
    expect(firstBinding.catalog.entries[0]?.quote).toBe(originalFirstQuote);
  });

  it("requires full catalog coverage separately and rejects a hole without expanding windows", async () => {
    const snapshot = await makeSnapshot(["一文。二文。"]);
    const catalog = await buildEvidenceSpanCatalog(snapshot);
    const first = catalog.entries[0];
    if (!first) throw new Error("fixture catalog entry missing");
    const document = snapshot.documents[0];
    if (!document) throw new Error("fixture document missing");
    const firstView = await buildNarrativeSourceView({
      ref: "window:window-hole",
      document,
      documentRange: first.canonicalRange,
    });
    const window: EvidenceSpanCatalogWindowInput = {
      windowId: "window-hole",
      documentRef: document.ref,
      sourceView: firstView,
      ownedRanges: [first.canonicalRange],
      contextRanges: [],
    };
    expect(() => assertEvidenceSpanCatalogCoverage(catalog, [window])).toThrow(
      /coverage|hole|E000002/i,
    );
  });
});
