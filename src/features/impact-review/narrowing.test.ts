import { beforeEach, describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => {
  const dbWhere = vi.fn();
  const dbFrom = vi.fn(() => ({ where: dbWhere }));
  const dbSelect = vi.fn(() => ({ from: dbFrom }));
  return {
    dbWhere,
    dbFrom,
    dbSelect,
    semanticSearch: vi.fn(),
    invoke: vi.fn(),
  };
});

vi.mock("@/db/client", () => ({ db: { select: h.dbSelect } }));
vi.mock("@/features/semantic-search/api", () => ({
  semanticSearch: h.semanticSearch,
}));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));

import {
  denseSceneRanking,
  fuseSceneCandidates,
  narrowCandidateScenes,
} from "./narrowing";

beforeEach(() => {
  vi.clearAllMocks();
  h.dbWhere.mockResolvedValue([]);
  h.semanticSearch.mockResolvedValue([]);
  h.invoke.mockResolvedValue([]);
});

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

  it("keeps a semantic-linked scene when dense and sparse return no hits", () => {
    const out = fuseSceneCandidates([], [], {
      semanticSceneIds: ["semantic-scene"],
    });
    expect(out).toEqual([
      expect.objectContaining({
        sceneId: "semantic-scene",
        matchedBy: ["semantic"],
      }),
    ]);
  });

  it("prioritizes semantic-linked scenes outside the inferred limit", () => {
    const out = fuseSceneCandidates(["dense-1", "dense-2"], [], {
      semanticSceneIds: ["semantic-scene"],
      limit: 2,
    });
    expect(out.map((candidate) => candidate.sceneId)).toEqual([
      "semantic-scene",
      "dense-1",
      "dense-2",
    ]);
  });

  it("retains explicit links outside the inferred candidate limit", () => {
    const inferred = Array.from({ length: 40 }, (_, index) => `dense-${index}`);
    const out = fuseSceneCandidates(inferred, [], {
      semanticSceneIds: ["explicit-1", "explicit-2"],
      limit: 30,
    });

    expect(out).toHaveLength(32);
    expect(out.slice(0, 2).map((candidate) => candidate.sceneId)).toEqual([
      "explicit-1",
      "explicit-2",
    ]);
    expect(
      out.filter((candidate) => !candidate.matchedBy.includes("semantic")),
    ).toHaveLength(30);
  });

  it("does not charge an inferred overlap twice against the limit", () => {
    const inferred = [
      "explicit",
      ...Array.from({ length: 35 }, (_, index) => `dense-${index}`),
    ];
    const out = fuseSceneCandidates(inferred, [], {
      semanticSceneIds: ["explicit"],
      limit: 30,
    });

    expect(out).toHaveLength(31);
    expect(new Set(out.map((candidate) => candidate.sceneId)).size).toBe(31);
    expect(out[0].sceneId).toBe("explicit");
  });

  it("dedupes a scene id repeated within one arm", () => {
    const out = fuseSceneCandidates(["s1", "s1", "s2"], []);
    expect(out.map((c) => c.sceneId)).toEqual(["s1", "s2"]);
  });

  it("returns [] when both arms empty", () => {
    expect(fuseSceneCandidates([], [])).toEqual([]);
  });
});

describe("narrowCandidateScenes", () => {
  it("returns semantic-linked scenes even when dense and sparse both miss", async () => {
    h.dbWhere.mockResolvedValue([{ sceneId: "semantic-scene" }]);

    const out = await narrowCandidateScenes("project-1", "entry-1", "", [], {
      limit: 1,
    });

    expect(out).toEqual([
      expect.objectContaining({
        sceneId: "semantic-scene",
        matchedBy: ["semantic"],
      }),
    ]);
  });
});
