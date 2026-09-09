import { describe, expect, it } from "vitest";
import { fuseNir1RelatedScenes } from "./nir1RelatedScenesFusion";
import type { Nir1AdmittedScene } from "./nir1RelatedScenesResult";
import {
  selectRelatedPastScenes,
  selectRelatedPastScenesWithAnchor,
  type RelatedScene,
  type RelatedSceneSelection,
} from "./selectRelatedScenes";

function raw(sceneId: string, score = 0.9): RelatedScene {
  return {
    sceneId,
    sceneTitle: `Raw ${sceneId}`,
    chunkText: `Raw excerpt ${sceneId}`,
    score,
  };
}

function ir(sceneId: string, irCosine = 0.9): Nir1AdmittedScene {
  return {
    sceneId,
    sceneTitle: `Admitted ${sceneId}`,
    irCosine,
    interpretation: {
      summary: `Interpretation ${sceneId}`,
      actuality: "rumored",
      attribution: "narrator",
      narrativeFrame: "story-world",
    },
    validatedEvidence: {
      excerpt: `Evidence ${sceneId}`,
      navigationIdentity: `opaque-${sceneId}`,
    },
    review: "human-approved",
    freshness: "fresh",
  };
}

const selection = (
  scenes: RelatedScene[],
  anchorSceneId: string | null = null,
): RelatedSceneSelection => ({ scenes, anchorSceneId });

