import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: invokeMock,
  isTauri: vi.fn(() => true),
}));

vi.mock("@/lib/shell", () => ({
  isElectron: vi.fn(() => true),
}));

import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import type {
  CanonicalRange,
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
} from "@/features/narrative-extraction/source/types";
import { runEntityCandidatePrepass } from "./entityCandidatePrepass";

interface CorpusFixture {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly sourceViews: readonly NarrativeSourceView[];
}

interface NativeOccurrenceFixture {
  readonly sourceRef: string;
  readonly quote: string;
  readonly canonicalRange: CanonicalRange;
  readonly context: {
    readonly prefix: string;
    readonly suffix: string;
  };
}

function proseMirrorJson(...paragraphs: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      ...(text.length > 0 ? { content: [{ type: "text", text }] } : {}),
    })),
  });
}

async function corpusFixture(language = "ja"): Promise<CorpusFixture> {
  const result = await buildNarrativeCorpusSnapshot({
    snapshotId: `snapshot-seed-${language}`,
    language,
    origin: { kind: "grimodex-project", projectId: "private-project-id" },
    documents: [
      {
        sourceKey: "project:scene:private-scene-a",
        parentSourceKey: null,
        title: "Scene A",
        orderIndex: 0,
        proseMirrorJson: proseMirrorJson(
          "🎉ライカが来た。",
          "「ライカ」と呼んだ。",
        ),
        origin: {
          kind: "project-node",
          projectId: "private-project-id",
          nodeId: "private-scene-a",
          sourceVersion: 7,
          sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
          sourceUri: null,
        },
      },
      {
        sourceKey: "project:scene:private-scene-b",
        parentSourceKey: null,
        title: "Scene B",
        orderIndex: 1,
        proseMirrorJson: proseMirrorJson("ベルカはライカを待った。"),
        origin: {
          kind: "project-node",
          projectId: "private-project-id",
          nodeId: "private-scene-b",
          sourceVersion: 11,
          sourceUpdatedAt: "2026-08-10T00:00:01.000Z",
          sourceUri: null,
        },
      },
    ],
    omissions: [],
    createdAt: "2026-08-10T00:01:00.000Z",
  });
  if (!result.ok) {
    throw new Error(
      `expected seed fixture snapshot: ${result.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(", ")}`,
    );
  }

  const sourceViews = await Promise.all(
    result.snapshot.documents.map((document, index) =>
      buildNarrativeSourceView({
        ref: `S${String(index + 1).padStart(6, "0")}`,
        document,
        documentRange: { start: 0, end: document.canonical.text.length },
      }),
    ),
  );
  return { snapshot: result.snapshot, sourceViews };
}

async function inlineDialogueFixture(): Promise<CorpusFixture> {
  const result = await buildNarrativeCorpusSnapshot({
    snapshotId: "snapshot-seed-inline-dialogue",
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "private-project-id" },
    documents: [
      {
        sourceKey: "project:scene:private-inline-dialogue",
        parentSourceKey: null,
        title: "Inline dialogue",
        orderIndex: 0,
        proseMirrorJson: proseMirrorJson(
          "彼は「ライカ」と呼んだ後、ベルカが来た。",
        ),
        origin: {
          kind: "project-node",
          projectId: "private-project-id",
          nodeId: "private-inline-dialogue",
          sourceVersion: 1,
          sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
          sourceUri: null,
        },
      },
    ],
    omissions: [],
    createdAt: "2026-08-10T00:01:00.000Z",
  });
  if (!result.ok) throw new Error("expected inline dialogue fixture");
  const document = result.snapshot.documents[0];
  if (!document) throw new Error("expected inline dialogue document");
  const sourceViews = await Promise.all([
    buildNarrativeSourceView({
      ref: "S000001",
      document,
      documentRange: { start: 3, end: 6 },
    }),
    buildNarrativeSourceView({
      ref: "S000002",
      document,
      documentRange: { start: 13, end: 16 },
    }),
  ]);
  return { snapshot: result.snapshot, sourceViews };
}

function occurrence(
  sourceRef: string,
  canonicalRange: CanonicalRange,
  prefix: string,
  suffix: string,
): NativeOccurrenceFixture {
  return {
    sourceRef,
    quote: "ライカ",
    canonicalRange,
    context: { prefix, suffix },
  };
}

function nativeSeed(
  seedId: string,
  occurrences: readonly NativeOccurrenceFixture[],
) {
  return {
    seedId,
    surface: "ライカ",
    normalizedSurface: "ライカ",
    occurrences,
    features: {
      occurrenceCount: occurrences.length,
      appearsAsProperName: true,
      appearsInDialogue: occurrences.some(
        (candidate) => candidate.context.prefix === "「",
      ),
      appearsInNarration: occurrences.some(
        (candidate) => candidate.context.prefix !== "「",
      ),
    },
  };
}

