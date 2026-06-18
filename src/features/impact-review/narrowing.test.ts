import { describe, it, expect } from "vitest";
import { denseSceneRanking, fuseSceneCandidates } from "./narrowing";

describe("denseSceneRanking", () => {
  it("collapses chunk hits to scenes keeping the best score, sorted desc", () => {
    const ranked = denseSceneRanking([
      { sceneId: "s1", score: 0.4 },
      { sceneId: "s2", score: 0.9 },
      { sceneId: "s1", score: 0.7 }, // s1 best = 0.7
      { sceneId: "s3", score: 0.5 },
    ]);
    expect(ranked.map((r) => r.sceneId)).toEqual(["s2", "s1", "s3"]);
    expect(ranked.find((r) => r.sceneId === "s1")?.bestScore).toBe(0.7);
  });

  it("returns [] for no hits", () => {
    expect(denseSceneRanking([])).toEqual([]);
  });
});

describe("fuseSceneCandidates", () => {
  it("returns dense order when only dense ranks present", () => {
    const out = fuseSceneCandidates(["s1", "s2", "s3"], []);
    expect(out.map((c) => c.sceneId)).toEqual(["s1", "s2", "s3"]);
    expect(out.every((c) => c.matchedBy.includes("dense"))).toBe(true);
  });

  it("ranks a scene matched by BOTH arms above one matched by a single arm", () => {
    // s2 appears in both dense (rank2) and sparse (rank1); s1 only dense (rank1).
    const out = fuseSceneCandidates(["s1", "s2"], ["s2", "s9"]);
    const ids = out.map((c) => c.sceneId);
    expect(ids[0]).toBe("s2");
    const s2 = out.find((c) => c.sceneId === "s2")!;
    expect(s2.matchedBy.sort()).toEqual(["dense", "sparse"]);
  });

  it("includes sparse-only scenes (mention rescue dense missed)", () => {
    const out = fuseSceneCandidates(["s1"], ["s9"]);
    const s9 = out.find((c) => c.sceneId === "s9");
    expect(s9).toBeTruthy();
    expect(s9!.matchedBy).toEqual(["sparse"]);
  });

  it("caps results at limit", () => {
    const dense = Array.from({ length: 50 }, (_, i) => `s${i}`);
    const out = fuseSceneCandidates(dense, [], { limit: 30 });
    expect(out.length).toBe(30);
  });

  it("dedupes a scene id repeated within one arm", () => {
    const out = fuseSceneCandidates(["s1", "s1", "s2"], []);
    expect(out.map((c) => c.sceneId)).toEqual(["s1", "s2"]);
  });

  it("returns [] when both arms empty", () => {
    expect(fuseSceneCandidates([], [])).toEqual([]);
  });
});
