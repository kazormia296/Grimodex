import { digestStableJson, hasLoneSurrogate } from "./digest";
import { freezeDeep } from "./immutability";
import type {
  CanonicalRange,
  NarrativeCorpusDocument,
  NarrativeSourceView,
  Sha256Digest,
} from "./types";

export interface NarrativeSourceViewDigestInput {
  readonly ref: string;
  readonly documentRef: string;
  readonly documentRange: CanonicalRange;
  readonly text: string;
}

export interface NarrativeSourceViewBuildInput {
  readonly ref: string;
  readonly document: NarrativeCorpusDocument;
  readonly documentRange: CanonicalRange;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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

/** Compute the integrity digest stored in a Source View manifest. */
export function computeNarrativeSourceViewDigest(
  input: NarrativeSourceViewDigestInput,
  documentArtifactDigest: Sha256Digest,
): Promise<Sha256Digest> {
  return digestStableJson({
    schemaVersion: 1,
    ref: input.ref,
    documentRef: input.documentRef,
    documentArtifactDigest,
    documentRange: {
      start: input.documentRange.start,
      end: input.documentRange.end,
    },
    text: input.text,
  });
}

/** Build a Source View from a sealed document without accepting caller text. */
export async function buildNarrativeSourceView(
  input: NarrativeSourceViewBuildInput,
): Promise<NarrativeSourceView> {
  const ref = input.ref;
  const documentRef = input.document.ref;
  const documentArtifactDigest = input.document.artifactDigest;
  const canonicalText = input.document.canonical.text;
  const documentRange = {
    start: input.documentRange.start,
    end: input.documentRange.end,
  };
  if (
    ref.length === 0 ||
    hasLoneSurrogate(ref) ||
    documentRef.length === 0 ||
    hasLoneSurrogate(documentRef) ||
    !isNonNegativeInteger(documentRange.start) ||
    !isNonNegativeInteger(documentRange.end) ||
    documentRange.end < documentRange.start ||
    documentRange.end > canonicalText.length ||
    !isUtf16Boundary(canonicalText, documentRange.start) ||
    !isUtf16Boundary(canonicalText, documentRange.end)
  ) {
    throw new RangeError("Invalid narrative Source View range or identity");
  }

  const draft: NarrativeSourceViewDigestInput = {
    ref,
    documentRef,
    documentRange,
    text: canonicalText.slice(documentRange.start, documentRange.end),
  };
  const digest = await computeNarrativeSourceViewDigest(
    draft,
    documentArtifactDigest,
  );
  return freezeDeep({ ...draft, digest });
}
