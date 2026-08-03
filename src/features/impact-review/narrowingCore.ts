/** Pure candidate-ranking logic shared by the product and Gate 3.1 exporter. */

/** RRF constant kept aligned with semanticRecall.ts. */
export const IMPACT_RRF_K = 60;
export const DEFAULT_IMPACT_INFERRED_LIMIT = 30;

export interface SceneCandidate {
  sceneId: string;
  /** Fused RRF score, higher first. */
  score: number;
  /** Best dense cosine observed for the scene. */
  denseScore?: number;
  matchedBy: Array<"dense" | "sparse" | "semantic">;
}

/** Collapse chunk-level dense hits to scenes and retain each best score. */
export function denseSceneRanking(
  hits: Array<{ sceneId: string; score: number }>,
): Array<{ sceneId: string; bestScore: number }> {
  const best = new Map<string, number>();
  for (const hit of hits) {
    const previous = best.get(hit.sceneId);
    if (previous === undefined || hit.score > previous) {
      best.set(hit.sceneId, hit.score);
    }
  }
  return [...best.entries()]
    .map(([sceneId, bestScore]) => ({ sceneId, bestScore }))
    .sort((left, right) => right.bestScore - left.bestScore);
}

function dedupeInOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      output.push(id);
    }
  }
  return output;
}

/**
 * Fuse inferred dense/sparse rankings and author-confirmed semantic links.
 *
 * `limit` applies only to inferred candidates. Explicit semantic links always
 * survive and bypass the future classifier, so they may take the returned
 * total above the inferred limit.
 */
export function fuseSceneCandidates(
  denseSceneIds: string[],
  sparseSceneIds: string[],
  opts: {
    rrfK?: number;
    limit?: number;
    denseScoreById?: Map<string, number>;
    semanticSceneIds?: string[];
  } = {},
): SceneCandidate[] {
  const k = opts.rrfK ?? IMPACT_RRF_K;
  const limit = opts.limit ?? DEFAULT_IMPACT_INFERRED_LIMIT;
  const dense = dedupeInOrder(denseSceneIds);
  const sparse = dedupeInOrder(sparseSceneIds);
  const semantic = dedupeInOrder(opts.semanticSceneIds ?? []);

  const accumulated = new Map<
    string,
    {
      score: number;
      matchedBy: Set<"dense" | "sparse" | "semantic">;
    }
  >();
  const bump = (
    id: string,
    rank: number,
    arm: "dense" | "sparse" | "semantic",
  ) => {
    const entry = accumulated.get(id) ?? {
      score: 0,
      matchedBy: new Set<"dense" | "sparse" | "semantic">(),
    };
    entry.score += 1 / (k + rank);
    entry.matchedBy.add(arm);
    accumulated.set(id, entry);
  };
  dense.forEach((id, index) => bump(id, index, "dense"));
  sparse.forEach((id, index) => bump(id, index, "sparse"));
  semantic.forEach((id, index) => bump(id, index, "semantic"));

  const sorted = [...accumulated.entries()]
    .map(([sceneId, entry]) => ({
      sceneId,
      score: entry.score,
      denseScore: opts.denseScoreById?.get(sceneId),
      matchedBy: [...entry.matchedBy].sort(),
    }))
    .sort((left, right) => {
      const leftSemantic = left.matchedBy.includes("semantic");
      const rightSemantic = right.matchedBy.includes("semantic");
      if (leftSemantic !== rightSemantic) return leftSemantic ? -1 : 1;
      return right.score - left.score;
    });

  const semanticCandidates = sorted.filter((candidate) =>
    candidate.matchedBy.includes("semantic"),
  );
  const inferredCandidates = sorted.filter(
    (candidate) => !candidate.matchedBy.includes("semantic"),
  );
  return [...semanticCandidates, ...inferredCandidates.slice(0, limit)];
}
