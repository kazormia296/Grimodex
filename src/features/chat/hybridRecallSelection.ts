import type { SemanticSearchHit } from "@/features/semantic-search/api";

type RecallSceneRanker = (
  admittedScenes: readonly SemanticSearchHit[],
) => readonly SemanticSearchHit[];

export interface DenseRecallHitSelectionOptions {
  excludeSceneIds: readonly string[];
  minScore: number;
  gateScore: number;
  maxChunks: number;
  /**
   * Reorder only scenes already admitted by the production dense policy.
   * Secondary chunks stay attached to their admitted scene and cannot be
   * introduced by the callback.
   */
  rankScenes?: RecallSceneRanker;
}

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
  rankScenes?: RecallSceneRanker;
}

function applySceneRanking(
  admittedScenes: readonly SemanticSearchHit[],
  rankScenes: RecallSceneRanker | undefined,
): SemanticSearchHit[] {
  const defaultRanked = [...admittedScenes];
  if (!rankScenes) return defaultRanked;

  const admittedByScene = new Map(
    defaultRanked.map((hit) => [hit.sceneId, hit] as const),
  );
  const seen = new Set<string>();
  const customRanked: SemanticSearchHit[] = [];
  for (const rankedHit of rankScenes(defaultRanked)) {
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
  return customRanked;
}

/**
 * Production-authoritative dense-only admission shared by the live fallback
 * and reranker modes. The admitted candidate set matches the historical
 * distinct-scene-first/backfill selector; an optional ranker may reorder only
 * those admitted scene groups.
 */
export function selectDenseRecallHitsWithPolicy(
  denseHits: readonly SemanticSearchHit[],
  options: DenseRecallHitSelectionOptions,
): SemanticSearchHit[] {
  if (options.maxChunks <= 0) return [];

  const excluded = new Set(options.excludeSceneIds);
  const sorted = denseHits
    .filter(
      (hit) => !excluded.has(hit.sceneId) && hit.score >= options.minScore,
    )
    .sort((left, right) => right.score - left.score);
  if (sorted.length === 0 || sorted[0]!.score < options.gateScore) return [];

  const seenScenes = new Set<string>();
  const distinct: SemanticSearchHit[] = [];
  const leftovers: SemanticSearchHit[] = [];
  for (const hit of sorted) {
    if (seenScenes.has(hit.sceneId)) leftovers.push(hit);
    else {
      seenScenes.add(hit.sceneId);
      distinct.push(hit);
    }
  }

  const productionRanked = [...distinct, ...leftovers]
    .slice(0, options.maxChunks)
    .sort((left, right) => right.score - left.score);
  if (!options.rankScenes) return productionRanked;

  const admittedSceneWinners: SemanticSearchHit[] = [];
  const admittedSceneIds = new Set<string>();
  for (const hit of productionRanked) {
    if (admittedSceneIds.has(hit.sceneId)) continue;
    admittedSceneIds.add(hit.sceneId);
    admittedSceneWinners.push(hit);
  }
  const rerankedScenes = applySceneRanking(
    admittedSceneWinners,
    options.rankScenes,
  );
  const scenePosition = new Map(
    rerankedScenes.map((hit, index) => [hit.sceneId, index] as const),
  );
  return [...productionRanked].sort(
    (left, right) =>
      (scenePosition.get(left.sceneId) ?? Number.MAX_SAFE_INTEGER) -
        (scenePosition.get(right.sceneId) ?? Number.MAX_SAFE_INTEGER) ||
      right.score - left.score,
  );
}

/**
 * Production-authoritative hybrid admission shared by the live selector and
 * reranker modes. A reranker may only reorder admitted scene winners;
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
  const ranked = applySceneRanking(defaultRanked, options.rankScenes);

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
