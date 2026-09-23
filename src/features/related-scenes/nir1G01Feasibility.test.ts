import { describe, expect, it } from "vitest";
import fixture from "../../../evals/nir1-g01/fixture.v1.json";
import { scoreQuery } from "../../../scripts/quality/nir1-retrieval/contract.mjs";
import { fuseNir1RelatedScenes } from "./nir1RelatedScenesFusion";
import type { Nir1AdmittedScene } from "./nir1RelatedScenesResult";
import type {
  RelatedScene,
  RelatedSceneSelection,
} from "./selectRelatedScenes";

type G01Fixture = typeof fixture;

const g01 = fixture as G01Fixture;

function rawScene(sceneId: string): RelatedScene {
  const scene = g01.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw new Error(`missing G-01 scene: ${sceneId}`);
  return {
    sceneId: scene.id,
    sceneTitle: scene.title,
    chunkText: scene.body,
    score: 0.9,
  };
}

function irScene(sceneId: string): Nir1AdmittedScene {
  const scene = g01.scenes.find((candidate) => candidate.id === sceneId);
  const interpretation = g01.qualifiedIr.find(
    (candidate) => candidate.sceneId === sceneId,
  );
  if (!scene || !interpretation) {
    throw new Error(`missing G-01 IR scene: ${sceneId}`);
  }
  return {
    sceneId: scene.id,
    sceneTitle: scene.title,
    // This is a boundary-row sentinel. It is deliberately not treated as a
    // model measurement; the runtime score is a separate prerequisite.
    irCosine: 1,
    interpretation: {
      summary: interpretation.summary,
      actuality: interpretation.actuality,
      attribution: interpretation.attribution,
      narrativeFrame: interpretation.narrativeFrame,
    },
    validatedEvidence: {
      excerpt: interpretation.summary,
      navigationIdentity: `g01-boundary:${scene.id}`,
    },
    review: "human-approved",
    freshness: "fresh",
  };
}

function selection(scenes: RelatedScene[]): RelatedSceneSelection {
  return { scenes, anchorSceneId: null };
}

function scoreRows(sceneIds: string[]) {
  return scoreQuery(
    {
      eligibleSceneIds: g01.eligibleSceneIds,
      relevanceGrades: Object.fromEntries(
        g01.scenes.map((scene) => [scene.id, scene.gold]),
      ),
      requiredRawPassages: [],
    },
    sceneIds.map((sceneId) => rawScene(sceneId)),
  );
}

describe("G-01 fixed fixture feasibility baseline", () => {
  it("keeps the predeclared fixture and Gold independent of observed output", () => {
    expect(g01.fixtureId).toBe("nir1-g01-explicit-pin-design/1");
    expect(g01.status).toBe("predeclared-design-fixture");
    expect(g01.query.body).toBe(
      "Which earlier scene contains the key recipient identified by the selected courier's handover?",
    );
    expect(g01.scenes.map((scene) => scene.id)).toEqual([
      "g01-review",
      "g01-weather",
      "g01-mira",
      "g01-question",
    ]);
    expect(g01.scenes.map((scene) => scene.gold)).toEqual([0, 0, 3, 0]);
    expect(g01.entitySeed.manualSeed).toBe(true);
    expect(g01.relation.authorDeclared).toBe(true);
    expect(g01.pins).toEqual([
      {
        sceneId: "g01-mira",
        entryId: "g01-mira-entity",
        source: "scene_codex_pins",
      },
    ]);
    expect(g01.expectations.graphPath).toEqual({
      seedEntityId: "g01-orin",
      edgeId: "g01-handover",
      targetEntityId: "g01-mira-entity",
      sceneId: "g01-mira",
      hop: 1,
    });
    expect(g01.expectations.sceneExcerpt.canonicalUtf16Range).toEqual({
      start: 0,
      end: [...g01.expectations.sceneExcerpt.body].length,
    });
  });

  it("runs the R+IR boundary baseline through the actual fusion and scorer", () => {
    const raw = selection([rawScene("g01-question")]);
    const fused = fuseNir1RelatedScenes(raw, {
      status: "available",
      scenes: [irScene("g01-question")],
    });
    expect(fused.kind).toBe("fused");
    expect(fused.scenes.map((scene) => scene.sceneId)).toEqual(
      g01.expectations.rPlusIr,
    );
    expect(scoreRows(g01.expectations.raw)).toMatchObject(
      g01.expectations.metrics.raw,
    );
    expect(scoreRows(g01.expectations.rPlusIr)).toMatchObject(
      g01.expectations.metrics.rPlusIr,
    );
  });

  it("confirms the predeclared one-slot arithmetic without claiming Graph runtime", () => {
    const projected = scoreRows(g01.expectations.rPlusIrPlusGraph);
    expect(projected.recallAt8).toBe(
      g01.expectations.metrics.rPlusIrPlusGraph.recallAt8,
    );
    expect(projected.ndcgAt8).toBeCloseTo(
      g01.expectations.metrics.rPlusIrPlusGraph.ndcgAt8,
      12,
    );
    expect(projected).toMatchObject({
      top1SceneId: "g01-question",
      relevantRank: 2,
    });
  });
});
