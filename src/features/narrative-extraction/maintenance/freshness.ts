import {
  assertValidUtf16Range,
  rangesOverlap,
  type Utf16Range,
} from "./rangeImpact";

/**
 * Artifact / Proposal の技術的な鮮度。
 * Range 影響の分類は `classifyRangeImpact` が返す部分集合を使う。
 * Reanchor 候補は決定的に計算してよいが、自動適用しない。
 */
export type NarrativeFreshnessState =
  | "fresh"
  | "reanchorable"
  | "content-stale"
  | "context-stale"
  | "order-stale"
  | "catalog-stale"
  | "solver-stale"
  | "coverage-stale"
  | "target-stale"
  | "normalizer-mismatch"
  | "extractor-obsolete"
  | "source-missing"
  | "unknown";

/**
 * 「更新版あり」と「無効」を分ける。
 * モデル／Prompt 改善だけでは既存 Artifact を extractor-obsolete にしない。
 */
export type NarrativeRefreshAvailability =
  | "current"
  | "quality-refresh-available"
  | "compatibility-refresh-required";

export interface ClassifyRangeImpactInput {
  /** Ranges captured against the same pre-change canonical revision. */
  readonly evidenceRange: Utf16Range;
  readonly contextRange: Utf16Range;
  readonly changedOldRanges: readonly Utf16Range[];
  readonly wholeDocumentChanged?: boolean;
  /**
   * True when a deterministic revision map shows the evidence text is
   * unchanged but was shifted (e.g. by an insertion before it) without any
   * changed range overlapping the evidence itself.
   */
  readonly shiftedWithoutOverlap?: boolean;
}

/**
 * Classify how a set of changed ranges affects one piece of evidence.
 * Pure/deterministic: never mutates a store or applies a reanchor itself.
 */
export function classifyRangeImpact(
  input: ClassifyRangeImpactInput,
): Extract<
  NarrativeFreshnessState,
  "fresh" | "reanchorable" | "content-stale" | "context-stale"
> {
  assertValidUtf16Range(input.evidenceRange, "evidenceRange");
  assertValidUtf16Range(input.contextRange, "contextRange");
  if (
    input.contextRange.from > input.evidenceRange.from ||
    input.contextRange.to < input.evidenceRange.to
  ) {
    throw new RangeError("contextRange must contain evidenceRange");
  }
  input.changedOldRanges.forEach((range, index) => {
    assertValidUtf16Range(range, `changedOldRanges[${index}]`);
  });

  if (input.wholeDocumentChanged) return "content-stale";

  const overlapsEvidence = input.changedOldRanges.some((range) =>
    rangesOverlap(range, input.evidenceRange),
  );
  if (overlapsEvidence) return "content-stale";

  const overlapsContext = input.changedOldRanges.some((range) =>
    rangesOverlap(range, input.contextRange),
  );
  if (overlapsContext) return "context-stale";

  return input.shiftedWithoutOverlap ? "reanchorable" : "fresh";
}

/** Range 影響から見た既定の refresh 表示（Reanchor は候補提示のみ）。 */
export function defaultRefreshAvailability(
  state: NarrativeFreshnessState,
): NarrativeRefreshAvailability {
  switch (state) {
    case "fresh":
      return "current";
    case "reanchorable":
    case "context-stale":
    case "order-stale":
    case "catalog-stale":
    case "solver-stale":
    case "coverage-stale":
    case "target-stale":
      return "quality-refresh-available";
    case "content-stale":
    case "normalizer-mismatch":
    case "extractor-obsolete":
    case "source-missing":
    case "unknown":
      return "compatibility-refresh-required";
  }
}
