import type { SemanticSearchHit } from "@/features/semantic-search/api";

export interface HybridRecallHitSelectionOptions {
  excludeSceneIds: readonly string[];
  minScore: number;
  gateScore: number;
  maxChunks: number;
  rescueMargin: number;
  rrfK: number;
  /**
   * Reorder the already-admitted best chunk for each scene. The callback
   * cannot add candidates or replace a scene's production-authoritative hit.
   */
  rankScenes?: (
    admittedScenes: readonly SemanticSearchHit[],
  ) => readonly SemanticSearchHit[];
}

/**
 * Production-authoritative hybrid admission shared by the live selector and
 * reranker shadow. A shadow model may only reorder admitted scene winners;
 * dense/sparse gates and backfill remain identical to production.
 */
export function selectHybridRecallHitsWithPolicy(
  denseHits: readonly SemanticSearchHit[],
  sparseSceneIdsRanked: readonly string[],
  options: HybridRecallHitSelectionOptions,
): SemanticSearchHit[] {
  if (options.maxChunks <= 0) return [];

  const rescueFloor = options.minScore - options.rescueMargin;
  const excluded = new Set(options.excludeSceneIds);
  const sparseRank = new Map<string, number>();
  for (const sceneId of sparseSceneIdsRanked) {
    if (excluded.has(sceneId) || sparseRank.has(sceneId)) continue;
    sparseRank.set(sceneId, sparseRank.size);
  }

  const byScoreDesc = denseHits
    .filter((hit) => !excluded.has(hit.sceneId))
    .sort((left, right) => right.score - left.score);
  const bestByScene = new Map<string, SemanticSearchHit>();
  const leftovers: SemanticSearchHit[] = [];
  for (const hit of byScoreDesc) {
    if (bestByScene.has(hit.sceneId)) leftovers.push(hit);
    else bestByScene.set(hit.sceneId, hit);
  }

  const denseScenes = [...bestByScene.values()];
  const denseRank = new Map(
    denseScenes.map((hit, index) => [hit.sceneId, index] as const),
  );
  const densePass =
    denseScenes.length > 0 && denseScenes[0]!.score >= options.gateScore;

  const eligible: Array<{ hit: SemanticSearchHit; rrf: number }> = [];
  for (const hit of denseScenes) {
    const sceneDenseRank = denseRank.get(hit.sceneId)!;
    const sceneSparseRank = sparseRank.get(hit.sceneId);
    const inSparse = sceneSparseRank !== undefined;
    const sparseRescue = inSparse && hit.score >= rescueFloor;
    const denseConfident = hit.score >= options.minScore;
    if (!sparseRescue && !(densePass && denseConfident)) continue;
    eligible.push({
      hit,
      rrf:
        1 / (options.rrfK + sceneDenseRank) +
        (inSparse ? 1 / (options.rrfK + sceneSparseRank) : 0),
    });
  }
  if (eligible.length === 0) return [];

  eligible.sort(
    (left, right) =>
      right.rrf - left.rrf ||
      right.hit.score - left.hit.score ||
      left.hit.sceneId.localeCompare(right.hit.sceneId),
  );
  const defaultRanked = eligible.map(({ hit }) => hit);
  let ranked = defaultRanked;
  if (options.rankScenes) {
    const admittedByScene = new Map(
      defaultRanked.map((hit) => [hit.sceneId, hit] as const),
    );
    const seen = new Set<string>();
    const customRanked: SemanticSearchHit[] = [];
    for (const rankedHit of options.rankScenes(defaultRanked)) {
      const admitted = admittedByScene.get(rankedHit.sceneId);
      if (!admitted || seen.has(admitted.sceneId)) continue;
      seen.add(admitted.sceneId);
      customRanked.push(admitted);
    }
    for (const hit of defaultRanked) {
      if (seen.has(hit.sceneId)) continue;
      seen.add(hit.sceneId);
      customRanked.push(hit);
    }
    ranked = customRanked;
  }

  const chosen = ranked.slice(0, options.maxChunks);
  if (densePass && chosen.length < options.maxChunks) {
    const remaining = options.maxChunks - chosen.length;
    chosen.push(
      ...leftovers
        .filter((hit) => hit.score >= options.minScore)
        .slice(0, remaining),
    );
  }
  return chosen;
}
