import { hasLoneSurrogate } from "@/features/narrative-extraction/source/digest";
import type { Utf16Range } from "@/features/narrative-extraction/source/types";

export type { Utf16Range };

export function assertValidUtf16Range(
  range: Utf16Range,
  field: string,
  maxLength?: number,
): void {
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from
  ) {
    throw new RangeError(
      `${field} must be a non-negative, ordered UTF-16 range`,
    );
  }
  if (maxLength !== undefined && range.to > maxLength) {
    throw new RangeError(`${field} exceeds the UTF-16 document length`);
  }
}

/** True when two half-open ranges share at least one UTF-16 code unit. */
export function rangesOverlap(a: Utf16Range, b: Utf16Range): boolean {
  assertValidUtf16Range(a, "left range");
  assertValidUtf16Range(b, "right range");
  return a.from < b.to && b.from < a.to;
}

export type EvidenceReanchorMethod =
  | "position-map"
  | "nearby-exact"
  | "document-exact";

export type EvidenceReanchorConfidence = "high" | "medium" | "low";

/** A deterministic preview candidate. Gate C0 never applies it. */
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
  readonly mapRange: (range: Utf16Range) => Utf16Range | null;
}

export interface ComputeReanchorCandidateInput {
  readonly quote: string;
  readonly oldRange: Utf16Range;
  readonly documentText: string;
  readonly positionMap?: NarrativePositionMap;
  /** UTF-16 code units around the old range. Defaults to 200. */
  readonly nearbyRadius?: number;
}

function findAllOccurrences(text: string, needle: string): number[] {
  const result: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    result.push(index);
    index = text.indexOf(needle, index + 1);
  }
  return result;
}

function validateInput(input: ComputeReanchorCandidateInput): number {
  if (input.quote.length === 0) {
    throw new TypeError("quote must not be empty");
  }
  if (hasLoneSurrogate(input.quote) || hasLoneSurrogate(input.documentText)) {
    throw new TypeError("reanchor text must be valid UTF-16");
  }
  assertValidUtf16Range(input.oldRange, "oldRange");
  if (input.oldRange.to - input.oldRange.from !== input.quote.length) {
    throw new RangeError("oldRange length must equal the UTF-16 quote length");
  }
  const nearbyRadius = input.nearbyRadius ?? 200;
  if (!Number.isSafeInteger(nearbyRadius) || nearbyRadius < 0) {
    throw new RangeError("nearbyRadius must be a non-negative safe integer");
  }
  return nearbyRadius;
}

/**
 * Exact-only reanchor lookup. Position maps take precedence, followed by one
 * exact nearby match and then one exact document-wide match. Ambiguity is
 * never resolved by guessing.
 */
export function computeReanchorCandidateResult(
  input: ComputeReanchorCandidateInput,
): EvidenceReanchorResult {
  const nearbyRadius = validateInput(input);
  const { quote, oldRange, documentText, positionMap } = input;

  if (positionMap) {
    const mapped = positionMap.mapRange(oldRange);
    if (mapped) {
      assertValidUtf16Range(mapped, "mapped range", documentText.length);
      if (documentText.slice(mapped.from, mapped.to) === quote) {
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
  }

  const nearbyStart = Math.max(0, oldRange.from - nearbyRadius);
  const nearbyEnd = Math.min(documentText.length, oldRange.to + nearbyRadius);
  const nearbyMatches = findAllOccurrences(
    documentText.slice(nearbyStart, nearbyEnd),
    quote,
  );
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
      nearbyMatches.length > 1 || documentMatches.length > 1
        ? "ambiguous"
        : "not-found",
    candidate: null,
  };
}

export function computeReanchorCandidate(
  input: ComputeReanchorCandidateInput,
): EvidenceReanchorCandidate | null {
  return computeReanchorCandidateResult(input).candidate;
}
