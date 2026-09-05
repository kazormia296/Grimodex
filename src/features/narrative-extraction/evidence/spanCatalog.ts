import {
  buildNarrativeSourceView,
  computeNarrativeSourceViewDigest,
} from "../source/sourceView";
import { digestStableJson, hasLoneSurrogate } from "../source/digest";
import { freezeDeep } from "../source/immutability";
import type {
  CanonicalBlockSpan,
  CanonicalRange,
  CanonicalText,
  NarrativeCorpusDocument,
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
  ProjectionSegment,
  Sha256Digest,
} from "../source/types";
import {
  createDeterministicEvidenceResolver,
  type DeterministicEvidenceResolver,
} from "./resolveEvidence";
import type { RawEvidenceReference, ResolvedEvidenceAnchor } from "./types";

/** Persisted artifact kind for the code-owned citation occurrence catalog. */
export const EVIDENCE_SPAN_CATALOG_KIND =
  "narrative-evidence-span-catalog" as const;
export const EVIDENCE_SPAN_CATALOG_VERSION = 1 as const;
export const EVIDENCE_SPAN_SEGMENTATION_VERSION = "sentence-like-v1" as const;
export const EVIDENCE_SPAN_MAX_QUOTE_LENGTH = 4_096 as const;
/** Compatibility name for callers that prefer a generic limit constant. */
export const MAX_EVIDENCE_QUOTE_LENGTH = EVIDENCE_SPAN_MAX_QUOTE_LENGTH;

const EVIDENCE_SPAN_BINDING_KIND = "narrative-evidence-span-binding" as const;
const EVIDENCE_SPAN_BINDING_VERSION = 1 as const;

const OPENING_BRACKETS: Readonly<Record<string, string>> = {
  "「": "」",
  "『": "』",
  "（": "）",
  "(": ")",
  "［": "］",
  "[": "]",
  "【": "】",
  "〈": "〉",
  "《": "》",
  "〔": "〕",
  "〖": "〗",
  "“": "”",
  "｛": "｝",
  "{": "}",
};

const CLOSING_BRACKETS = new Set(Object.values(OPENING_BRACKETS));
const SENTENCE_TERMINALS = new Set(["。", "！", "？", "!", "?", "\n"]);

export interface EvidenceSpanCanonicalIdentity {
  readonly snapshotDigest: Sha256Digest;
  readonly snapshotArtifactDigest: Sha256Digest;
  readonly documentRef: string;
  readonly documentArtifactDigest: Sha256Digest;
  readonly range: CanonicalRange;
  readonly start: number;
  readonly end: number;
  readonly segmentationVersion: typeof EVIDENCE_SPAN_SEGMENTATION_VERSION;
}

/** One exact occurrence in a sealed snapshot. */
export interface EvidenceSpanCatalogEntry {
  /** Digest-backed identity; it is never derived from quote text alone. */
  readonly canonicalId: string;
  /** Snapshot-global internal source reference consumed by the existing resolver. */
  readonly sourceRef: string;
  readonly documentRef: string;
  readonly canonicalRange: CanonicalRange;
  /** Compatibility alias for range-oriented consumers. */
  readonly range: CanonicalRange;
  /** Exact source text for this one occurrence. */
  readonly quote: string;
  /** Compatibility alias retained in the persisted catalog. */
  readonly text: string;
  /** Enclosing structural blocks, excluding the leaf block that owns the span. */
  readonly parentBlockIds: readonly string[];
  /** Constructed by the code-owned source-view builder. */
  readonly sourceView: NarrativeSourceView;
  readonly identity: EvidenceSpanCanonicalIdentity;
}

export interface EvidenceSpanCatalog {
  readonly kind: typeof EVIDENCE_SPAN_CATALOG_KIND;
  readonly version: typeof EVIDENCE_SPAN_CATALOG_VERSION;
  readonly segmentationVersion: typeof EVIDENCE_SPAN_SEGMENTATION_VERSION;
  readonly snapshotId: string;
  readonly snapshotDigest: Sha256Digest;
  readonly snapshotArtifactDigest: Sha256Digest;
  readonly digest: Sha256Digest;
  readonly entries: readonly EvidenceSpanCatalogEntry[];
}

export interface BuildEvidenceSpanCatalogOptions {
  /** The only accepted value is the current versioned splitter. */
  readonly segmentationVersion?: typeof EVIDENCE_SPAN_SEGMENTATION_VERSION;
}

export type EvidenceSpanCatalogValidationReason =
  | "invalid-snapshot"
  | "invalid-catalog"
  | "catalog-kind-mismatch"
  | "catalog-version-mismatch"
  | "segmentation-version-mismatch"
  | "snapshot-identity-mismatch"
  | "catalog-digest-mismatch"
  | "entry-mismatch"
  | "source-view-mismatch";

export type EvidenceSpanCatalogValidation =
  | {
      readonly ok: true;
      readonly valid: true;
      readonly diagnostics: readonly [];
    }
  | {
      readonly ok: false;
      readonly valid: false;
      readonly reason: EvidenceSpanCatalogValidationReason;
      readonly diagnostics: readonly string[];
    };

export interface EvidenceSpanCatalogWindowInput {
  readonly windowId: string;
  readonly documentRef: string;
  /** The exact original reading window; its text must not be regenerated. */
  readonly sourceView: NarrativeSourceView;
  /** Assignment metadata from the existing window planner. */
  readonly ownedRanges: readonly CanonicalRange[];
  readonly contextRanges?: readonly CanonicalRange[];
}

export interface EvidenceSpanCatalogWindowSegment {
  readonly kind: "span" | "context";
  /** Concatenating all segment text reproduces sourceView.text exactly. */
  readonly text: string;
  /** Request-local display alias, present only for a fully visible span. */
  readonly evidenceRef?: string;
  /** Snapshot-global source reference, never model-authored. */
  readonly canonicalSourceRef?: string;
  readonly canonicalRange?: CanonicalRange;
  readonly parentBlockIds: readonly string[];
  /** True when this context contains only a partial catalog occurrence. */
  readonly partialContext?: boolean;
}

export interface EvidenceSpanCatalogWindowBinding {
  readonly windowId: string;
  readonly documentRef: string;
  readonly sourceView: NarrativeSourceView;
  readonly text: string;
  readonly ownedRanges: readonly CanonicalRange[];
  readonly contextRanges: readonly CanonicalRange[];
  readonly segments: readonly EvidenceSpanCatalogWindowSegment[];
  readonly visibleSourceRefs: readonly string[];
}

export interface EvidenceSpanCatalogAlias {
  readonly alias: string;
  readonly canonicalSourceRef: string;
  readonly canonicalId: string;
  readonly windowIds: readonly string[];
}

export interface EvidenceSpanCatalogBinding {
  readonly kind: typeof EVIDENCE_SPAN_BINDING_KIND;
  readonly version: typeof EVIDENCE_SPAN_BINDING_VERSION;
  /** Explicit request identity captured before provider dispatch. */
  readonly requestIdentity: string;
  /** Short opaque request-local display prefix; never model-echoed as a digest. */
  readonly bindingToken: string;
  readonly snapshotId: string;
  readonly snapshotDigest: Sha256Digest;
  readonly snapshotArtifactDigest: Sha256Digest;
  readonly catalogDigest: Sha256Digest;
  /** Captured immutable inputs used for deterministic resolution and replay. */
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly catalog: EvidenceSpanCatalog;
  readonly windows: readonly EvidenceSpanCatalogWindowBinding[];
  readonly sourceViews: readonly NarrativeSourceView[];
  readonly aliases: readonly EvidenceSpanCatalogAlias[];
}

export interface ResolvedSelectedEvidenceRefs {
  readonly rawEvidenceReferences: readonly RawEvidenceReference[];
  readonly anchors: readonly ResolvedEvidenceAnchor[];
}

export class EvidenceSpanCatalogError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvidenceSpanCatalogError";
    this.code = code;
  }
}

export class EvidenceSpanCatalogCoverageError extends EvidenceSpanCatalogError {
  readonly missingSourceRefs: readonly string[];

  constructor(missingSourceRefs: readonly string[]) {
    super(
      "EVIDENCE_SPAN_CATALOG_COVERAGE_HOLE",
      `Evidence span catalog coverage hole: ${missingSourceRefs.join(", ")}`,
    );
    this.name = "EvidenceSpanCatalogCoverageError";
    this.missingSourceRefs = [...missingSourceRefs];
  }
}

export class EvidenceSpanReferenceError extends EvidenceSpanCatalogError {
  readonly evidenceRef?: string;

  constructor(code: string, message: string, evidenceRef?: string) {
    super(code, message);
    this.name = "EvidenceSpanReferenceError";
    this.evidenceRef = evidenceRef;
  }
}

interface SpanSeed {
  readonly document: NarrativeCorpusDocument;
  readonly canonicalRange: CanonicalRange;
  readonly quote: string;
  readonly parentBlockIds: readonly string[];
}

interface StableSnapshotFields {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly documentsByRef: ReadonlyMap<string, NarrativeCorpusDocument>;
}

