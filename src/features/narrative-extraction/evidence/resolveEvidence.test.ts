import { describe, expect, it, vi } from "vitest";
import { serializeProseMirrorDocument } from "../source/proseMirrorSerializer";
import type {
  NarrativeCorpusDocument,
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
} from "../source/types";
import { resolveEvidenceReference } from "./resolveEvidence";
import type { RawEvidenceReference } from "./types";

interface ProseMirrorJsonNode {
  type: string;
  text?: string;
  content?: ProseMirrorJsonNode[];
}

const SNAPSHOT_DIGEST = `sha256:${"1".repeat(64)}`;
const CONTENT_DIGEST = `sha256:${"2".repeat(64)}`;
const DOCUMENT_DIGEST = `sha256:${"3".repeat(64)}`;
const SOURCE_DIGEST = `sha256:${"4".repeat(64)}`;

function paragraph(text: string): ProseMirrorJsonNode {
  return {
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  };
}

function canonicalFromParagraphs(...paragraphs: string[]) {
  const result = serializeProseMirrorDocument(
    JSON.stringify({
      type: "doc",
      content: paragraphs.map(paragraph),
    }),
  );
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(`expected serialization to succeed: ${result.diagnostics}`);
  }
  return result.canonical;
}

function fixture(...paragraphs: string[]): {
  snapshot: NarrativeCorpusSnapshot;
  document: NarrativeCorpusDocument;
  sourceView: NarrativeSourceView;
} {
  const canonical = canonicalFromParagraphs(...paragraphs);
  const document = {
    ref: "D000001",
    sourceKey: "project:scene:scene-a",
    parentRef: null,
    title: "Scene A",
    orderIndex: 0,
    canonical,
    contentDigest: CONTENT_DIGEST,
    documentDigest: DOCUMENT_DIGEST,
    origin: {
      kind: "project-node",
      projectId: "project-a",
      nodeId: "scene-a",
      sourceVersion: 7,
      sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
      sourceUri: null,
    },
  } as NarrativeCorpusDocument;
  const snapshot = {
    schemaVersion: 1,
    id: "snapshot-a",
    snapshotId: "snapshot-a",
    createdAt: "2026-08-10T00:01:00.000Z",
    language: "ja",
    normalizerVersion: "gdx-canonical-text/1",
    origin: { kind: "grimodex-project", projectId: "project-a" },
    documents: [document],
    omissions: [],
    digest: SNAPSHOT_DIGEST,
  } as NarrativeCorpusSnapshot;
  const sourceView = {
    ref: "S0001",
    documentRef: document.ref,
    documentRange: { start: 0, end: canonical.text.length },
    text: canonical.text,
    digest: SOURCE_DIGEST,
  } as NarrativeSourceView;
  return { snapshot, document, sourceView };
}

function raw(
  overrides: Partial<RawEvidenceReference> = {},
): RawEvidenceReference {
  return {
    sourceRef: "S0001",
    quote: "鐘が鳴った",
    ...overrides,
  } as RawEvidenceReference;
}

function context(
  source: ReturnType<typeof fixture>,
  overrides: Partial<{
    contextRadius: number;
    maxQuoteLength: number;
  }> = {},
) {
  return {
    snapshot: source.snapshot,
    sourceViews: [source.sourceView],
    createAnchorId: vi.fn(() => "EA000001"),
    ...overrides,
  };
}

