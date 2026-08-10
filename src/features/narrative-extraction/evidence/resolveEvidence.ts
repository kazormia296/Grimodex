import { hasLoneSurrogate, sha256Digest } from "../source/digest";
import { freezeDeep } from "../source/immutability";
import { projectCanonicalRange } from "../source/textProjection";
import { computeNarrativeSourceViewDigest } from "../source/sourceView";
import type {
  CanonicalRange,
  NarrativeCorpusDocument,
  NarrativeSourceView,
  Sha256Digest,
} from "../source/types";
import type {
  DeterministicEvidenceReference,
  EvidenceResolutionContext,
  EvidenceResolutionResult,
  InvalidEvidenceReason,
  RawEvidenceReference,
} from "./types";

const DEFAULT_CONTEXT_RADIUS = 64;
const DEFAULT_MAX_QUOTE_LENGTH = 4_096;
const verifiedSourceViewPairs = new WeakMap<object, WeakSet<object>>();

interface ExactMatch {
  readonly start: number;
  readonly end: number;
}

interface DeterministicEvidenceIndex {
  readonly sourceViews: ReadonlyMap<string, NarrativeSourceView | null>;
  readonly documents: ReadonlyMap<string, NarrativeCorpusDocument | null>;
  readonly quoteDigests: Map<string, Promise<Sha256Digest>>;
  readonly preparedSources: Map<string, Promise<PreparedDeterministicSource>>;
  readonly documentHasLoneSurrogate: Map<string, boolean>;
  readonly snapshotDigest: Sha256Digest;
  readonly createAnchorId: () => string;
  readonly contextRadius: number;
  readonly maxQuoteLength: number;
}

type PreparedDeterministicSource =
  | {
      readonly ok: true;
      readonly sourceView: NarrativeSourceView;
      readonly document: NarrativeCorpusDocument;
    }
  | {
      readonly ok: false;
      readonly reason: InvalidEvidenceReason;
    };

export type DeterministicEvidenceResolver = (
  raw: DeterministicEvidenceReference,
) => Promise<EvidenceResolutionResult>;

function uniqueRefIndex<T extends { readonly ref: string }>(
  values: readonly T[],
): Map<string, T | null> {
  const index = new Map<string, T | null>();
  for (const value of values) {
    index.set(value.ref, index.has(value.ref) ? null : value);
  }
  return index;
}

function buildDeterministicEvidenceIndex(
  context: EvidenceResolutionContext,
): DeterministicEvidenceIndex {
  const snapshot = context.snapshot;
  const createAnchorId = context.createAnchorId;
  return {
    sourceViews: uniqueRefIndex(context.sourceViews),
    documents: uniqueRefIndex(snapshot.documents),
    quoteDigests: new Map(),
    preparedSources: new Map(),
    documentHasLoneSurrogate: new Map(),
    snapshotDigest: snapshot.digest,
    createAnchorId,
    contextRadius: context.contextRadius ?? DEFAULT_CONTEXT_RADIUS,
    maxQuoteLength: context.maxQuoteLength ?? DEFAULT_MAX_QUOTE_LENGTH,
  };
}

function canCachePreparedSource(
  source: NarrativeSourceView,
  index: DeterministicEvidenceIndex,
): boolean {
  const document = index.documents.get(source.documentRef);
  return (
    Object.isFrozen(source) &&
    Object.isFrozen(source.documentRange) &&
    document !== undefined &&
    document !== null &&
    Object.isFrozen(document) &&
    Object.isFrozen(document.canonical)
  );
}

function invalidDeterministic(
  reason: InvalidEvidenceReason,
  raw?: Partial<DeterministicEvidenceReference> | null,
): EvidenceResolutionResult {
  return freezeDeep({
    status: "invalid",
    reason,
    ...(typeof raw?.sourceRef === "string" ? { sourceRef: raw.sourceRef } : {}),
    ...(typeof raw?.quote === "string" ? { quote: raw.quote } : {}),
  });
}

