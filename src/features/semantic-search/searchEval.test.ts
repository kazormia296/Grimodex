import { describe, it, expect } from "vitest";
import type { SemanticSearchHit } from "./api";
import {
  dedupeScenes,
  rankOfExpected,
  computeRecallMrr,
  thresholdSweep,
  fuseHybridSceneRanking,
} from "./searchEval";

function hit(
  sceneId: string,
  sceneTitle: string,
  score: number,
): SemanticSearchHit {
  return {
    sceneId,
    sceneTitle,
    chunkText: "",
    charStart: 0,
    charEnd: 0,
    score,
    dialogueRatio: 0,
  };
}

describe("dedupeScenes", () => {
  it("keeps the first (highest-scored) chunk per scene, preserving order", () => {
    const hits = [
      hit("s1", "A", 0.9),
      hit("s1", "A", 0.8), // duplicate scene, dropped
      hit("s2", "B", 0.7),
      hit("s2", "B", 0.6),
      hit("s3", "C", 0.5),
    ];
    expect(dedupeScenes(hits).map((s) => `${s.sceneId}:${s.score}`)).toEqual([
      "s1:0.9",
      "s2:0.7",
      "s3:0.5",
    ]);
  });
});

describe("rankOfExpected", () => {
  const scenes = [
    { sceneId: "s1", sceneTitle: "A", score: 0.9 },
    { sceneId: "s2", sceneTitle: "B", score: 0.7 },
    { sceneId: "s3", sceneTitle: "C", score: 0.5 },
  ];

  it("returns 1-based rank and score of the first matching title", () => {
    expect(rankOfExpected(scenes, ["B"])).toEqual({ rank: 2, score: 0.7 });
  });

  it("matches any-of the expected titles", () => {
    expect(rankOfExpected(scenes, ["X", "C"])).toEqual({ rank: 3, score: 0.5 });
  });

  it("returns null when no expected title is present", () => {
    expect(rankOfExpected(scenes, ["Z"])).toEqual({ rank: null, score: null });
  });
});

describe("computeRecallMrr", () => {
  it("computes Recall@1, Recall@3, MRR over ranks", () => {
    const r = computeRecallMrr([
      { rank: 1 },
      { rank: 2 },
      { rank: 4 },
      { rank: null },
    ]);
    expect(r.recallAt1).toBeCloseTo(1 / 4);
    expect(r.recallAt3).toBeCloseTo(2 / 4); // ranks 1 and 2
    // MRR = (1/1 + 1/2 + 1/4 + 0) / 4 = 1.75/4
    expect(r.mrr).toBeCloseTo(1.75 / 4);
  });

  it("returns zeros for an empty result set", () => {
    expect(computeRecallMrr([])).toEqual({
      recallAt1: 0,
      recallAt3: 0,
      mrr: 0,
    });
  });
});

describe("fuseHybridSceneRanking", () => {
  const sc = (sceneId: string, score: number) => ({
    sceneId,
    sceneTitle: sceneId.toUpperCase(),
    score,
  });

  it("promotes a sparse-top scene above a higher-cosine non-sparse scene", () => {
    const dense = [sc("hi", 0.9), sc("lo", 0.82)]; // dense (cosine-desc) order
    const fused = fuseHybridSceneRanking(dense, ["lo"]);
    expect(fused.map((s) => s.sceneId)).toEqual(["lo", "hi"]);
  });

  it("preserves dense order when there are no sparse hits", () => {
    const dense = [sc("a", 0.9), sc("b", 0.8), sc("c", 0.7)];
    expect(fuseHybridSceneRanking(dense, []).map((s) => s.sceneId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("ignores sparse-only ids that are not in the dense pool (no phantom rows)", () => {
    const dense = [sc("a", 0.9), sc("b", 0.8)];
    // "ghost" takes sparse rank 0 (consumed), "b" rank 1 → still promoted over a.
    const fused = fuseHybridSceneRanking(dense, ["ghost", "b"]);
    expect(fused.map((s) => s.sceneId)).toEqual(["b", "a"]);
    expect(fused).toHaveLength(2);
  });
});

describe("thresholdSweep", () => {
  it("finds a threshold that separates positives from negatives", () => {
    const { best, j } = thresholdSweep([0.7, 0.8, 0.9], [0.3, 0.4, 0.5]);
    // Perfectly separable -> Youden J = 1 at a threshold in [0.5, 0.7].
    expect(j).toBeCloseTo(1);
    expect(best).toBeGreaterThanOrEqual(0.5);
    expect(best).toBeLessThanOrEqual(0.7);
  });

  it("handles empty input", () => {
    expect(thresholdSweep([], [])).toEqual({ best: 0, j: 0 });
  });
});