describe("resolveEvidenceReference", () => {
  it("resolves one exact quote to a canonical and ProseMirror anchor", async () => {
    const source = fixture("序章。鐘が鳴った。終章。");
    const ctx = context(source);

    const result = await resolveEvidenceReference(raw(), ctx);

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.anchor).toEqual(
      expect.objectContaining({
        id: "EA000001",
        sourceRef: "S0001",
        documentRef: "D000001",
        quote: "鐘が鳴った",
        canonicalRange: { start: 3, end: 8 },
        method: "exact",
        initialMatchCount: 1,
        snapshotDigest: SNAPSHOT_DIGEST,
        documentDigest: DOCUMENT_DIGEST,
        sourceDigest: SOURCE_DIGEST,
        quoteDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    );
    expect(result.anchor.projection).toEqual({
      status: "exact",
      fragments: [
        {
          canonicalStart: 3,
          canonicalEnd: 8,
          from: 4,
          to: 9,
          kind: "linear",
        },
      ],
    });
    expect(ctx.createAnchorId).toHaveBeenCalledOnce();
  });

  it("returns not-found when the quote has no exact occurrence", async () => {
    const source = fixture("鐘が鳴った。");
    const ctx = context(source);

    const result = await resolveEvidenceReference(
      raw({ quote: "雷が落ちた" }),
      ctx,
    );

    expect(result).toMatchObject({ status: "not-found" });
    expect(ctx.createAnchorId).not.toHaveBeenCalled();
  });

  it("returns ambiguous for two exact occurrences instead of adopting the first", async () => {
    const source = fixture("東門が開いた朝。西門が開いた夜。");
    const ctx = context(source);

    const result = await resolveEvidenceReference(
      raw({ quote: "門が開いた" }),
      ctx,
    );

    expect(result).toMatchObject({ status: "ambiguous" });
    expect(ctx.createAnchorId).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("anchor");
  });

  it("uses exact prefix and suffix context to make a duplicate quote unique", async () => {
    const source = fixture("東門が開いた朝。西門が開いた夜。");
    const ctx = context(source);

    const result = await resolveEvidenceReference(
      raw({ quote: "門が開いた", prefix: "西", suffix: "夜" }),
      ctx,
    );

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.anchor).toEqual(
      expect.objectContaining({
        canonicalRange: { start: 9, end: 14 },
        method: "exact-with-context",
        initialMatchCount: 2,
      }),
    );
  });

  it("rejects an unknown source reference as invalid", async () => {
    const source = fixture("鐘が鳴った。");
    const ctx = context(source);

    const result = await resolveEvidenceReference(
      raw({ sourceRef: "S9999" }),
      ctx,
    );

    expect(result).toMatchObject({ status: "invalid" });
    expect(ctx.createAnchorId).not.toHaveBeenCalled();
  });

  it.each([
    { name: "empty", quote: "", maxQuoteLength: undefined },
    { name: "oversized", quote: "12345", maxQuoteLength: 4 },
    {
      name: "isolated high surrogate",
      quote: "\uD800",
      maxQuoteLength: undefined,
    },
    {
      name: "isolated low surrogate",
      quote: "\uDC00",
      maxQuoteLength: undefined,
    },
  ])("rejects an $name quote as invalid", async ({ quote, maxQuoteLength }) => {
    const source = fixture("鐘が鳴った。12345");
    const ctx = context(
      source,
      maxQuoteLength === undefined ? {} : { maxQuoteLength },
    );

    const result = await resolveEvidenceReference(raw({ quote }), ctx);

    expect(result).toMatchObject({ status: "invalid" });
    expect(ctx.createAnchorId).not.toHaveBeenCalled();
  });

  it("keeps a paragraph-spanning exact quote resolved with fragmented projection", async () => {
    const source = fixture("第一段", "第二段");
    const ctx = context(source);

    const result = await resolveEvidenceReference(
      raw({ quote: "一段\n第二" }),
      ctx,
    );

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.anchor.canonicalRange).toEqual({ start: 1, end: 6 });
    expect(result.anchor.projection).toEqual({
      status: "fragmented",
      fragments: [
        {
          canonicalStart: 1,
          canonicalEnd: 3,
          from: 2,
          to: 4,
          kind: "linear",
        },
        {
          canonicalStart: 4,
          canonicalEnd: 6,
          from: 6,
          to: 8,
          kind: "linear",
        },
      ],
      enclosingRange: { from: 2, to: 8 },
    });
  });
});
