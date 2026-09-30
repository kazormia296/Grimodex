/** Typed scorer boundary shared with the renderer's fixture tests. */
export function scoreQuery(
  query: {
    eligibleSceneIds: readonly string[];
    relevanceGrades: Readonly<Record<string, number>>;
    requiredRawPassages: readonly { sceneId: string; text: string }[];
  },
  results: readonly { sceneId: string; chunkText: string }[],
  k?: number,
): {
  recallAt8: number;
  ndcgAt8: number;
  top1SceneId: string | null;
  relevantRank: number | null;
  requiredRawPassagesRetained: boolean;
};