interface VerifiedCatalogHandle {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly catalog: EvidenceSpanCatalog;
  readonly snapshotFields: StableSnapshotFields;
  readonly entriesBySourceRef: ReadonlyMap<string, EvidenceSpanCatalogEntry>;
  readonly sourceViews: readonly NarrativeSourceView[];
}

interface CatalogSelectionIndex {
  readonly entriesBySourceRef: ReadonlyMap<string, EvidenceSpanCatalogEntry>;
  readonly resolveEntries: (
    selectedEntries: readonly EvidenceSpanCatalogEntry[],
  ) => Promise<ResolvedSelectedEvidenceRefs>;
}

interface CheckedBindingHandle {
  readonly binding: ReturnType<typeof copyBinding>;
  readonly manifest: AliasManifest;
  readonly selectionIndex: CatalogSelectionIndex;
}

/**
 * Only objects created and frozen by this module are inserted here. A
 * persisted JSON object, including one that the caller has frozen, never
 * becomes a cache hit until it has been copied and fully verified.
 */
const verifiedCatalogPairs = new WeakMap<
  object,
  WeakMap<object, VerifiedCatalogHandle>
>();
const checkedBindingHandles = new WeakMap<object, CheckedBindingHandle>();

interface StableWindowInput {
  readonly windowId: string;
  readonly documentRef: string;
  readonly sourceView: NarrativeSourceView;
  readonly ownedRanges: readonly CanonicalRange[];
  readonly contextRanges: readonly CanonicalRange[];
}

interface AliasManifest {
  readonly aliases: readonly EvidenceSpanCatalogAlias[];
  readonly byAlias: ReadonlyMap<string, EvidenceSpanCatalogAlias>;
  readonly bySourceRef: ReadonlyMap<string, EvidenceSpanCatalogAlias>;
}

function segmentEquivalent(
  expected: EvidenceSpanCatalogWindowSegment,
  actual: EvidenceSpanCatalogWindowSegment,
): boolean {
  return (
    expected.kind === actual.kind &&
    expected.text === actual.text &&
    expected.evidenceRef === actual.evidenceRef &&
    expected.canonicalSourceRef === actual.canonicalSourceRef &&
    (expected.canonicalRange === undefined
      ? actual.canonicalRange === undefined
      : actual.canonicalRange !== undefined &&
        rangesEqual(expected.canonicalRange, actual.canonicalRange)) &&
    expected.parentBlockIds.length === actual.parentBlockIds.length &&
    expected.parentBlockIds.every(
      (parent, index) => parent === actual.parentBlockIds[index],
    ) &&
    expected.partialContext === actual.partialContext
  );
}

function windowBindingEquivalent(
  expected: EvidenceSpanCatalogWindowBinding,
  actual: EvidenceSpanCatalogWindowBinding,
): boolean {
  return (
    expected.windowId === actual.windowId &&
    expected.documentRef === actual.documentRef &&
    expected.text === actual.text &&
    expected.sourceView.ref === actual.sourceView.ref &&
    expected.sourceView.documentRef === actual.sourceView.documentRef &&
    rangesEqual(
      expected.sourceView.documentRange,
      actual.sourceView.documentRange,
    ) &&
    expected.sourceView.text === actual.sourceView.text &&
    expected.sourceView.digest === actual.sourceView.digest &&
    expected.ownedRanges.length === actual.ownedRanges.length &&
    expected.ownedRanges.every((range, index) => {
      const actualRange = actual.ownedRanges[index];
      return actualRange !== undefined && rangesEqual(range, actualRange);
    }) &&
    expected.contextRanges.length === actual.contextRanges.length &&
    expected.contextRanges.every((range, index) => {
      const actualRange = actual.contextRanges[index];
      return actualRange !== undefined && rangesEqual(range, actualRange);
    }) &&
    expected.visibleSourceRefs.length === actual.visibleSourceRefs.length &&
    expected.visibleSourceRefs.every(
      (sourceRef, index) => sourceRef === actual.visibleSourceRefs[index],
    ) &&
    expected.segments.length === actual.segments.length &&
    expected.segments.every((segment, index) => {
      const actualSegment = actual.segments[index];
      return (
        actualSegment !== undefined && segmentEquivalent(segment, actualSegment)
      );
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function rangeIsValid(range: unknown, text: string): range is CanonicalRange {
  return (
    isRecord(range) &&
    isSafeNonNegativeInteger(range.start) &&
    isSafeNonNegativeInteger(range.end) &&
    range.end > range.start &&
    range.end <= text.length &&
    isUtf16Boundary(text, range.start) &&
    isUtf16Boundary(text, range.end)
  );
}

function blockRangeIsValid(range: unknown, text: string): boolean {
  return (
    isRecord(range) &&
    isSafeNonNegativeInteger(range.from) &&
    isSafeNonNegativeInteger(range.to) &&
    range.to >= range.from &&
    range.to <= text.length &&
    isUtf16Boundary(text, range.from) &&
    isUtf16Boundary(text, range.to)
  );
}

function copyRange(range: CanonicalRange): CanonicalRange {
  return { start: range.start, end: range.end };
}

function containsRange(outer: CanonicalRange, inner: CanonicalRange): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function rangesEqual(left: CanonicalRange, right: CanonicalRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRanges(left: CanonicalRange, right: CanonicalRange): number {
  return left.start - right.start || left.end - right.end;
}

function copyProjectionSegment(segment: ProjectionSegment): ProjectionSegment {
  if (segment.kind === "synthetic-boundary") {
    return {
      kind: segment.kind,
      canonicalStart: segment.canonicalStart,
      canonicalEnd: segment.canonicalEnd,
      canonical: { ...segment.canonical },
      boundary: { ...segment.boundary },
      reason: segment.reason,
    };
  }
  return {
    kind: segment.kind,
    canonicalStart: segment.canonicalStart,
    canonicalEnd: segment.canonicalEnd,
    from: segment.from,
    to: segment.to,
    canonical: { ...segment.canonical },
    source: { ...segment.source },
    ...(segment.transform ? { transform: segment.transform } : {}),
    ...(segment.nodeType ? { nodeType: segment.nodeType } : {}),
  };
}

function copyCanonical(canonical: CanonicalText): CanonicalText {
  const projection = {
    schemaVersion: canonical.projection.schemaVersion,
    unit: canonical.projection.unit,
    canonicalLength: canonical.projection.canonicalLength,
    segments: canonical.projection.segments.map(copyProjectionSegment),
  };
  return {
    unit: canonical.unit,
    text: canonical.text,
    blocks: canonical.blocks.map((block) => ({
      id: block.id,
      nodeType: block.nodeType,
      range: { ...block.range },
      depth: block.depth,
      ...(block.attrs ? { attrs: { ...block.attrs } } : {}),
    })),
    projection,
    projectionMap: projection,
    diagnostics: canonical.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
      ...(diagnostic.nodeType ? { nodeType: diagnostic.nodeType } : {}),
    })),
  };
}

function copySnapshot(
  snapshot: NarrativeCorpusSnapshot,
): NarrativeCorpusSnapshot {
  return {
    schemaVersion: snapshot.schemaVersion,
    id: snapshot.id,
    snapshotId: snapshot.snapshotId,
    createdAt: snapshot.createdAt,
    language: snapshot.language,
    normalizerVersion: snapshot.normalizerVersion,
    origin: { ...snapshot.origin },
    documents: snapshot.documents.map((document) => ({
      ref: document.ref,
      sourceKey: document.sourceKey,
      parentRef: document.parentRef,
      title: document.title,
      orderIndex: document.orderIndex,
      canonical: copyCanonical(document.canonical),
      contentDigest: document.contentDigest,
      documentDigest: document.documentDigest,
      artifactDigest: document.artifactDigest,
      origin: { ...document.origin },
    })),
    omissions: snapshot.omissions.map((omission) => ({ ...omission })),
    digest: snapshot.digest,
    artifactDigest: snapshot.artifactDigest,
  };
}

function copySourceView(sourceView: NarrativeSourceView): NarrativeSourceView {
  return {
    ref: sourceView.ref,
    documentRef: sourceView.documentRef,
    documentRange: { ...sourceView.documentRange },
    text: sourceView.text,
    digest: sourceView.digest,
  };
}

function copyCatalog(catalog: EvidenceSpanCatalog): EvidenceSpanCatalog {
  return {
    kind: catalog.kind,
    version: catalog.version,
    segmentationVersion: catalog.segmentationVersion,
    snapshotId: catalog.snapshotId,
    snapshotDigest: catalog.snapshotDigest,
    snapshotArtifactDigest: catalog.snapshotArtifactDigest,
    digest: catalog.digest,
    entries: catalog.entries.map((entry) => ({
      canonicalId: entry.canonicalId,
      sourceRef: entry.sourceRef,
      documentRef: entry.documentRef,
      canonicalRange: { ...entry.canonicalRange },
      range: { ...entry.range },
      quote: entry.quote,
      text: entry.text,
      parentBlockIds: [...entry.parentBlockIds],
      sourceView: copySourceView(entry.sourceView),
      identity: {
        snapshotDigest: entry.identity.snapshotDigest,
        snapshotArtifactDigest: entry.identity.snapshotArtifactDigest,
        documentRef: entry.identity.documentRef,
        documentArtifactDigest: entry.identity.documentArtifactDigest,
        range: { ...entry.identity.range },
        start: entry.identity.start,
        end: entry.identity.end,
        segmentationVersion: entry.identity.segmentationVersion,
      },
    })),
  };
}

function copyWindowInput(
  input: EvidenceSpanCatalogWindowInput,
): StableWindowInput {
  return {
    windowId: input.windowId,
    documentRef: input.documentRef,
    sourceView: copySourceView(input.sourceView),
    ownedRanges: input.ownedRanges.map(copyRange),
    contextRanges: (input.contextRanges ?? []).map(copyRange),
  };
}

function copyAlias(alias: EvidenceSpanCatalogAlias): EvidenceSpanCatalogAlias {
  return {
    alias: alias.alias,
    canonicalSourceRef: alias.canonicalSourceRef,
    canonicalId: alias.canonicalId,
    windowIds: [...alias.windowIds],
  };
}

function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") return true;
  const objectValue = value as object;
  if (seen.has(objectValue)) return true;
  if (!Object.isFrozen(objectValue)) return false;
  seen.add(objectValue);
  return Object.values(objectValue).every((child) => deeplyFrozen(child, seen));
}

function invalidSnapshotDiagnostics(
  snapshot: NarrativeCorpusSnapshot,
): string[] {
  const diagnostics: string[] = [];
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.id !== snapshot.snapshotId ||
    snapshot.normalizerVersion !== "gdx-canonical-text/1" ||
    typeof snapshot.snapshotId !== "string" ||
    snapshot.snapshotId.length === 0 ||
    typeof snapshot.language !== "string" ||
    typeof snapshot.createdAt !== "string" ||
    snapshot.origin.kind !== "grimodex-project" ||
    typeof snapshot.origin.projectId !== "string" ||
    snapshot.origin.projectId.length === 0 ||
    !Array.isArray(snapshot.documents) ||
    !Array.isArray(snapshot.omissions)
  ) {
    diagnostics.push("snapshot envelope is invalid");
    return diagnostics;
  }
  const refs = new Set<string>();
  for (const document of snapshot.documents) {
    if (refs.has(document.ref))
      diagnostics.push(`duplicate document ref ${document.ref}`);
    refs.add(document.ref);
    if (
      typeof document.ref !== "string" ||
      typeof document.sourceKey !== "string" ||
      typeof document.title !== "string" ||
      !isSafeNonNegativeInteger(document.orderIndex) ||
      document.origin.projectId !== snapshot.origin.projectId ||
      document.canonical.unit !== "utf16" ||
      typeof document.canonical.text !== "string" ||
      hasLoneSurrogate(document.canonical.text)
    ) {
      diagnostics.push(`invalid document ${document.ref}`);
    }
    for (const block of document.canonical.blocks) {
      if (!blockRangeIsValid(block.range, document.canonical.text)) {
        diagnostics.push(`invalid block range ${block.id}`);
      }
    }
  }
  return diagnostics;
}

