import { hasLoneSurrogate, sha256Digest } from "../source/digest";
import { freezeDeep } from "../source/immutability";
import { projectCanonicalRange } from "../source/textProjection";
import { computeNarrativeSourceViewDigest } from "../source/sourceView";
import type {
  CanonicalRange,
  NarrativeCorpusDocument,
  NarrativeSourceView,
} from "../source/types";
import type {
  EvidenceResolutionContext,
  EvidenceResolutionResult,
  InvalidEvidenceReason,
  RawEvidenceReference,
} from "./types";

const DEFAULT_CONTEXT_RADIUS = 64;
const DEFAULT_MAX_QUOTE_LENGTH = 4_096;

interface ExactMatch {
  readonly start: number;
  readonly end: number;
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
): InvalidEvidenceReason | null {
  const range = sourceView.documentRange;
  if (
    !range ||
    !isNonNegativeInteger(range.start) ||
    !isNonNegativeInteger(range.end) ||
    range.end < range.start ||
    range.end > document.canonical.text.length ||
    typeof sourceView.text !== "string" ||
    hasLoneSurrogate(document.canonical.text) ||
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
  const expectedSourceDigest = await computeNarrativeSourceViewDigest(
    sourceView,
    documentArtifactDigest,
  );
  if (sourceView.digest !== expectedSourceDigest) {
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