function invalid(
  reason: InvalidEvidenceReason,
  raw?: Partial<RawEvidenceReference> | null,
): EvidenceResolutionResult {
  return freezeDeep({
    status: "invalid",
    reason,
    ...(typeof raw?.sourceRef === "string" ? { sourceRef: raw.sourceRef } : {}),
    ...(typeof raw?.quote === "string" ? { quote: raw.quote } : {}),
  });
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function findAllExactMatches(text: string, quote: string): ExactMatch[] {
  const matches: ExactMatch[] = [];
  let cursor = 0;
  while (cursor <= text.length - quote.length) {
    const start = text.indexOf(quote, cursor);
    if (start < 0) break;
    matches.push({ start, end: start + quote.length });
    // Advance one UTF-16 code unit so overlapping exact matches are retained.
    cursor = start + 1;
  }
  return matches;
}

function hasExactContext(
  text: string,
  match: ExactMatch,
  prefix: string | undefined,
  suffix: string | undefined,
): boolean {
  if (prefix) {
    if (match.start < prefix.length) return false;
    if (text.slice(match.start - prefix.length, match.start) !== prefix) {
      return false;
    }
  }
  if (suffix) {
    if (text.slice(match.end, match.end + suffix.length) !== suffix) {
      return false;
    }
  }
  return true;
}

function findUniqueByRef<T extends { readonly ref: string }>(
  values: readonly T[],
  ref: string,
):
  | { status: "found"; value: T }
  | { status: "missing" }
  | { status: "duplicate" } {
  let found: T | undefined;
  for (const value of values) {
    if (value.ref !== ref) continue;
    if (found) return { status: "duplicate" };
    found = value;
  }
  return found ? { status: "found", value: found } : { status: "missing" };
}

function validateSourceView(
  sourceView: NarrativeSourceView,
  document: NarrativeCorpusDocument,
  documentHasInvalidUnicode = hasLoneSurrogate(document.canonical.text),
): InvalidEvidenceReason | null {
  const range = sourceView.documentRange;
  if (
    !range ||
    !isNonNegativeInteger(range.start) ||
    !isNonNegativeInteger(range.end) ||
    range.end < range.start ||
    range.end > document.canonical.text.length ||
    typeof sourceView.text !== "string" ||
    documentHasInvalidUnicode ||
    hasLoneSurrogate(sourceView.text) ||
    !isUtf16Boundary(document.canonical.text, range.start) ||
    !isUtf16Boundary(document.canonical.text, range.end)
  ) {
    return "invalid-source-view";
  }
  if (
    document.canonical.text.slice(range.start, range.end) !== sourceView.text
  ) {
    return "source-view-mismatch";
  }
  return null;
}

async function prepareDeterministicSource(
  sourceRef: string,
  source: NarrativeSourceView,
  index: DeterministicEvidenceIndex,
): Promise<PreparedDeterministicSource> {
  let sourceView: NarrativeSourceView;
  try {
    sourceView = freezeDeep({
      ref: source.ref,
      documentRef: source.documentRef,
      documentRange: {
        start: source.documentRange.start,
        end: source.documentRange.end,
      },
      text: source.text,
      digest: source.digest,
    });
  } catch {
    return { ok: false, reason: "invalid-source-view" };
  }
  const indexedDocument = index.documents.get(sourceView.documentRef);
  if (indexedDocument === undefined) {
    return { ok: false, reason: "unknown-document-ref" };
  }
  if (indexedDocument === null) {
    return { ok: false, reason: "duplicate-document-ref" };
  }
  const cacheDocumentUnicode =
    Object.isFrozen(indexedDocument) &&
    Object.isFrozen(indexedDocument.canonical);
  let documentHasInvalidUnicode = cacheDocumentUnicode
    ? index.documentHasLoneSurrogate.get(indexedDocument.ref)
    : undefined;
  if (documentHasInvalidUnicode === undefined) {
    documentHasInvalidUnicode = hasLoneSurrogate(
      indexedDocument.canonical.text,
    );
    if (cacheDocumentUnicode) {
      index.documentHasLoneSurrogate.set(
        indexedDocument.ref,
        documentHasInvalidUnicode,
      );
    }
  }
  const invalidSourceReason = validateSourceView(
    sourceView,
    indexedDocument,
    documentHasInvalidUnicode,
  );
  if (invalidSourceReason) return { ok: false, reason: invalidSourceReason };
  if (!(await sourceViewDigestMatches(sourceView, source, indexedDocument))) {
    return { ok: false, reason: "source-view-digest-mismatch" };
  }
  // `sourceRef` is the stable cache key. Referencing it here makes accidental
  // cross-key preparation visible to static review and future assertions.
  if (sourceView.ref !== sourceRef) {
    return { ok: false, reason: "source-view-mismatch" };
  }
  return { ok: true, sourceView, document: indexedDocument };
}

async function sourceViewDigestMatches(
  sourceView: NarrativeSourceView,
  originalSourceView: NarrativeSourceView,
  document: NarrativeCorpusDocument,
): Promise<boolean> {
  const cacheable =
    Object.isFrozen(originalSourceView) &&
    Object.isFrozen(originalSourceView.documentRange) &&
    Object.isFrozen(document);
  if (
    cacheable &&
    verifiedSourceViewPairs.get(originalSourceView)?.has(document)
  ) {
    return true;
  }
  const expected = await computeNarrativeSourceViewDigest(
    sourceView,
    document.artifactDigest,
  );
  if (sourceView.digest !== expected) return false;
  if (cacheable) {
    let documents = verifiedSourceViewPairs.get(originalSourceView);
    if (!documents) {
      documents = new WeakSet<object>();
      verifiedSourceViewPairs.set(originalSourceView, documents);
    }
    documents.add(document);
  }
  return true;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  return !(
    offset > 0 &&
    offset < text.length &&
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  );
}

function expandToUtf16Boundary(
  text: string,
  offset: number,
  direction: "before" | "after",
): number {
  if (isUtf16Boundary(text, offset)) return offset;
  return direction === "before" ? offset - 1 : offset + 1;
}

function boundedContext(
  text: string,
  match: ExactMatch,
  radius: number,
): { prefix: string; suffix: string } {
  const prefixStart = expandToUtf16Boundary(
    text,
    Math.max(0, match.start - radius),
    "before",
  );
  const suffixEnd = expandToUtf16Boundary(
    text,
    Math.min(text.length, match.end + radius),
    "after",
  );
  return {
    prefix: text.slice(prefixStart, match.start),
    suffix: text.slice(match.end, suffixEnd),
  };
}

function validRawReference(
  value: RawEvidenceReference,
  maxQuoteLength: number,
): InvalidEvidenceReason | null {
  if (!value || typeof value !== "object") return "invalid-reference";
  if (typeof value.sourceRef !== "string") return "invalid-reference";
  if (value.sourceRef.length === 0) return "empty-source-ref";
  if (typeof value.quote !== "string") return "invalid-reference";
  if (value.quote.length === 0) return "empty-quote";
  if (value.quote.length > maxQuoteLength) return "quote-too-long";
  if (
    (value.prefix !== undefined && typeof value.prefix !== "string") ||
    (value.suffix !== undefined && typeof value.suffix !== "string")
  ) {
    return "invalid-reference";
  }
  if (
    hasLoneSurrogate(value.sourceRef) ||
    hasLoneSurrogate(value.quote) ||
    (value.prefix !== undefined && hasLoneSurrogate(value.prefix)) ||
    (value.suffix !== undefined && hasLoneSurrogate(value.suffix))
  ) {
    return "invalid-unicode";
  }
  return null;
}

/**
 * Resolve untrusted model evidence against one immutable Source View.
 *
 * Every exact occurrence is enumerated. A duplicate is accepted only when
 * the provided prefix/suffix narrows the full set to exactly one occurrence;
 * the resolver never guesses or adopts the first match.
 */
export async function resolveEvidenceReference(
  raw: RawEvidenceReference,
  context: EvidenceResolutionContext,
): Promise<EvidenceResolutionResult> {
  let reference: RawEvidenceReference;
  try {
    reference = {
      sourceRef: raw.sourceRef,
      quote: raw.quote,
      ...(raw.prefix !== undefined ? { prefix: raw.prefix } : {}),
      ...(raw.suffix !== undefined ? { suffix: raw.suffix } : {}),
    };
  } catch {
    return invalid("invalid-reference");
  }
  const contextRadius = context.contextRadius ?? DEFAULT_CONTEXT_RADIUS;
  const maxQuoteLength = context.maxQuoteLength ?? DEFAULT_MAX_QUOTE_LENGTH;
  if (
    !isNonNegativeInteger(contextRadius) ||
    !Number.isSafeInteger(maxQuoteLength) ||
    maxQuoteLength <= 0
  ) {
    return invalid("invalid-options", reference);
  }

  const invalidRawReason = validRawReference(reference, maxQuoteLength);
  if (invalidRawReason) return invalid(invalidRawReason, reference);

  const { sourceRef, quote, prefix, suffix } = reference;

  const sourceLookup = findUniqueByRef(context.sourceViews, sourceRef);
  if (sourceLookup.status === "missing") {
    return invalid("unknown-source-ref", reference);
  }
  if (sourceLookup.status === "duplicate") {
    return invalid("duplicate-source-ref", reference);
  }
  let sourceView: NarrativeSourceView;
  try {
    sourceView = freezeDeep({
      ref: sourceLookup.value.ref,
      documentRef: sourceLookup.value.documentRef,
      documentRange: {
        start: sourceLookup.value.documentRange.start,
        end: sourceLookup.value.documentRange.end,
      },
      text: sourceLookup.value.text,
      digest: sourceLookup.value.digest,
    });
  } catch {
    return invalid("invalid-source-view", reference);
  }

  const documentLookup = findUniqueByRef(
    context.snapshot.documents,
    sourceView.documentRef,
  );
  if (documentLookup.status === "missing") {
    return invalid("unknown-document-ref", reference);
  }
  if (documentLookup.status === "duplicate") {
    return invalid("duplicate-document-ref", reference);
  }
  const document = documentLookup.value;
  const documentArtifactDigest = document.artifactDigest;

  const invalidSourceReason = validateSourceView(sourceView, document);
  if (invalidSourceReason) return invalid(invalidSourceReason, reference);
  const sourceDigestMatches = await sourceViewDigestMatches(
    sourceView,
    sourceLookup.value,
    document,
  );
  if (!sourceDigestMatches) {
    return invalid("source-view-digest-mismatch", reference);
  }

  const initialMatches = findAllExactMatches(sourceView.text, quote);
  if (initialMatches.length === 0) {
    return {
      status: "not-found",
      sourceRef,
      quote,
    };
  }

  const hasContext = Boolean(prefix || suffix);
  const candidates = hasContext
    ? initialMatches.filter((candidate) =>
        hasExactContext(sourceView.text, candidate, prefix, suffix),
      )
    : initialMatches;
  if (candidates.length === 0) {
    return {
      status: "not-found",
      sourceRef,
      quote,
    };
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      sourceRef,
      quote,
      initialMatchCount: initialMatches.length,
      remainingMatchCount: candidates.length,
    };
  }
  const match = candidates[0];
  if (!match) return invalid("invalid-reference", reference);
  const method = hasContext ? "exact-with-context" : "exact";

  const canonicalRange: CanonicalRange = {
    start: sourceView.documentRange.start + match.start,
    end: sourceView.documentRange.start + match.end,
  };
  const projection = projectCanonicalRange(
    document.canonical.projection,
    canonicalRange,
  );
  if (projection.status === "unmapped") {
    return invalid("unmapped-projection", reference);
  }

  const anchorId = context.createAnchorId();
  const documentRef = document.ref;
  const snapshotDigest = context.snapshot.digest;
  const contentDigest = document.contentDigest;
  const documentDigest = document.documentDigest;
  const sourceDigest = sourceView.digest;
  const anchorContext = boundedContext(sourceView.text, match, contextRadius);
  const quoteDigest = await sha256Digest(quote);
  return freezeDeep({
    status: "resolved",
    anchor: {
      id: anchorId,
      sourceRef,
      documentRef,
      quote,
      sourceRange: { start: match.start, end: match.end },
      canonicalRange,
      projection,
      context: anchorContext,
      method,
      initialMatchCount: initialMatches.length,
      quoteDigest,
      snapshotDigest,
      contentDigest,
      documentDigest,
      documentArtifactDigest,
      sourceDigest,
    },
  });
}