async function verifySnapshotIntegrity(
  snapshot: NarrativeCorpusSnapshot,
): Promise<string[]> {
  const diagnostics = invalidSnapshotDiagnostics(snapshot);
  if (diagnostics.length > 0) return diagnostics;

  const documentDigests: Sha256Digest[] = [];
  const artifactRows: Array<{
    sourceKey: string;
    artifactDigest: Sha256Digest;
  }> = [];
  for (const document of snapshot.documents) {
    const contentDigest = await digestStableJson({
      normalizerVersion: "gdx-canonical-text/1",
      text: document.canonical.text,
    });
    const documentDigest = await digestStableJson({
      normalizerVersion: "gdx-canonical-text/1",
      parentSourceKey:
        snapshot.documents.find(
          (candidate) => candidate.ref === document.parentRef,
        )?.sourceKey ?? null,
      title: document.title,
      orderIndex: document.orderIndex,
      canonical: {
        text: document.canonical.text,
        blocks: document.canonical.blocks,
      },
    });
    const parentSourceKey =
      snapshot.documents.find(
        (candidate) => candidate.ref === document.parentRef,
      )?.sourceKey ?? null;
    const artifactDigest = await digestStableJson({
      schemaVersion: 1,
      normalizerVersion: "gdx-canonical-text/1",
      sourceKey: document.sourceKey,
      parentSourceKey,
      semanticDigest: documentDigest,
      contentDigest,
      projection: document.canonical.projection,
      origin: document.origin,
    });
    if (document.contentDigest !== contentDigest) {
      diagnostics.push(`content digest mismatch for ${document.ref}`);
    }
    if (document.documentDigest !== documentDigest) {
      diagnostics.push(`document digest mismatch for ${document.ref}`);
    }
    if (document.artifactDigest !== artifactDigest) {
      diagnostics.push(`artifact digest mismatch for ${document.ref}`);
    }
    documentDigests.push(document.documentDigest);
    artifactRows.push({
      sourceKey: document.sourceKey,
      artifactDigest: document.artifactDigest,
    });
  }
  const semanticDigest = await digestStableJson({
    schemaVersion: 1,
    language: snapshot.language,
    normalizerVersion: "gdx-canonical-text/1",
    documentDigests,
    omissions: snapshot.omissions,
  });
  if (snapshot.digest !== semanticDigest) {
    diagnostics.push("snapshot digest mismatch");
  }
  const artifactDigest = await digestStableJson({
    schemaVersion: 1,
    normalizerVersion: "gdx-canonical-text/1",
    semanticDigest,
    originProjectId: snapshot.origin.projectId,
    documents: artifactRows,
    omissions: snapshot.omissions,
  });
  if (snapshot.artifactDigest !== artifactDigest) {
    diagnostics.push("snapshot artifact digest mismatch");
  }
  return diagnostics;
}

function isOpeningBracket(value: string): string | null {
  return OPENING_BRACKETS[value] ?? null;
}

function isClosingBracket(value: string): boolean {
  return CLOSING_BRACKETS.has(value);
}

function isSentenceTerminal(value: string): boolean {
  return SENTENCE_TERMINALS.has(value);
}

interface GraphemeSlice {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function graphemesInRange(
  text: string,
  range: CanonicalRange,
): GraphemeSlice[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(text.slice(range.start, range.end))].map(
    (segment) => ({
      start: range.start + segment.index,
      end: range.start + segment.index + segment.segment.length,
      value: segment.segment,
    }),
  );
}

function sentenceLikeRanges(
  text: string,
  range: CanonicalRange,
): CanonicalRange[] {
  const slices = graphemesInRange(text, range);
  if (slices.length === 0) return [];
  const ranges: CanonicalRange[] = [];
  let start = range.start;
  let stack: string[] = [];
  let terminalInsideBracket = false;
  for (const slice of slices) {
    const opening = isOpeningBracket(slice.value);
    if (opening) {
      stack = [...stack, opening];
      terminalInsideBracket = false;
      continue;
    }
    if (isClosingBracket(slice.value)) {
      if (stack.at(-1) === slice.value) stack = stack.slice(0, -1);
      if (stack.length === 0 && terminalInsideBracket) {
        ranges.push({ start, end: slice.end });
        start = slice.end;
        terminalInsideBracket = false;
      }
      continue;
    }
    if (isSentenceTerminal(slice.value)) {
      if (slice.value === "\n" || stack.length === 0) {
        ranges.push({ start, end: slice.end });
        start = slice.end;
        terminalInsideBracket = false;
      } else {
        terminalInsideBracket = true;
      }
      continue;
    }
    if (!/^\s$/u.test(slice.value)) terminalInsideBracket = false;
  }
  if (start < range.end) ranges.push({ start, end: range.end });
  return ranges;
}

function splitLongRange(
  text: string,
  range: CanonicalRange,
  maxLength: number,
): CanonicalRange[] {
  if (range.end - range.start <= maxLength) return [range];
  const output: CanonicalRange[] = [];
  let cursor = range.start;
  while (cursor < range.end) {
    if (range.end - cursor <= maxLength) {
      output.push({ start: cursor, end: range.end });
      break;
    }
    const limit = cursor + maxLength;
    const slices = graphemesInRange(text, { start: cursor, end: range.end });
    for (const slice of slices) {
      if (slice.end - slice.start > maxLength) {
        throw new EvidenceSpanCatalogError(
          "EVIDENCE_SPAN_GRAPHEME_TOO_LARGE",
          `Evidence span grapheme exceeds the ${maxLength}-UTF-16-unit quote limit`,
        );
      }
    }
    let stack: string[] = [];
    let lastSafeBoundary: number | null = null;
    let lastBoundary: number | null = null;
    for (const slice of slices) {
      const opening = isOpeningBracket(slice.value);
      if (opening) stack = [...stack, opening];
      else if (isClosingBracket(slice.value) && stack.at(-1) === slice.value) {
        stack = stack.slice(0, -1);
      }
      if (slice.end <= limit) {
        lastBoundary = slice.end;
        if (stack.length === 0) lastSafeBoundary = slice.end;
      }
      if (slice.start >= limit) break;
    }
    const cut = lastSafeBoundary ?? lastBoundary ?? limit;
    const safeCut = cut > cursor && isUtf16Boundary(text, cut) ? cut : limit;
    output.push({ start: cursor, end: safeCut });
    cursor = safeCut;
  }
  return output;
}

