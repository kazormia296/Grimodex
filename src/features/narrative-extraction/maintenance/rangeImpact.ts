/**
 * UTF-16 code-unit range, document-global. Used throughout Narrative
 * Maintenance to describe both change impact and evidence anchoring.
 */
export interface Utf16Range {
  readonly from: number;
  readonly to: number;
}

/** True when two ranges share at least one code unit (touching does not count). */
export function rangesOverlap(a: Utf16Range, b: Utf16Range): boolean {
  return a.from < b.to && b.from < a.to;
}

export type EvidenceReanchorMethod =
  | "position-map"
  | "nearby-exact"
  | "document-exact";

export type EvidenceReanchorConfidence = "high" | "medium" | "low";

/**
 * Deterministic candidate for relocating evidence whose original range moved
 * or was invalidated. This is only ever a *suggestion*: callers must route it
 * through a maintenance proposal for review. Nothing in this module writes
 * to any store or auto-applies a range change.
 */
export interface EvidenceReanchorCandidate {
  readonly method: EvidenceReanchorMethod;
  readonly range: Utf16Range;
  readonly confidence: EvidenceReanchorConfidence;
}

export type EvidenceReanchorFailureStatus = "ambiguous" | "not-found";

export interface EvidenceReanchorResult {
  readonly status: "found" | EvidenceReanchorFailureStatus;
  readonly candidate: EvidenceReanchorCandidate | null;
}

export interface NarrativePositionMap {
  /** Maps an old document-global range to its current equivalent, or null if unmappable. */
  readonly mapRange: (range: Utf16Range) => Utf16Range | null;
}

export interface ComputeReanchorCandidateInput {
  readonly quote: string;
  readonly oldRange: Utf16Range;
  readonly documentText: string;
  readonly positionMap?: NarrativePositionMap;
  /** Search window (code units) around `oldRange` for the nearby-exact method. Default 200. */
  readonly nearbyRadius?: number;
}

function findAllOccurrences(text: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const result: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    result.push(index);
    index = text.indexOf(needle, index + 1);
  }
  return result;
}

/**
 * Deterministic, side-effect-free reanchor lookup. Precedence:
 *   1. position-map  — trusted structural mapping confirms an exact quote match.
 *   2. nearby-exact   — exactly one exact match within `nearbyRadius` of the old range.
 *   3. document-exact — exactly one exact match anywhere in the document.
 * Multiple matches at any tier are ambiguous, not a guess — this function
 * returns `null` (via `computeReanchorCandidate`) or an `EvidenceReanchorResult`
 * with a failure status (via `computeReanchorCandidateResult`) rather than
 * picking one.
 */
export function computeReanchorCandidateResult(
  input: ComputeReanchorCandidateInput,
): EvidenceReanchorResult {
  const {
    quote,
    oldRange,
    documentText,
    positionMap,
    nearbyRadius = 200,
  } = input;

  if (positionMap) {
    const mapped = positionMap.mapRange(oldRange);
    if (mapped && documentText.slice(mapped.from, mapped.to) === quote) {
      return {
        status: "found",
        candidate: {
          method: "position-map",
          range: mapped,
          confidence: "high",
        },
      };
    }
  }

  const nearbyStart = Math.max(0, oldRange.from - nearbyRadius);
  const nearbyEnd = Math.min(documentText.length, oldRange.to + nearbyRadius);
  const nearbySlice = documentText.slice(nearbyStart, nearbyEnd);
  const nearbyMatches = findAllOccurrences(nearbySlice, quote);
  if (nearbyMatches.length === 1) {
    const from = nearbyStart + nearbyMatches[0];
    return {
      status: "found",
      candidate: {
        method: "nearby-exact",
        range: { from, to: from + quote.length },
        confidence: "medium",
      },
    };
  }

  const documentMatches = findAllOccurrences(documentText, quote);
  if (documentMatches.length === 1) {
    const from = documentMatches[0];
    return {
      status: "found",
      candidate: {
        method: "document-exact",
        range: { from, to: from + quote.length },
        confidence: "low",
      },
    };
  }

  return {
    status:
      documentMatches.length > 1 || nearbyMatches.length > 1
        ? "ambiguous"
        : "not-found",
    candidate: null,
  };
}

/** Convenience wrapper returning just the candidate, or `null` on any failure. */
export function computeReanchorCandidate(
  input: ComputeReanchorCandidateInput,
): EvidenceReanchorCandidate | null {
  return computeReanchorCandidateResult(input).candidate;
}
