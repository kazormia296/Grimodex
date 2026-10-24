import { serializeProseMirrorDocument } from "@/features/narrative-extraction/source/proseMirrorSerializer";
export { serializeProseMirrorDocument };
import { projectCanonicalRange } from "@/features/narrative-extraction/source/textProjection";
import {
  CANONICAL_TEXT_NORMALIZER_VERSION,
  type CanonicalRange,
  type Utf16Range,
} from "@/features/narrative-extraction/source/types";

export type Nir1EvidenceRange =
  | {
      status: "highlight";
      canonicalRange: CanonicalRange;
      selection: Utf16Range;
    }
  | {
      status: "scene-only";
      reason: "ambiguous-quote" | "unmapped-quote" | "unsupported-normalizer";
    }
  | {
      status: "cancel";
      reason: "invalid-source" | "invalid-quote" | "missing-quote";
    };

function hasLoneSurrogate(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return character.length === 1 && code >= 0xd800 && code <= 0xdfff;
  });
}

/** Qualification and source-version checks belong to the backend/consumer. */
export function resolveNir1EvidenceRange(input: {
  documentJson: string;
  fullQuote: string;
  normalizerVersion: string;
}): Nir1EvidenceRange {
  if (input.fullQuote.length === 0 || hasLoneSurrogate(input.fullQuote)) {
    return { status: "cancel", reason: "invalid-quote" };
  }
  if (input.normalizerVersion !== CANONICAL_TEXT_NORMALIZER_VERSION) {
    return { status: "scene-only", reason: "unsupported-normalizer" };
  }
  const serialized = serializeProseMirrorDocument(
    input.documentJson,
    "database",
  );
  if (!serialized.ok) return { status: "cancel", reason: "invalid-source" };
  const { canonical } = serialized;
  const start = canonical.text.indexOf(input.fullQuote);
  if (start < 0) return { status: "cancel", reason: "missing-quote" };
  if (canonical.text.indexOf(input.fullQuote, start + 1) >= 0) {
    return { status: "scene-only", reason: "ambiguous-quote" };
  }
  const canonicalRange = { start, end: start + input.fullQuote.length };
  return highlight(canonical.projectionMap, canonicalRange);
}

type ProjectionMap = Parameters<typeof projectCanonicalRange>[0];

function highlight(
  projectionMap: ProjectionMap,
  canonicalRange: CanonicalRange,
): Nir1EvidenceRange {
  const projection = projectCanonicalRange(projectionMap, canonicalRange);
  if (projection.status === "unmapped" || projection.fragments.length === 0) {
    return { status: "scene-only", reason: "unmapped-quote" };
  }
  const first = projection.fragments[0];
  const last = projection.fragments[projection.fragments.length - 1];
  if (
    !first ||
    !last ||
    first.canonicalStart !== canonicalRange.start ||
    last.canonicalEnd !== canonicalRange.end
  )
    return { status: "scene-only", reason: "unmapped-quote" };
  const selection =
    projection.status === "fragmented"
      ? projection.enclosingRange
      : { from: first.from, to: last.to };
  return { status: "highlight", canonicalRange, selection };
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * A Graph-only row's click (CP-3b, DR-CP3B-10): highlight only when the
 * editor's canonical text at exactly `canonicalRange` equals the disclosed
 * `excerpt`. Never searches (`indexOf`); the same text elsewhere does not
 * matter, and `String.slice` clamping is never relied on.
 */
export function resolveNir1GraphOnlyRange(input: {
  documentJson: string;
  canonicalRange: { readonly start: number; readonly end: number };
  excerpt: string;
}): Nir1EvidenceRange {
  const { start, end } = input.canonicalRange;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= end ||
    end - start !== input.excerpt.length ||
    hasLoneSurrogate(input.excerpt)
  )
    return { status: "cancel", reason: "invalid-quote" };
  const serialized = serializeProseMirrorDocument(
    input.documentJson,
    "database",
  );
  if (!serialized.ok) return { status: "cancel", reason: "invalid-source" };
  const { canonical } = serialized;
  const text = canonical.text;
  if (
    end > text.length ||
    isLowSurrogate(text.charCodeAt(start)) ||
    (end < text.length && isLowSurrogate(text.charCodeAt(end))) ||
    text.slice(start, end) !== input.excerpt
  )
    return { status: "cancel", reason: "missing-quote" };
  return highlight(canonical.projectionMap, { start, end });
}