function blockContainsRange(
  block: CanonicalBlockSpan,
  range: CanonicalRange,
): boolean {
  return block.range.from <= range.start && range.end <= block.range.to;
}

function leafBlocks(document: NarrativeCorpusDocument): CanonicalBlockSpan[] {
  const blocks = document.canonical.blocks.filter(
    (block) => block.range.to > block.range.from,
  );
  const maxDepthByRange = new Map<string, number>();
  for (const block of blocks) {
    const key = `${block.range.from}:${block.range.to}`;
    maxDepthByRange.set(
      key,
      Math.max(maxDepthByRange.get(key) ?? -1, block.depth),
    );
  }
  return blocks
    .filter((block) => {
      const key = `${block.range.from}:${block.range.to}`;
      if (block.depth !== maxDepthByRange.get(key)) return false;
      return !blocks.some(
        (other) =>
          other !== block &&
          other.range.from >= block.range.from &&
          other.range.to <= block.range.to &&
          (other.range.from > block.range.from ||
            other.range.to < block.range.to),
      );
    })
    .sort(
      (left, right) =>
        left.range.from - right.range.from ||
        left.range.to - right.range.to ||
        left.depth - right.depth ||
        compareStrings(left.id, right.id),
    );
}

function parentsForBlock(
  blocks: readonly CanonicalBlockSpan[],
  leaf: CanonicalBlockSpan,
  range: CanonicalRange,
): string[] {
  return blocks
    .filter((block) => block.id !== leaf.id && blockContainsRange(block, range))
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        left.range.from - right.range.from ||
        compareStrings(left.id, right.id),
    )
    .map((block) => block.id);
}

function buildSpanSeeds(snapshot: NarrativeCorpusSnapshot): SpanSeed[] {
  const seeds: SpanSeed[] = [];
  for (const document of snapshot.documents) {
    const blocks = document.canonical.blocks;
    const leaves = leafBlocks(document);
    const seenRanges = new Set<string>();
    let documentSeedCount = 0;
    for (const leaf of leaves) {
      const sourceRange = {
        start: Math.max(0, leaf.range.from),
        end: Math.min(document.canonical.text.length, leaf.range.to),
      };
      if (sourceRange.end <= sourceRange.start) continue;
      for (const sentenceRange of sentenceLikeRanges(
        document.canonical.text,
        sourceRange,
      )) {
        for (const splitRange of splitLongRange(
          document.canonical.text,
          sentenceRange,
          EVIDENCE_SPAN_MAX_QUOTE_LENGTH,
        )) {
          if (splitRange.end <= splitRange.start) continue;
          const key = `${splitRange.start}:${splitRange.end}`;
          if (seenRanges.has(key)) continue;
          seenRanges.add(key);
          documentSeedCount += 1;
          seeds.push({
            document,
            canonicalRange: splitRange,
            quote: document.canonical.text.slice(
              splitRange.start,
              splitRange.end,
            ),
            parentBlockIds: parentsForBlock(blocks, leaf, splitRange),
          });
        }
      }
    }
    if (documentSeedCount === 0) {
      const fallbackRange = {
        start: 0,
        end: document.canonical.text.length,
      };
      if (fallbackRange.end > fallbackRange.start) {
        for (const splitRange of splitLongRange(
          document.canonical.text,
          fallbackRange,
          EVIDENCE_SPAN_MAX_QUOTE_LENGTH,
        )) {
          seeds.push({
            document,
            canonicalRange: splitRange,
            quote: document.canonical.text.slice(
              splitRange.start,
              splitRange.end,
            ),
            parentBlockIds: [],
          });
        }
      }
    }
  }
  return seeds.sort(
    (left, right) =>
      left.document.orderIndex - right.document.orderIndex ||
      compareStrings(left.document.ref, right.document.ref) ||
      compareRanges(left.canonicalRange, right.canonicalRange),
  );
}

function catalogDigestInput(catalog: {
  readonly kind: string;
  readonly version: number;
  readonly segmentationVersion: string;
  readonly snapshotId: string;
  readonly snapshotDigest: Sha256Digest;
  readonly snapshotArtifactDigest: Sha256Digest;
  readonly entries: readonly EvidenceSpanCatalogEntry[];
}): unknown {
  return {
    kind: catalog.kind,
    version: catalog.version,
    segmentationVersion: catalog.segmentationVersion,
    snapshotId: catalog.snapshotId,
    snapshotDigest: catalog.snapshotDigest,
    snapshotArtifactDigest: catalog.snapshotArtifactDigest,
    entries: catalog.entries.map((entry) => ({
      canonicalId: entry.canonicalId,
      sourceRef: entry.sourceRef,
      documentRef: entry.documentRef,
      canonicalRange: entry.canonicalRange,
      range: entry.range,
      quote: entry.quote,
      text: entry.text,
      parentBlockIds: entry.parentBlockIds,
      identity: entry.identity,
      sourceView: {
        ref: entry.sourceView.ref,
        documentRef: entry.sourceView.documentRef,
        documentRange: entry.sourceView.documentRange,
        text: entry.sourceView.text,
        digest: entry.sourceView.digest,
      },
    })),
  };
}

async function canonicalOccurrenceId(
  snapshot: NarrativeCorpusSnapshot,
  seed: SpanSeed,
): Promise<{
  readonly canonicalId: string;
  readonly identity: EvidenceSpanCanonicalIdentity;
}> {
  const identity: EvidenceSpanCanonicalIdentity = {
    snapshotDigest: snapshot.digest,
    snapshotArtifactDigest: snapshot.artifactDigest,
    documentRef: seed.document.ref,
    documentArtifactDigest: seed.document.artifactDigest,
    range: copyRange(seed.canonicalRange),
    start: seed.canonicalRange.start,
    end: seed.canonicalRange.end,
    segmentationVersion: EVIDENCE_SPAN_SEGMENTATION_VERSION,
  };
  const digest = await digestStableJson({
    kind: "narrative-evidence-span",
    ...identity,
  });
  return { canonicalId: `occ:${digest.slice("sha256:".length)}`, identity };
}

async function buildExpectedEntries(
  snapshot: NarrativeCorpusSnapshot,
): Promise<readonly EvidenceSpanCatalogEntry[]> {
  const seeds = buildSpanSeeds(snapshot);
  const entries = await Promise.all(
    seeds.map(async (seed, index) => {
      const sourceRef = `E${String(index + 1).padStart(6, "0")}`;
      const { canonicalId, identity } = await canonicalOccurrenceId(
        snapshot,
        seed,
      );
      const sourceView = await buildNarrativeSourceView({
        ref: sourceRef,
        document: seed.document,
        documentRange: seed.canonicalRange,
      });
      return freezeDeep({
        canonicalId,
        sourceRef,
        documentRef: seed.document.ref,
        canonicalRange: copyRange(seed.canonicalRange),
        range: copyRange(seed.canonicalRange),
        quote: seed.quote,
        text: seed.quote,
        parentBlockIds: [...seed.parentBlockIds],
        sourceView,
        identity,
      });
    }),
  );
  return entries;
}

function validationFailure(
  reason: EvidenceSpanCatalogValidationReason,
  diagnostics: readonly string[],
): EvidenceSpanCatalogValidation {
  return {
    ok: false,
    valid: false,
    reason,
    diagnostics: [...diagnostics],
  };
}

function snapshotFields(
  snapshot: NarrativeCorpusSnapshot,
): StableSnapshotFields {
  return {
    snapshot,
    documentsByRef: new Map(
      snapshot.documents.map((document) => [document.ref, document] as const),
    ),
  };
}

function makeVerifiedCatalogHandle(
  snapshot: NarrativeCorpusSnapshot,
  catalog: EvidenceSpanCatalog,
): VerifiedCatalogHandle {
  const sourceViews = freezeDeep(
    catalog.entries.map((entry) => entry.sourceView),
  );
  return freezeDeep({
    snapshot,
    catalog,
    snapshotFields: snapshotFields(snapshot),
    entriesBySourceRef: new Map(
      catalog.entries.map((entry) => [entry.sourceRef, entry] as const),
    ),
    sourceViews,
  });
}

function getVerifiedCatalogHandle(
  snapshot: NarrativeCorpusSnapshot,
  catalog: EvidenceSpanCatalog,
): VerifiedCatalogHandle | undefined {
  return verifiedCatalogPairs.get(snapshot as object)?.get(catalog as object);
}

function rememberVerifiedCatalogHandle(
  snapshot: NarrativeCorpusSnapshot,
  catalog: EvidenceSpanCatalog,
  handle: VerifiedCatalogHandle,
): void {
  let catalogs = verifiedCatalogPairs.get(snapshot as object);
  if (!catalogs) {
    catalogs = new WeakMap<object, VerifiedCatalogHandle>();
    verifiedCatalogPairs.set(snapshot as object, catalogs);
  }
  catalogs.set(catalog as object, handle);
}

