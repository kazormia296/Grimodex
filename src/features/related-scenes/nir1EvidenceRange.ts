import { serializeProseMirrorDocument } from "@/features/narrative-extraction/source/proseMirrorSerializer";
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

/** Qualification and source-version checks belong to the backend/consumer. */
export function resolveNir1EvidenceRange(input: {
  documentJson: string;
  fullQuote: string;
  normalizerVersion: string;
}): Nir1EvidenceRange {
  if (
    input.fullQuote.length === 0 ||
    Array.from(input.fullQuote).some((character) => {
      const code = character.charCodeAt(0);
      return character.length === 1 && code >= 0xd800 && code <= 0xdfff;
    })
  ) {
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
  const projection = projectCanonicalRange(
    canonical.projectionMap,
    canonicalRange,
  );
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
