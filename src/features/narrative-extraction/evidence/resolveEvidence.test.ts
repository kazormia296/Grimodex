import { describe, expect, it, vi } from "vitest";
import { serializeProseMirrorDocument } from "../source/proseMirrorSerializer";
import { buildNarrativeSourceView } from "../source/sourceView";
import type {
  NarrativeCorpusDocument,
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
  Sha256Digest,
} from "../source/types";
import { resolveEvidenceReference } from "./resolveEvidence";
import type { RawEvidenceReference } from "./types";

interface ProseMirrorJsonNode {
  type: string;
  text?: string;
  content?: ProseMirrorJsonNode[];
}

const SNAPSHOT_DIGEST = `sha256:${"1".repeat(64)}` as Sha256Digest;
const CONTENT_DIGEST = `sha256:${"2".repeat(64)}` as Sha256Digest;
const DOCUMENT_DIGEST = `sha256:${"3".repeat(64)}` as Sha256Digest;
const SOURCE_DIGEST = `sha256:${"4".repeat(64)}` as Sha256Digest;
const ARTIFACT_DIGEST = `sha256:${"5".repeat(64)}` as Sha256Digest;

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

interface EvidenceFixture {
  snapshot: NarrativeCorpusSnapshot;
  document: NarrativeCorpusDocument;
  sourceView: NarrativeSourceView;
}

async function fixture(...paragraphs: string[]): Promise<EvidenceFixture> {
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
    artifactDigest: ARTIFACT_DIGEST,
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
    artifactDigest: ARTIFACT_DIGEST,
  } as NarrativeCorpusSnapshot;
  const sourceView = await buildNarrativeSourceView({
    ref: "S0001",
    document,
    documentRange: { start: 0, end: canonical.text.length },
  });
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
  source: EvidenceFixture,
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
    const source = await fixture("序章。鐘が鳴った。終章。");
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
        sourceDigest: source.sourceView.digest,
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
    const source = await fixture("鐘が鳴った。");
    const ctx = context(source);

    const result = await resolveEvidenceReference(
      raw({ quote: "雷が落ちた" }),
      ctx,
    );

    expect(result).toMatchObject({ status: "not-found" });
    expect(ctx.createAnchorId).not.toHaveBeenCalled();
  });

  it("returns ambiguous for two exact occurrences instead of adopting the first", async () => {
    const source = await fixture("東門が開いた朝。西門が開いた夜。");
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
    const source = await fixture("東門が開いた朝。西門が開いた夜。");
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
    const source = await fixture("鐘が鳴った。");
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
    const source = await fixture("鐘が鳴った。12345");
    const ctx = context(
      source,
      maxQuoteLength === undefined ? {} : { maxQuoteLength },
    );

    const result = await resolveEvidenceReference(raw({ quote }), ctx);

    expect(result).toMatchObject({ status: "invalid" });
    expect(ctx.createAnchorId).not.toHaveBeenCalled();
  });

  it("keeps a paragraph-spanning exact quote resolved with fragmented projection", async () => {
    const source = await fixture("第一段", "第二段");
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

  it("keeps bounded context on complete UTF-16 scalar boundaries", async () => {
    const source = await fixture("😀A😀");
    const ctx = context(source, { contextRadius: 1 });

    const result = await resolveEvidenceReference(raw({ quote: "A" }), ctx);

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.anchor.context).toEqual({ prefix: "😀", suffix: "😀" });
  });

  it("freezes untrusted reference values before awaiting its digest", async () => {
    const source = await fixture("before target after");
    const ctx = context(source);
    const reference = raw({ quote: "target" }) as {
      sourceRef: string;
      quote: string;
    };

    const pending = resolveEvidenceReference(reference, ctx);
    reference.sourceRef = "S-mutated";
    reference.quote = "mutated";
    const result = await pending;

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.anchor.sourceRef).toBe("S0001");
    expect(result.anchor.quote).toBe("target");
  });

  it("rejects a Source View whose manifest digest does not match its sealed slice", async () => {
    const source = await fixture("before target after");
    const sourceView = { ...source.sourceView, digest: SOURCE_DIGEST };

    const result = await resolveEvidenceReference(
      raw({ quote: "target" }),
      context({ ...source, sourceView }),
    );

    expect(result).toMatchObject({
      status: "invalid",
      reason: "source-view-digest-mismatch",
    });
  });

  it("projects against the artifact-sealed projection instead of its compatibility alias", async () => {
    const source = await fixture("before target after");
    const document = {
      ...source.document,
      canonical: {
        ...source.document.canonical,
        projectionMap: {
          schemaVersion: 1 as const,
          unit: "utf16" as const,
          canonicalLength: source.document.canonical.text.length,
          segments: [],
        },
      },
    };
    const snapshot = { ...source.snapshot, documents: [document] };

    const result = await resolveEvidenceReference(
      raw({ quote: "target" }),
      context({ ...source, document, snapshot }),
    );

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.anchor.projection.status).toBe("exact");
  });

  it("rejects a source view whose range splits a surrogate pair", async () => {
    const source = await fixture("😀A");
    const splitView = {
      ...source.sourceView,
      documentRange: { start: 1, end: source.document.canonical.text.length },
      text: source.document.canonical.text.slice(1),
    };
    const ctx = context({ ...source, sourceView: splitView });

    const result = await resolveEvidenceReference(raw({ quote: "A" }), ctx);

    expect(result).toMatchObject({
      status: "invalid",
      reason: "invalid-source-view",
    });
  });
});