function catalogMetadataDiagnostics(
  snapshot: NarrativeCorpusSnapshot,
  catalog: EvidenceSpanCatalog,
): EvidenceSpanCatalogValidation | null {
  if (catalog.kind !== EVIDENCE_SPAN_CATALOG_KIND) {
    return validationFailure("catalog-kind-mismatch", [
      "catalog kind mismatch",
    ]);
  }
  if (catalog.version !== EVIDENCE_SPAN_CATALOG_VERSION) {
    return validationFailure("catalog-version-mismatch", [
      "catalog version mismatch",
    ]);
  }
  if (catalog.segmentationVersion !== EVIDENCE_SPAN_SEGMENTATION_VERSION) {
    return validationFailure("segmentation-version-mismatch", [
      "unsupported segmentation version",
    ]);
  }
  if (
    catalog.snapshotId !== snapshot.snapshotId ||
    catalog.snapshotDigest !== snapshot.digest ||
    catalog.snapshotArtifactDigest !== snapshot.artifactDigest
  ) {
    return validationFailure("snapshot-identity-mismatch", [
      "catalog snapshot identity mismatch",
    ]);
  }
  return null;
}

function entriesEqual(
  expected: EvidenceSpanCatalogEntry,
  actual: EvidenceSpanCatalogEntry,
): boolean {
  return (
    actual.canonicalId === expected.canonicalId &&
    actual.sourceRef === expected.sourceRef &&
    actual.documentRef === expected.documentRef &&
    rangesEqual(actual.canonicalRange, expected.canonicalRange) &&
    rangesEqual(actual.range, expected.range) &&
    actual.quote === expected.quote &&
    actual.text === expected.text &&
    actual.parentBlockIds.length === expected.parentBlockIds.length &&
    actual.parentBlockIds.every(
      (parent, index) => parent === expected.parentBlockIds[index],
    ) &&
    actual.identity.snapshotDigest === expected.identity.snapshotDigest &&
    actual.identity.snapshotArtifactDigest ===
      expected.identity.snapshotArtifactDigest &&
    actual.identity.documentRef === expected.identity.documentRef &&
    actual.identity.documentArtifactDigest ===
      expected.identity.documentArtifactDigest &&
    actual.identity.start === expected.identity.start &&
    actual.identity.end === expected.identity.end &&
    rangesEqual(actual.identity.range, expected.identity.range) &&
    actual.identity.segmentationVersion ===
      expected.identity.segmentationVersion &&
    actual.sourceView.ref === expected.sourceView.ref &&
    actual.sourceView.documentRef === expected.sourceView.documentRef &&
    rangesEqual(
      actual.sourceView.documentRange,
      expected.sourceView.documentRange,
    ) &&
    actual.sourceView.text === expected.sourceView.text &&
    actual.sourceView.digest === expected.sourceView.digest
  );
}

/**
 * Build the deterministic occurrence catalog once from a sealed snapshot.
 * The returned catalog and all owned Source Views are deeply frozen.
 */
export async function buildEvidenceSpanCatalog(
  snapshot: NarrativeCorpusSnapshot,
  options: BuildEvidenceSpanCatalogOptions = {},
): Promise<EvidenceSpanCatalog> {
  if (
    options.segmentationVersion !== undefined &&
    options.segmentationVersion !== EVIDENCE_SPAN_SEGMENTATION_VERSION
  ) {
    throw new EvidenceSpanCatalogError(
      "EVIDENCE_SPAN_SEGMENTATION_VERSION_UNSUPPORTED",
      "Unsupported evidence span segmentation version",
    );
  }
  if (!deeplyFrozen(snapshot)) {
    throw new EvidenceSpanCatalogError(
      "EVIDENCE_SPAN_SNAPSHOT_NOT_SEALED",
      "Evidence span catalog requires a deeply frozen sealed snapshot",
    );
  }
  let stableSnapshot: NarrativeCorpusSnapshot;
  try {
    stableSnapshot = freezeDeep(copySnapshot(snapshot));
  } catch {
    throw new EvidenceSpanCatalogError(
      "EVIDENCE_SPAN_SNAPSHOT_INVALID",
      "Evidence span catalog snapshot cannot be copied",
    );
  }
  const snapshotDiagnostics = await verifySnapshotIntegrity(stableSnapshot);
  if (snapshotDiagnostics.length > 0) {
    throw new EvidenceSpanCatalogError(
      "EVIDENCE_SPAN_SNAPSHOT_INVALID",
      snapshotDiagnostics.join("; "),
    );
  }
  const entries = await buildExpectedEntries(stableSnapshot);
  const draft = {
    kind: EVIDENCE_SPAN_CATALOG_KIND,
    version: EVIDENCE_SPAN_CATALOG_VERSION,
    segmentationVersion: EVIDENCE_SPAN_SEGMENTATION_VERSION,
    snapshotId: stableSnapshot.snapshotId,
    snapshotDigest: stableSnapshot.digest,
    snapshotArtifactDigest: stableSnapshot.artifactDigest,
    entries,
  } as const;
  const digest = await digestStableJson(catalogDigestInput(draft));
  const catalog = freezeDeep({ ...draft, digest });
  const handle = makeVerifiedCatalogHandle(stableSnapshot, catalog);
  // Keep the original sealed snapshot paired with the module-owned catalog,
  // while also allowing a later in-memory binding to reuse the captured copy.
  rememberVerifiedCatalogHandle(snapshot, catalog, handle);
  rememberVerifiedCatalogHandle(stableSnapshot, catalog, handle);
  return catalog;
}

/** Reverify a persisted catalog against the current snapshot and code splitter. */
export async function validateEvidenceSpanCatalog(
  snapshot: NarrativeCorpusSnapshot,
  catalog: EvidenceSpanCatalog,
): Promise<EvidenceSpanCatalogValidation> {
  if (getVerifiedCatalogHandle(snapshot, catalog)) {
    return { ok: true, valid: true, diagnostics: [] };
  }
  let stableSnapshot: NarrativeCorpusSnapshot;
  let stableCatalog: EvidenceSpanCatalog;
  try {
    stableSnapshot = copySnapshot(snapshot);
    stableCatalog = copyCatalog(catalog);
  } catch {
    return validationFailure("invalid-catalog", [
      "snapshot or catalog is not copyable",
    ]);
  }
  try {
    const snapshotDiagnostics = await verifySnapshotIntegrity(stableSnapshot);
    if (snapshotDiagnostics.length > 0) {
      return validationFailure("invalid-snapshot", snapshotDiagnostics);
    }
    const metadataFailure = catalogMetadataDiagnostics(
      stableSnapshot,
      stableCatalog,
    );
    if (metadataFailure) return metadataFailure;
    const expectedEntries = await buildExpectedEntries(stableSnapshot);
    if (stableCatalog.entries.length !== expectedEntries.length) {
      return validationFailure("entry-mismatch", [
        `expected ${expectedEntries.length} entries, got ${stableCatalog.entries.length}`,
      ]);
    }
    const sourceRefs = new Set<string>();
    const canonicalIds = new Set<string>();
    for (let index = 0; index < expectedEntries.length; index += 1) {
      const expected = expectedEntries[index];
      const actual = stableCatalog.entries[index];
      if (!expected || !actual) {
        return validationFailure("entry-mismatch", [
          "catalog entry is missing",
        ]);
      }
      if (sourceRefs.has(actual.sourceRef)) {
        return validationFailure("entry-mismatch", [
          `duplicate sourceRef ${actual.sourceRef}`,
        ]);
      }
      sourceRefs.add(actual.sourceRef);
      if (canonicalIds.has(actual.canonicalId)) {
        return validationFailure("entry-mismatch", [
          `duplicate canonicalId ${actual.canonicalId}`,
        ]);
      }
      canonicalIds.add(actual.canonicalId);
      if (!entriesEqual(expected, actual)) {
        return validationFailure("entry-mismatch", [
          `catalog entry ${index + 1} does not match code-owned occurrence`,
        ]);
      }
    }
    const expectedDigest = await digestStableJson(
      catalogDigestInput({ ...stableCatalog, entries: expectedEntries }),
    );
    if (stableCatalog.digest !== expectedDigest) {
      return validationFailure("catalog-digest-mismatch", [
        "catalog digest mismatch",
      ]);
    }
    return { ok: true, valid: true, diagnostics: [] };
  } catch (error) {
    return validationFailure("invalid-catalog", [
      error instanceof Error ? error.message : "catalog validation failed",
    ]);
  }
}