describe("fuseNir1RelatedScenes", () => {
  it("keeps the exact Raw list and row objects when admitted IR is empty", () => {
    const scenes = [raw("b", 0.91), raw("a", 0.88)];
    const result = fuseNir1RelatedScenes(selection(scenes), {
      status: "available",
      scenes: [],
    });
    expect(result).toEqual({ kind: "raw", scenes, ir: { status: "empty" } });
    expect(result.scenes).toBe(scenes);
    expect(result.scenes[0]).toBe(scenes[0]);
  });

  it.each([
    "index-unavailable",
    "unsupported-query",
    "failed",
    "timeout",
    "cancelled",
    "invalidated",
  ] as const)(
    "keeps exact Raw membership/order/scores/excerpts when IR is %s",
    (reason) => {
      const scenes = [raw("z", 0.731), raw("a", 0.888)];
      const result = fuseNir1RelatedScenes(selection(scenes), {
        status: "unavailable",
        reason,
      });
      expect(result).toEqual({
        kind: "raw",
        scenes,
        ir: { status: "unavailable", reason },
      });
      expect(result.scenes).toBe(scenes);
      expect(JSON.stringify(result.scenes)).toBe(JSON.stringify(scenes));
    },
  );

  it("preserves every Raw rank and original row while attaching shared IR", () => {
    const scenes = [raw("a", 0.99), raw("b", 0.8), raw("c", 0.73)];
    const admitted = ir("c", 0.99);
    const result = fuseNir1RelatedScenes(selection(scenes), {
      status: "available",
      scenes: [admitted, ir("d"), ir("e")],
    });
    if (result.kind !== "fused") throw new Error("expected fused");
    expect(result.scenes.map((scene) => scene.sceneId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    for (const [index, row] of scenes.entries()) {
      const displayed = result.scenes[index];
      expect("raw" in displayed && displayed.raw).toBe(row);
      expect(displayed.rank1).toBe(index + 1);
      expect(displayed).not.toHaveProperty("rrfScore");
      expect(displayed).not.toHaveProperty("score");
    }
    expect(result.scenes[2]).toMatchObject({ kind: "raw-ir", ir: admitted });
    expect(result.scenes[3]).toMatchObject({ kind: "ir", rank1: 4 });
  });

  it("returns only the backend's highest representative when Raw is empty", () => {
    const first = ir("z", 0.9);
    const result = fuseNir1RelatedScenes(selection([]), {
      status: "available",
      scenes: [first, ir("a", 1), ir("b")],
    });
    expect(result.scenes).toEqual([
      {
        kind: "ir",
        sceneId: "z",
        sceneTitle: first.sceneTitle,
        rank1: 1,
        ir: first,
      },
    ]);
  });

  it("preserves Raw title/excerpt and keeps IR Evidence separate", () => {
    const rawScene = raw("a");
    const admitted = ir("a");
    const result = fuseNir1RelatedScenes(selection([rawScene]), {
      status: "available",
      scenes: [admitted, ir("b")],
    });
    if (result.kind !== "fused") throw new Error("expected fused");
    expect(result.scenes[0]).toMatchObject({
      kind: "raw-ir",
      sceneTitle: rawScene.sceneTitle,
      raw: rawScene,
      ir: admitted,
    });
    expect(result.scenes[1]).toMatchObject({
      kind: "ir",
      sceneTitle: "Admitted b",
      ir: { validatedEvidence: { excerpt: "Evidence b" } },
    });
    expect(result.scenes[1]).not.toHaveProperty("raw");
    expect(result.scenes[1]).not.toHaveProperty("chunkText");
  });

  it("keeps the first backend representative and appends at most one IR-only scene", () => {
    const scenes = [raw("a"), raw("b")];
    const first = ir("c", 0.95);
    const shared = ir("b", 0.8);
    const result = fuseNir1RelatedScenes(selection(scenes), {
      status: "available",
      scenes: [first, ir("c", 1), shared, ir("b", 1), ir("d")],
    });
    if (result.kind !== "fused") throw new Error("expected fused");
    expect(result.scenes.map((scene) => scene.sceneId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.scenes[1]).toMatchObject({ kind: "raw-ir", ir: shared });
    expect(result.scenes[2]).toMatchObject({ kind: "ir", ir: first });
  });

  it("keeps Raw order regardless of the selector anchor or IR rank", () => {
    const scenes = [raw("z", 0.99), raw("a", 0.9)];
    for (const anchor of [null, "z", "a", "outside"]) {
      const result = fuseNir1RelatedScenes(selection(scenes, anchor), {
        status: "available",
        scenes: [ir("a"), ir("z")],
      });
      expect(result.scenes.map((scene) => scene.sceneId)).toEqual(["z", "a"]);
    }
  });

  it("does not copy opaque failure details into the public safe result", () => {
    const scenes = [raw("a")];
    const result = fuseNir1RelatedScenes(selection(scenes), {
      status: "unavailable",
      reason: "private source filename",
      detail: "private rejected excerpt",
    } as never);
    expect(result).toEqual({
      kind: "raw",
      scenes,
      ir: { status: "unavailable", reason: "invalid-response" },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("keeps all eight Raw scenes even when no IR scene overlaps", () => {
    const scenes = Array.from({ length: 8 }, (_, i) => raw(`r${i}`));
    const result = fuseNir1RelatedScenes(selection(scenes, "r0"), {
      status: "available",
      scenes: Array.from({ length: 8 }, (_, i) => ir(`i${i}`)),
    });
    expect(result.scenes.map((scene) => scene.sceneId)).toEqual(
      scenes.map((scene) => scene.sceneId),
    );
    if (result.kind !== "fused") throw new Error("expected fused");
    expect(result.scenes.every((scene) => scene.kind === "raw")).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects a nonfinite admitted score with exact Raw fallback: %s",
    (irCosine) => {
      const scenes = [raw("a")];
      const result = fuseNir1RelatedScenes(selection(scenes), {
        status: "available",
        scenes: [ir("b", irCosine), ir("c")],
      });
      expect(result).toEqual({
        kind: "raw",
        scenes,
        ir: { status: "unavailable", reason: "invalid-response" },
      });
      expect(result.scenes).toBe(scenes);
    },
  );
});

describe("Raw selector anchor provenance", () => {
  const hits = [
    { ...raw("winner", 0.95), charStart: 30, charEnd: 50, dialogueRatio: 0 },
    { ...raw("rescued", 0.76), charStart: 0, charEnd: 20, dialogueRatio: 0 },
    { ...raw("other", 0.85), charStart: 0, charEnd: 20, dialogueRatio: 0 },
  ];
  const options = {
    currentSceneId: "current",
    sceneOrder: new Map(
      ["winner", "rescued", "other", "current"].map((id, i) => [id, i]),
    ),
    minScore: 0.8,
    maxScenes: 8,
  };

  it.each([
    {},
    { sparseSceneIds: ["rescued", "other"] },
    { relativeRescue: { gap: 0.05 } },
    { sparseSceneIds: ["rescued"], relativeRescue: { gap: 0.05 } },
    { maxScenes: 0 },
    { currentSceneId: null },
  ])("preserves the existing public Raw result: %j", (variation) => {
    const opts = { ...options, ...variation };
    expect(selectRelatedPastScenesWithAnchor(hits, opts).scenes).toEqual(
      selectRelatedPastScenes(hits, opts),
    );
  });

  it("reports an anchor only when the existing hybrid selector anchors a retained confident winner", () => {
    expect(
      selectRelatedPastScenesWithAnchor(hits, options).anchorSceneId,
    ).toBeNull();
    expect(
      selectRelatedPastScenesWithAnchor(hits, {
        ...options,
        sparseSceneIds: ["rescued"],
      }).anchorSceneId,
    ).toBe("winner");
    expect(
      selectRelatedPastScenesWithAnchor(hits, {
        ...options,
        relativeRescue: { gap: 0.05 },
      }).anchorSceneId,
    ).toBe("winner");
    expect(
      selectRelatedPastScenesWithAnchor(hits, {
        ...options,
        sparseSceneIds: ["rescued"],
        maxScenes: 0,
      }).anchorSceneId,
    ).toBeNull();
    expect(
      selectRelatedPastScenesWithAnchor(
        hits.filter((hit) => hit.sceneId === "rescued"),
        { ...options, sparseSceneIds: ["rescued"] },
      ).anchorSceneId,
    ).toBeNull();
  });
});