function input(
  fixture: CorpusFixture,
  minimumOccurrenceCount = 1,
  sourceViews: readonly NarrativeSourceView[] = fixture.sourceViews,
) {
  let anchorIndex = 0;
  return {
    snapshot: fixture.snapshot,
    sourceViews,
    minimumOccurrenceCount,
    createEvidenceAnchorId: () => `EA${String(++anchorIndex).padStart(6, "0")}`,
  };
}

function expectDeeplyFrozen(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) {
    expectDeeplyFrozen(nested, seen);
  }
}

describe("runEntityCandidatePrepass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends only opaque canonical sources and verifies exact UTF-16 occurrences across sources", async () => {
    const fixture = await corpusFixture();
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      seeds: [
        nativeSeed("native-seed-a", [
          occurrence("S000001", { start: 2, end: 5 }, "🎉", "が来た。"),
          occurrence("S000001", { start: 11, end: 14 }, "「", "」と呼んだ。"),
          occurrence("S000002", { start: 4, end: 7 }, "ベルカは", "を待った。"),
        ]),
      ],
    });

    const result = await runEntityCandidatePrepass(input(fixture));

    expect(invokeMock).toHaveBeenCalledWith("extract_codex_entity_seeds", {
      schemaVersion: 1,
      normalizerVersion: "gdx-canonical-text/1",
      language: "ja",
      minimumOccurrenceCount: 1,
      sources: fixture.sourceViews.map((sourceView) => ({
        sourceRef: sourceView.ref,
        documentRef: sourceView.documentRef,
        documentRange: sourceView.documentRange,
        text: sourceView.text,
      })),
    });
    expect(JSON.stringify(invokeMock.mock.calls[0])).not.toContain(
      "private-scene",
    );
    expect(result.status).toBe("complete");
    expect(result.rejections).toEqual([]);
    expect(result.seeds).toHaveLength(1);
    expect(result.seeds[0]).toMatchObject({
      surface: "ライカ",
      normalizedSurface: "ライカ",
      features: {
        occurrenceCount: 3,
        appearsAsProperName: true,
        appearsInDialogue: true,
        appearsInNarration: true,
      },
    });
    expect(
      result.seeds[0]?.occurrences.map((candidate) => ({
        sourceRef: candidate.sourceRef,
        canonicalRange: candidate.canonicalRange,
      })),
    ).toEqual([
      { sourceRef: "S000001", canonicalRange: { start: 2, end: 5 } },
      { sourceRef: "S000001", canonicalRange: { start: 11, end: 14 } },
      { sourceRef: "S000002", canonicalRange: { start: 4, end: 7 } },
    ]);
  });

  it("rejects unknown and forged occurrences without discarding a valid occurrence", async () => {
    const fixture = await corpusFixture();
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      seeds: [
        nativeSeed("native-seed-a", [
          occurrence("S000002", { start: 4, end: 7 }, "ベルカは", "を待った。"),
          occurrence("S999999", { start: 0, end: 3 }, "", ""),
          occurrence("S000001", { start: 3, end: 6 }, "", ""),
        ]),
      ],
    });

    const result = await runEntityCandidatePrepass(input(fixture));

    expect(result.status).toBe("complete");
    expect(result.rejections).toHaveLength(2);
    expect(result.seeds).toHaveLength(1);
    expect(result.seeds[0]?.features.occurrenceCount).toBe(1);
    expect(result.seeds[0]?.occurrences).toEqual([
      expect.objectContaining({
        sourceRef: "S000002",
        canonicalRange: { start: 4, end: 7 },
      }),
    ]);
  });

  it("deduplicates one document occurrence repeated by overlapping Source Views", async () => {
    const fixture = await corpusFixture();
    const firstDocument = fixture.snapshot.documents[0];
    if (!firstDocument) throw new Error("expected first fixture document");
    const overlappingView = await buildNarrativeSourceView({
      ref: "S000003",
      document: firstDocument,
      documentRange: {
        start: 0,
        end: firstDocument.canonical.text.length,
      },
    });
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      seeds: [
        nativeSeed("native-seed-a", [
          occurrence("S000001", { start: 2, end: 5 }, "🎉", "が来た。"),
          occurrence("S000003", { start: 2, end: 5 }, "🎉", "が来た。"),
        ]),
      ],
    });

    const result = await runEntityCandidatePrepass(
      input(fixture, 1, [...fixture.sourceViews, overlappingView]),
    );

    expect(result.status).toBe("complete");
    expect(result.rejections).toEqual([]);
    expect(result.seeds).toHaveLength(1);
    expect(result.seeds[0]?.features.occurrenceCount).toBe(1);
    expect(result.seeds[0]?.occurrences).toEqual([
      expect.objectContaining({
        sourceRef: "S000001",
        canonicalRange: { start: 2, end: 5 },
      }),
    ]);
  });

  it("recounts verified occurrences and reapplies the minimum after a rejection", async () => {
    const fixture = await corpusFixture();
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      seeds: [
        nativeSeed("native-seed-a", [
          occurrence("S000002", { start: 4, end: 7 }, "ベルカは", "を待った。"),
          occurrence("S000001", { start: 3, end: 6 }, "", ""),
        ]),
      ],
    });

    const result = await runEntityCandidatePrepass(input(fixture, 2));

    expect(result.status).toBe("complete");
    expect(result.rejections).toHaveLength(1);
    expect(result.seeds).toEqual([]);
  });

  it("does not collapse a Native transport failure to an empty successful result", async () => {
    const fixture = await corpusFixture();
    invokeMock.mockRejectedValue(new Error("entity seed transport failed"));

    await expect(runEntityCandidatePrepass(input(fixture))).rejects.toThrow(
      "entity seed transport failed",
    );
  });

  it("rejects a Native seed whose exact occurrence belongs to another normalized surface", async () => {
    const fixture = await corpusFixture();
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      seeds: [
        {
          ...nativeSeed("native-seed-forged-surface", []),
          occurrences: [
            {
              sourceRef: "S000002",
              quote: "ベルカ",
              canonicalRange: { start: 0, end: 3 },
              context: { prefix: "", suffix: "はライカを待った。" },
            },
          ],
          features: {
            occurrenceCount: 1,
            appearsAsProperName: true,
            appearsInDialogue: false,
            appearsInNarration: true,
          },
        },
      ],
    });

    await expect(runEntityCandidatePrepass(input(fixture))).rejects.toThrow(
      "surface is not grounded",
    );
  });

  it("rejects duplicate normalized surfaces from Native", async () => {
    const fixture = await corpusFixture();
    const sharedOccurrence = occurrence(
      "S000002",
      { start: 4, end: 7 },
      "ベルカは",
      "を待った。",
    );
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      seeds: [
        nativeSeed("native-seed-a", [sharedOccurrence]),
        nativeSeed("native-seed-b", [sharedOccurrence]),
      ],
    });

    await expect(runEntityCandidatePrepass(input(fixture))).rejects.toThrow(
      "Duplicate normalized entity seed surface",
    );
  });

  it("returns an explicit unsupported-language result without invoking Native", async () => {
    const fixture = await corpusFixture("en");

    await expect(runEntityCandidatePrepass(input(fixture))).resolves.toEqual({
      status: "unsupported-language",
      language: "en",
      seeds: [],
      rejections: [],
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("recursively freezes the verified result", async () => {
    const fixture = await corpusFixture();
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      seeds: [
        nativeSeed("native-seed-a", [
          occurrence("S000002", { start: 4, end: 7 }, "ベルカは", "を待った。"),
        ]),
      ],
    });

    const result = await runEntityCandidatePrepass(input(fixture));

    expect(result.status).toBe("complete");
    expectDeeplyFrozen(result);
  });

  it("classifies partial Source Views against document-global quote intervals", async () => {
    const fixture = await inlineDialogueFixture();
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      seeds: [
        {
          seedId: "native-seed-inline-dialogue",
          surface: "ライカ",
          normalizedSurface: "ライカ",
          occurrences: [
            {
              sourceRef: "S000001",
              quote: "ライカ",
              canonicalRange: { start: 3, end: 6 },
              context: { prefix: "", suffix: "" },
            },
          ],
          features: {
            occurrenceCount: 1,
            appearsAsProperName: true,
            appearsInDialogue: false,
            appearsInNarration: true,
          },
        },
        {
          seedId: "native-seed-after-dialogue",
          surface: "ベルカ",
          normalizedSurface: "ベルカ",
          occurrences: [
            {
              sourceRef: "S000002",
              quote: "ベルカ",
              canonicalRange: { start: 13, end: 16 },
              context: { prefix: "", suffix: "" },
            },
          ],
          features: {
            occurrenceCount: 1,
            appearsAsProperName: true,
            appearsInDialogue: true,
            appearsInNarration: false,
          },
        },
      ],
    });

    const result = await runEntityCandidatePrepass(input(fixture));

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(
      result.seeds.find((seed) => seed.surface === "ライカ")?.features,
    ).toMatchObject({ appearsInDialogue: true, appearsInNarration: false });
    expect(
      result.seeds.find((seed) => seed.surface === "ベルカ")?.features,
    ).toMatchObject({ appearsInDialogue: false, appearsInNarration: true });
  });
});