function validateWindowInput(
  stable: StableSnapshotFields,
  window: StableWindowInput,
): string[] {
  const diagnostics: string[] = [];
  const document = stable.documentsByRef.get(window.documentRef);
  if (!document) {
    diagnostics.push(`unknown document ${window.documentRef}`);
    return diagnostics;
  }
  if (window.windowId.length === 0 || hasLoneSurrogate(window.windowId)) {
    diagnostics.push("windowId is empty or invalid");
  }
  const viewRange = window.sourceView.documentRange;
  if (
    window.sourceView.documentRef !== document.ref ||
    !rangeIsValid(viewRange, document.canonical.text) ||
    document.canonical.text.slice(viewRange.start, viewRange.end) !==
      window.sourceView.text
  ) {
    diagnostics.push(`sourceView mismatch for ${window.windowId}`);
  }
  for (const range of [...window.ownedRanges, ...window.contextRanges]) {
    if (!rangeIsValid(range, document.canonical.text)) {
      diagnostics.push(`invalid range in ${window.windowId}`);
    } else if (!containsRange(viewRange, range)) {
      diagnostics.push(`range outside sourceView in ${window.windowId}`);
    }
  }
  return diagnostics;
}

async function verifyWindowSourceView(
  stable: StableSnapshotFields,
  window: StableWindowInput,
): Promise<boolean> {
  const document = stable.documentsByRef.get(window.documentRef);
  if (!document) return false;
  const expectedDigest = await computeNarrativeSourceViewDigest(
    window.sourceView,
    document.artifactDigest,
  );
  return window.sourceView.digest === expectedDigest;
}

function aliasPayload(
  requestIdentity: string,
  catalog: EvidenceSpanCatalog,
  windows: readonly StableWindowInput[],
): unknown {
  return {
    requestIdentity,
    catalogDigest: catalog.digest,
    snapshotArtifactDigest: catalog.snapshotArtifactDigest,
    windows: windows
      .map((window) => ({
        windowId: window.windowId,
        documentRef: window.documentRef,
        sourceViewRef: window.sourceView.ref,
        documentRange: window.sourceView.documentRange,
      }))
      .sort(
        (left, right) =>
          compareStrings(left.windowId, right.windowId) ||
          compareStrings(left.sourceViewRef, right.sourceViewRef),
      ),
  };
}

async function makeBindingToken(
  requestIdentity: string,
  catalog: EvidenceSpanCatalog,
  windows: readonly StableWindowInput[],
): Promise<string> {
  const digest = await digestStableJson(
    aliasPayload(requestIdentity, catalog, windows),
  );
  return digest.slice("sha256:".length, "sha256:".length + 12);
}

function visibleEntries(
  catalog: EvidenceSpanCatalog,
  window: StableWindowInput,
): readonly EvidenceSpanCatalogEntry[] {
  return catalog.entries
    .filter(
      (entry) =>
        entry.documentRef === window.documentRef &&
        containsRange(window.sourceView.documentRange, entry.canonicalRange),
    )
    .sort((left, right) =>
      compareRanges(left.canonicalRange, right.canonicalRange),
    );
}

function partialEntries(
  catalog: EvidenceSpanCatalog,
  window: StableWindowInput,
): readonly EvidenceSpanCatalogEntry[] {
  return catalog.entries.filter((entry) => {
    if (entry.documentRef !== window.documentRef) return false;
    const startsBeforeEnd =
      entry.canonicalRange.start < window.sourceView.documentRange.end;
    const endsAfterStart =
      entry.canonicalRange.end > window.sourceView.documentRange.start;
    return (
      startsBeforeEnd &&
      endsAfterStart &&
      !containsRange(window.sourceView.documentRange, entry.canonicalRange)
    );
  });
}

function buildAliasManifest(
  catalog: EvidenceSpanCatalog,
  windows: readonly StableWindowInput[],
  bindingToken: string,
): AliasManifest {
  const windowsBySourceRef = new Map<string, string[]>();
  for (const window of windows) {
    for (const entry of visibleEntries(catalog, window)) {
      const ids = windowsBySourceRef.get(entry.sourceRef) ?? [];
      if (!ids.includes(window.windowId)) ids.push(window.windowId);
      windowsBySourceRef.set(entry.sourceRef, ids);
    }
  }
  let aliasIndex = 0;
  const aliases = catalog.entries.flatMap((entry) => {
    const sourceWindowIds = windowsBySourceRef.get(entry.sourceRef);
    if (!sourceWindowIds) return [];
    aliasIndex += 1;
    const alias = `E${bindingToken}-${String(aliasIndex).padStart(3, "0")}`;
    return [
      {
        alias,
        canonicalSourceRef: entry.sourceRef,
        canonicalId: entry.canonicalId,
        windowIds: [...sourceWindowIds].sort(compareStrings),
      },
    ];
  });
  return {
    aliases,
    byAlias: new Map(aliases.map((alias) => [alias.alias, alias] as const)),
    bySourceRef: new Map(
      aliases.map((alias) => [alias.canonicalSourceRef, alias] as const),
    ),
  };
}

function buildWindowSegments(
  catalog: EvidenceSpanCatalog,
  window: StableWindowInput,
  manifest: AliasManifest,
): readonly EvidenceSpanCatalogWindowSegment[] {
  const entries = visibleEntries(catalog, window);
  const partial = partialEntries(catalog, window);
  const documentEntry = catalog.entries.find(
    (entry) => entry.documentRef === window.documentRef,
  );
  if (!documentEntry) return [];
  const boundaries = new Set<number>([
    window.sourceView.documentRange.start,
    window.sourceView.documentRange.end,
  ]);
  for (const entry of [...entries, ...partial]) {
    boundaries.add(
      Math.max(
        entry.canonicalRange.start,
        window.sourceView.documentRange.start,
      ),
    );
    boundaries.add(
      Math.min(entry.canonicalRange.end, window.sourceView.documentRange.end),
    );
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const segments: EvidenceSpanCatalogWindowSegment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;
    const exact = entries.find(
      (entry) =>
        entry.canonicalRange.start === start &&
        entry.canonicalRange.end === end,
    );
    const partialContext = partial.some(
      (entry) =>
        entry.canonicalRange.start < end && entry.canonicalRange.end > start,
    );
    if (exact) {
      const alias = manifest.bySourceRef.get(exact.sourceRef);
      if (!alias) continue;
      segments.push({
        kind: "span",
        text: exact.quote,
        evidenceRef: alias.alias,
        canonicalSourceRef: exact.sourceRef,
        canonicalRange: copyRange(exact.canonicalRange),
        parentBlockIds: [...exact.parentBlockIds],
      });
      continue;
    }
    segments.push({
      kind: "context",
      text: window.sourceView.text.slice(
        start - window.sourceView.documentRange.start,
        end - window.sourceView.documentRange.start,
      ),
      ...(partialContext ? { partialContext: true } : {}),
      parentBlockIds: [],
    });
  }
  return segments;
}

function windowBindingFromInput(
  catalog: EvidenceSpanCatalog,
  window: StableWindowInput,
  manifest: AliasManifest,
): EvidenceSpanCatalogWindowBinding {
  const segments = buildWindowSegments(catalog, window, manifest);
  const joined = segments.map((segment) => segment.text).join("");
  if (joined !== window.sourceView.text) {
    throw new EvidenceSpanCatalogError(
      "EVIDENCE_SPAN_WINDOW_TEXT_MISMATCH",
      `Window ${window.windowId} text does not preserve the original Source View`,
    );
  }
  return freezeDeep({
    windowId: window.windowId,
    documentRef: window.documentRef,
    sourceView: freezeDeep(copySourceView(window.sourceView)),
    text: window.sourceView.text,
    ownedRanges: window.ownedRanges.map(copyRange),
    contextRanges: window.contextRanges.map(copyRange),
    segments,
    visibleSourceRefs: visibleEntries(catalog, window).map(
      (entry) => entry.sourceRef,
    ),
  });
}

/**
 * Assert that every catalog occurrence is fully visible in at least one of the
 * original windows. This is intentionally separate from per-request binding.
 */
export function assertEvidenceSpanCatalogCoverage(
  catalog: EvidenceSpanCatalog,
  windows: readonly EvidenceSpanCatalogWindowInput[],
): void {
  const missing = catalog.entries
    .filter(
      (entry) =>
        !windows.some(
          (window) =>
            window.documentRef === entry.documentRef &&
            containsRange(
              window.sourceView.documentRange,
              entry.canonicalRange,
            ),
        ),
    )
    .map((entry) => entry.sourceRef);
  if (missing.length > 0) throw new EvidenceSpanCatalogCoverageError(missing);
}

