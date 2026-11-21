/**
 * Temporal の型（TemporalNodeId・StoryCompare・StoryRankLayer・StoryRankResult）。
 * 型だけの leaf module（MP-4b PR-3b-2。`nodes.ts`・`solver/resolveStoryRanks.ts` から切り出した。
 * `nodes.ts` は `../source/digest` を値で import するので丸ごとは移せない。
 * 元の 2 file は型を再エクスポートし続ける）。
 */
export type TemporalNodeId = `tn:${string}`;

export type StoryCompare =
  | { readonly kind: "before" }
  | { readonly kind: "after" }
  | { readonly kind: "equal" }
  | { readonly kind: "incomparable" };

export interface StoryRankLayer {
  readonly rank: number;
  readonly nodeIds: readonly TemporalNodeId[];
}

export interface StoryRankResult {
  readonly layers: readonly StoryRankLayer[];
  /** Pairwise relation; missing key ⇒ incomparable */
  readonly compare: (
    left: TemporalNodeId,
    right: TemporalNodeId,
  ) => StoryCompare;
  readonly equalTimeGroups: ReadonlyMap<TemporalNodeId, string>;
}