/**
 * Verify an extractor-supplied document-global range without searching for a
 * nearby occurrence. Duplicate quotes therefore remain independent and a
 * forged range is rejected instead of being silently relocated.
 */
async function resolveDeterministicEvidenceReferenceWithIndex(
  raw: DeterministicEvidenceReference,
  index: DeterministicEvidenceIndex,
): Promise<EvidenceResolutionResult> {
  let reference: DeterministicEvidenceReference;
  try {
    reference = {
      sourceRef: raw.sourceRef,
      quote: raw.quote,
      canonicalRange: {
        start: raw.canonicalRange.start,
        end: raw.canonicalRange.end,
      },
    };
  } catch {
    return invalidDeterministic("invalid-reference");
  }

  const { contextRadius, maxQuoteLength } = index;
  if (
    !isNonNegativeInteger(contextRadius) ||
    !Number.isSafeInteger(maxQuoteLength) ||
    maxQuoteLength <= 0
  ) {
    return invalidDeterministic("invalid-options", reference);
  }

  const basicReason = validRawReference(
    { sourceRef: reference.sourceRef, quote: reference.quote },
    maxQuoteLength,
  );
  if (basicReason) return invalidDeterministic(basicReason, reference);
  const suppliedRange = reference.canonicalRange;
  if (
    !suppliedRange ||
    !isNonNegativeInteger(suppliedRange.start) ||
    !isNonNegativeInteger(suppliedRange.end) ||
    suppliedRange.end < suppliedRange.start
  ) {
    return invalidDeterministic("invalid-reference", reference);
  }

  const indexedSource = index.sourceViews.get(reference.sourceRef);
  if (indexedSource === undefined) {
    return invalidDeterministic("unknown-source-ref", reference);
  }
  if (indexedSource === null) {
    return invalidDeterministic("duplicate-source-ref", reference);
  }

  const cachePrepared = canCachePreparedSource(indexedSource, index);
  let preparedPromise = cachePrepared
    ? index.preparedSources.get(reference.sourceRef)
    : undefined;
  if (!preparedPromise) {
    preparedPromise = prepareDeterministicSource(
      reference.sourceRef,
      indexedSource,
      index,
    );
    if (cachePrepared) {
      index.preparedSources.set(reference.sourceRef, preparedPromise);
    }
  }
  const prepared = await preparedPromise;
  if (!prepared.ok) {
    return invalidDeterministic(prepared.reason, reference);
  }
  const { sourceView, document } = prepared;

  if (
    suppliedRange.start < sourceView.documentRange.start ||
    suppliedRange.end > sourceView.documentRange.end ||
    !isUtf16Boundary(document.canonical.text, suppliedRange.start) ||
    !isUtf16Boundary(document.canonical.text, suppliedRange.end)
  ) {
    return invalidDeterministic("range-mismatch", reference);
  }
  const match: ExactMatch = {
    start: suppliedRange.start - sourceView.documentRange.start,
    end: suppliedRange.end - sourceView.documentRange.start,
  };
  if (
    match.end - match.start !== reference.quote.length ||
    sourceView.text.slice(match.start, match.end) !== reference.quote
  ) {
    return invalidDeterministic("range-mismatch", reference);
  }

  const projection = projectCanonicalRange(
    document.canonical.projection,
    suppliedRange,
  );
  if (projection.status === "unmapped") {
    return invalidDeterministic("unmapped-projection", reference);
  }

  const anchorContext = boundedContext(sourceView.text, match, contextRadius);
  const documentRef = document.ref;
  const snapshotDigest = index.snapshotDigest;
  const contentDigest = document.contentDigest;
  const documentDigest = document.documentDigest;
  const documentArtifactDigest = document.artifactDigest;
  const sourceDigest = sourceView.digest;
  const anchorId = index.createAnchorId();
  let quoteDigestPromise = index.quoteDigests.get(reference.quote);
  if (!quoteDigestPromise) {
    quoteDigestPromise = sha256Digest(reference.quote);
    index.quoteDigests.set(reference.quote, quoteDigestPromise);
  }
  const quoteDigest = await quoteDigestPromise;
  return freezeDeep({
    status: "resolved",
    anchor: {
      id: anchorId,
      sourceRef: reference.sourceRef,
      documentRef,
      quote: reference.quote,
      sourceRange: match,
      canonicalRange: suppliedRange,
      projection,
      context: anchorContext,
      method: "exact",
      // This path verifies one supplied coordinate and deliberately performs
      // no whole-view occurrence search (which would be quadratic for dense
      // deterministic seed output).
      initialMatchCount: 1,
      quoteDigest,
      snapshotDigest,
      contentDigest,
      documentDigest,
      documentArtifactDigest,
      sourceDigest,
    },
  });
}

/** Build one indexed resolver for a run with many deterministic occurrences. */
export function createDeterministicEvidenceResolver(
  context: EvidenceResolutionContext,
): DeterministicEvidenceResolver {
  const index = buildDeterministicEvidenceIndex(context);
  return (raw) => resolveDeterministicEvidenceReferenceWithIndex(raw, index);
}

export function resolveDeterministicEvidenceReference(
  raw: DeterministicEvidenceReference,
  context: EvidenceResolutionContext,
): Promise<EvidenceResolutionResult> {
  return resolveDeterministicEvidenceReferenceWithIndex(
    raw,
    buildDeterministicEvidenceIndex(context),
  );
}