/** Bind a request-local alias map to an explicit subset of original windows. */
export async function bindEvidenceSpanCatalog(
  snapshot: NarrativeCorpusSnapshot,
  catalog: EvidenceSpanCatalog,
  input: {
    readonly requestIdentity: string;
    readonly windows: readonly EvidenceSpanCatalogWindowInput[];
  },
): Promise<EvidenceSpanCatalogBinding> {
  // Capture request identity before any digest/validation await. The caller
  // object is mutable and must never be read again after an async boundary.
  const requestIdentity = input.requestIdentity;
  const cachedCatalog = getVerifiedCatalogHandle(snapshot, catalog);
  let stableSnapshot: NarrativeCorpusSnapshot;
  let stableCatalog: EvidenceSpanCatalog;
  let stableWindows: readonly StableWindowInput[];
  let verifiedCatalog: VerifiedCatalogHandle;
  try {
    stableSnapshot =
      cachedCatalog?.snapshot ?? freezeDeep(copySnapshot(snapshot));
    stableCatalog = cachedCatalog?.catalog ?? freezeDeep(copyCatalog(catalog));
    stableWindows = input.windows.map(copyWindowInput);
  } catch {
    throw new EvidenceSpanCatalogError(
      "EVIDENCE_SPAN_BINDING_INVALID_INPUT",
      "Evidence span binding input is not copyable",
    );
  }
  if (
    typeof requestIdentity !== "string" ||
    requestIdentity.length === 0 ||
    hasLoneSurrogate(requestIdentity)
  ) {
    throw new EvidenceSpanCatalogError(
      "EVIDENCE_SPAN_BINDING_INVALID_REQUEST",
      "Evidence span binding requires a non-empty request identity",
    );
  }
  if (stableWindows.length === 0) {
    throw new EvidenceSpanCatalogError(
      "EVIDENCE_SPAN_BINDING_NO_WINDOWS",
      "Evidence span binding requires at least one reading window",
    );
  }
  let stable: StableSnapshotFields;
  if (cachedCatalog) {
    verifiedCatalog = cachedCatalog;
    stable = cachedCatalog.snapshotFields;
  } else {
    const validation = await validateEvidenceSpanCatalog(
      stableSnapshot,
      stableCatalog,
    );
    if (!validation.ok) {
      throw new EvidenceSpanCatalogError(
        "EVIDENCE_SPAN_BINDING_INVALID_CATALOG",
        validation.diagnostics.join("; "),
      );
    }
    const verified = makeVerifiedCatalogHandle(stableSnapshot, stableCatalog);
    rememberVerifiedCatalogHandle(stableSnapshot, stableCatalog, verified);
    verifiedCatalog = verified;
    stable = verified.snapshotFields;
  }
  const seenWindowIds = new Set<string>();
  for (const window of stableWindows) {
    if (seenWindowIds.has(window.windowId)) {
      throw new EvidenceSpanCatalogError(
        "EVIDENCE_SPAN_BINDING_DUPLICATE_WINDOW",
        `Duplicate window ID ${window.windowId}`,
      );
    }
    seenWindowIds.add(window.windowId);
    const diagnostics = validateWindowInput(stable, window);
    if (
      diagnostics.length > 0 ||
      !(await verifyWindowSourceView(stable, window))
    ) {
      throw new EvidenceSpanCatalogError(
        "EVIDENCE_SPAN_BINDING_INVALID_WINDOW",
        diagnostics.concat("window Source View digest mismatch").join("; "),
      );
    }
  }
  const bindingToken = await makeBindingToken(
    requestIdentity,
    stableCatalog,
    stableWindows,
  );
  const manifest = buildAliasManifest(
    stableCatalog,
    stableWindows,
    bindingToken,
  );
  const windows = stableWindows.map((window) =>
    windowBindingFromInput(stableCatalog, window, manifest),
  );
  const binding = {
    kind: EVIDENCE_SPAN_BINDING_KIND,
    version: EVIDENCE_SPAN_BINDING_VERSION,
    requestIdentity,
    bindingToken,
    snapshotId: stableSnapshot.snapshotId,
    snapshotDigest: stableSnapshot.digest,
    snapshotArtifactDigest: stableSnapshot.artifactDigest,
    catalogDigest: stableCatalog.digest,
    snapshot: stableSnapshot,
    catalog: stableCatalog,
    windows,
    sourceViews: windows.map((window) => window.sourceView),
    aliases: manifest.aliases,
  } as const;
  const frozenBinding = freezeDeep(binding);
  const selectionIndex = buildCatalogSelectionIndex(
    frozenBinding,
    verifiedCatalog,
  );
  checkedBindingHandles.set(frozenBinding as object, {
    binding: frozenBinding,
    manifest,
    selectionIndex,
  });
  return frozenBinding;
}

function copyBinding(binding: EvidenceSpanCatalogBinding): {
  readonly kind: typeof EVIDENCE_SPAN_BINDING_KIND;
  readonly version: typeof EVIDENCE_SPAN_BINDING_VERSION;
  readonly requestIdentity: string;
  readonly bindingToken: string;
  readonly snapshotId: string;
  readonly snapshotDigest: Sha256Digest;
  readonly snapshotArtifactDigest: Sha256Digest;
  readonly catalogDigest: Sha256Digest;
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly catalog: EvidenceSpanCatalog;
  readonly windows: readonly EvidenceSpanCatalogWindowBinding[];
  readonly sourceViews: readonly NarrativeSourceView[];
  readonly aliases: readonly EvidenceSpanCatalogAlias[];
} {
  return {
    kind: binding.kind,
    version: binding.version,
    requestIdentity: binding.requestIdentity,
    bindingToken: binding.bindingToken,
    snapshotId: binding.snapshotId,
    snapshotDigest: binding.snapshotDigest,
    snapshotArtifactDigest: binding.snapshotArtifactDigest,
    catalogDigest: binding.catalogDigest,
    snapshot: copySnapshot(binding.snapshot),
    catalog: copyCatalog(binding.catalog),
    windows: binding.windows.map((window) => ({
      windowId: window.windowId,
      documentRef: window.documentRef,
      sourceView: copySourceView(window.sourceView),
      text: window.text,
      ownedRanges: window.ownedRanges.map(copyRange),
      contextRanges: window.contextRanges.map(copyRange),
      segments: window.segments.map((segment) => ({
        kind: segment.kind,
        text: segment.text,
        ...(segment.evidenceRef ? { evidenceRef: segment.evidenceRef } : {}),
        ...(segment.canonicalSourceRef
          ? { canonicalSourceRef: segment.canonicalSourceRef }
          : {}),
        ...(segment.canonicalRange
          ? { canonicalRange: copyRange(segment.canonicalRange) }
          : {}),
        parentBlockIds: [...segment.parentBlockIds],
        ...(segment.partialContext ? { partialContext: true } : {}),
      })),
      visibleSourceRefs: [...window.visibleSourceRefs],
    })),
    sourceViews: binding.sourceViews.map(copySourceView),
    aliases: binding.aliases.map(copyAlias),
  };
}

async function validateBindingAndManifest(
  binding: EvidenceSpanCatalogBinding,
): Promise<CheckedBindingHandle> {
  const cached = checkedBindingHandles.get(binding as object);
  if (cached) return cached;
  let stable: ReturnType<typeof copyBinding>;
  try {
    stable = copyBinding(binding);
  } catch {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_BINDING_INVALID",
      "Evidence span binding is not copyable",
    );
  }
  if (
    stable.kind !== EVIDENCE_SPAN_BINDING_KIND ||
    stable.version !== EVIDENCE_SPAN_BINDING_VERSION ||
    typeof stable.requestIdentity !== "string" ||
    stable.requestIdentity.length === 0 ||
    hasLoneSurrogate(stable.requestIdentity)
  ) {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_BINDING_INVALID",
      "Evidence span binding envelope is invalid",
    );
  }
  const validation = await validateEvidenceSpanCatalog(
    stable.snapshot,
    stable.catalog,
  );
  if (!validation.ok) {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_BINDING_STALE",
      "Evidence span binding catalog is stale or foreign",
    );
  }
  if (
    stable.snapshotId !== stable.snapshot.snapshotId ||
    stable.snapshotDigest !== stable.snapshot.digest ||
    stable.snapshotArtifactDigest !== stable.snapshot.artifactDigest ||
    stable.catalogDigest !== stable.catalog.digest
  ) {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_BINDING_STALE",
      "Evidence span binding snapshot or catalog identity is stale",
    );
  }
  const windows: StableWindowInput[] = stable.windows.map((window) => ({
    windowId: window.windowId,
    documentRef: window.documentRef,
    sourceView: copySourceView(window.sourceView),
    ownedRanges: window.ownedRanges.map(copyRange),
    contextRanges: window.contextRanges.map(copyRange),
  }));
  if (stable.sourceViews.length !== stable.windows.length) {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_BINDING_STALE",
      "Evidence span binding Source View list is stale",
    );
  }
  if (
    stable.sourceViews.some((sourceView, index) => {
      const expected = stable.windows[index]?.sourceView;
      return (
        expected === undefined ||
        sourceView.ref !== expected.ref ||
        sourceView.documentRef !== expected.documentRef ||
        !rangesEqual(sourceView.documentRange, expected.documentRange) ||
        sourceView.text !== expected.text ||
        sourceView.digest !== expected.digest
      );
    })
  ) {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_BINDING_STALE",
      "Evidence span binding Source View list is forged",
    );
  }
  const snapshotStable = snapshotFields(stable.snapshot);
  const seenWindowIds = new Set<string>();
  for (const window of windows) {
    if (seenWindowIds.has(window.windowId)) {
      throw new EvidenceSpanReferenceError(
        "EVIDENCE_SPAN_BINDING_INVALID",
        "Evidence span binding contains duplicate windows",
      );
    }
    seenWindowIds.add(window.windowId);
    const diagnostics = validateWindowInput(snapshotStable, window);
    if (
      diagnostics.length > 0 ||
      !(await verifyWindowSourceView(snapshotStable, window))
    ) {
      throw new EvidenceSpanReferenceError(
        "EVIDENCE_SPAN_BINDING_STALE",
        "Evidence span binding contains a forged or stale Source View",
      );
    }
  }
  const token = await makeBindingToken(
    stable.requestIdentity,
    stable.catalog,
    windows,
  );
  if (token !== stable.bindingToken) {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_BINDING_STALE",
      "Evidence span binding request identity is stale or foreign",
    );
  }
  const manifest = buildAliasManifest(stable.catalog, windows, token);
  if (
    stable.windows.length !== windows.length ||
    stable.windows.some((actual, index) => {
      const inputWindow = windows[index];
      if (!inputWindow) return true;
      let expected: EvidenceSpanCatalogWindowBinding;
      try {
        expected = windowBindingFromInput(
          stable.catalog,
          inputWindow,
          manifest,
        );
      } catch {
        return true;
      }
      return !windowBindingEquivalent(expected, actual);
    })
  ) {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_BINDING_STALE",
      "Evidence span window segments or text are stale or forged",
    );
  }
  if (
    stable.aliases.length !== manifest.aliases.length ||
    stable.aliases.some((alias, index) => {
      const expected = manifest.aliases[index];
      return (
        !expected ||
        alias.alias !== expected.alias ||
        alias.canonicalSourceRef !== expected.canonicalSourceRef ||
        alias.canonicalId !== expected.canonicalId ||
        alias.windowIds.length !== expected.windowIds.length ||
        alias.windowIds.some(
          (windowId, windowIndex) =>
            windowId !== expected.windowIds[windowIndex],
        )
      );
    })
  ) {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_BINDING_STALE",
      "Evidence span alias map is stale or foreign",
    );
  }
  const verifiedCatalog = makeVerifiedCatalogHandle(
    stable.snapshot,
    stable.catalog,
  );
  return {
    binding: stable,
    manifest,
    selectionIndex: buildCatalogSelectionIndex(stable, verifiedCatalog),
  };
}

/**
 * Validate and capture a binding before provider dispatch. The returned copy
 * contains all persisted window segments and aliases, so a later resolver can
 * reuse this authority without trusting mutable caller objects.
 */
export async function validateEvidenceSpanCatalogBinding(
  binding: EvidenceSpanCatalogBinding,
): Promise<EvidenceSpanCatalogBinding> {
  const checked = await validateBindingAndManifest(binding);
  const captured = freezeDeep({
    ...checked.binding,
    sourceViews: checked.binding.sourceViews.map(copySourceView),
    aliases: checked.binding.aliases.map(copyAlias),
  });
  checkedBindingHandles.set(captured as object, {
    binding: captured,
    manifest: checked.manifest,
    selectionIndex: checked.selectionIndex,
  });
  return captured;
}

/** Explicit name for the pre-dispatch immutable capture operation. */
export async function captureEvidenceSpanCatalogBinding(
  binding: EvidenceSpanCatalogBinding,
): Promise<EvidenceSpanCatalogBinding> {
  return validateEvidenceSpanCatalogBinding(binding);
}

export type EvidenceSpanCatalogSelectionResolver = (
  refs: readonly string[],
) => Promise<ResolvedSelectedEvidenceRefs>;

function validateSelectedRefs(refs: readonly string[]): string[] {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new EvidenceSpanReferenceError(
      "EVIDENCE_SPAN_REFERENCE_EMPTY",
      "Evidence reference selection cannot be empty",
    );
  }
  const selected = [...refs];
  const seen = new Set<string>();
  for (const ref of selected) {
    if (typeof ref !== "string" || ref.length === 0 || hasLoneSurrogate(ref)) {
      throw new EvidenceSpanReferenceError(
        "EVIDENCE_SPAN_REFERENCE_INVALID",
        "Evidence reference must be a non-empty display ID",
        typeof ref === "string" ? ref : undefined,
      );
    }
    if (seen.has(ref)) {
      throw new EvidenceSpanReferenceError(
        "EVIDENCE_SPAN_REFERENCE_DUPLICATE",
        `Duplicate evidence reference ${ref}`,
        ref,
      );
    }
    seen.add(ref);
  }
  return selected;
}

function buildCatalogSelectionIndex(
  binding: ReturnType<typeof copyBinding> | EvidenceSpanCatalogBinding,
  verifiedCatalog?: VerifiedCatalogHandle,
): CatalogSelectionIndex {
  const entriesBySourceRef =
    verifiedCatalog?.entriesBySourceRef ??
    new Map(
      binding.catalog.entries.map((entry) => [entry.sourceRef, entry] as const),
    );
  const sourceViews =
    verifiedCatalog?.sourceViews ??
    binding.catalog.entries.map((entry) => entry.sourceView);
  let activeEntry: EvidenceSpanCatalogEntry | undefined;
  const deterministicResolver = createDeterministicEvidenceResolver({
    snapshot: binding.snapshot,
    sourceViews,
    createAnchorId: () => {
      const entry = activeEntry;
      if (!entry) {
        throw new EvidenceSpanCatalogError(
          "EVIDENCE_SPAN_BINDING_RESOLVER_STATE",
          "Catalog resolver lost its selected occurrence",
        );
      }
      return `catalog-anchor-${binding.bindingToken}-${entry.canonicalId.slice(-16)}`;
    },
  });

  // The deterministic resolver's anchor callback is intentionally scoped to
  // the selected occurrence. Serialize calls so concurrent consumers cannot
  // observe another call's active occurrence.
  let queue: Promise<void> = Promise.resolve();
  const resolveEntries = (
    selectedEntries: readonly EvidenceSpanCatalogEntry[],
  ): Promise<ResolvedSelectedEvidenceRefs> => {
    const run = queue.then(async () => {
      const rawEvidenceReferences: RawEvidenceReference[] = [];
      const anchors: ResolvedEvidenceAnchor[] = [];
      for (const entry of selectedEntries) {
        activeEntry = entry;
        let resolution: Awaited<ReturnType<DeterministicEvidenceResolver>>;
        try {
          resolution = await deterministicResolver({
            sourceRef: entry.sourceRef,
            quote: entry.quote,
            canonicalRange: copyRange(entry.canonicalRange),
          });
        } finally {
          activeEntry = undefined;
        }
        if (resolution.status !== "resolved") {
          throw new EvidenceSpanReferenceError(
            "EVIDENCE_SPAN_REFERENCE_UNRESOLVED",
            `Catalog evidence reference ${entry.sourceRef} did not resolve exactly (${resolution.status})`,
            entry.sourceRef,
          );
        }
        rawEvidenceReferences.push({
          sourceRef: entry.sourceRef,
          quote: entry.quote,
        });
        anchors.push(resolution.anchor);
      }
      return freezeDeep({ rawEvidenceReferences, anchors });
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return { entriesBySourceRef, resolveEntries };
}

async function resolveSelectedEvidenceRefsWithCheckedBinding(
  selected: readonly string[],
  manifest: AliasManifest,
  selectionIndex: CatalogSelectionIndex,
): Promise<ResolvedSelectedEvidenceRefs> {
  const selectedEntries = selected.map((ref) => {
    const alias = manifest.byAlias.get(ref);
    if (!alias) {
      throw new EvidenceSpanReferenceError(
        "EVIDENCE_SPAN_REFERENCE_UNKNOWN",
        `Unknown or foreign evidence reference ${ref}`,
        ref,
      );
    }
    const entry = selectionIndex.entriesBySourceRef.get(
      alias.canonicalSourceRef,
    );
    if (!entry || entry.canonicalId !== alias.canonicalId) {
      throw new EvidenceSpanReferenceError(
        "EVIDENCE_SPAN_REFERENCE_STALE",
        `Stale evidence reference ${ref}`,
        ref,
      );
    }
    return entry;
  });
  return selectionIndex.resolveEntries(selectedEntries);
}

/** Create a per-dispatch resolver after one complete binding validation. */
export async function createEvidenceSpanCatalogSelectionResolver(
  binding: EvidenceSpanCatalogBinding,
): Promise<EvidenceSpanCatalogSelectionResolver> {
  const checked = await validateBindingAndManifest(binding);
  return (refs) =>
    resolveSelectedEvidenceRefsWithCheckedBinding(
      validateSelectedRefs(refs),
      checked.manifest,
      checked.selectionIndex,
    );
}

/**
 * Resolve request-local display IDs to code-owned exact references and anchors.
 * No model-supplied quote or offset is accepted on this path.
 */
export async function resolveSelectedEvidenceRefs(
  refs: readonly string[],
  binding: EvidenceSpanCatalogBinding,
): Promise<ResolvedSelectedEvidenceRefs> {
  const selected = validateSelectedRefs(refs);
  const checked = await validateBindingAndManifest(binding);
  return resolveSelectedEvidenceRefsWithCheckedBinding(
    selected,
    checked.manifest,
    checked.selectionIndex,
  );
}
