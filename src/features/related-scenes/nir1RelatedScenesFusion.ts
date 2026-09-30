import rankingPolicy from "../../../policies/narrative/nir1-related-scenes-ranking.json";
import type { RelatedSceneSelection } from "./selectRelatedScenes";
import {
  nir1SafeUnavailableReason,
  type Nir1AdmittedScene,
  type Nir1FusedScene,
  type Nir1RelatedScenesIr,
  type Nir1RelatedScenesResult,
} from "./nir1RelatedScenesResult";

/** Preserves completed Raw R and appends at most one backend-admitted scene. */
export function fuseNir1RelatedScenes(
  raw: RelatedSceneSelection,
  ir: Nir1RelatedScenesIr,
): Nir1RelatedScenesResult {
  if (ir.status === "unavailable") {
    return {
      kind: "raw",
      scenes: raw.scenes,
      ir: {
        status: "unavailable",
        reason: nir1SafeUnavailableReason(ir.reason),
      },
    };
  }
  if (ir.scenes.length === 0)
    return { kind: "raw", scenes: raw.scenes, ir: { status: "empty" } };
  // Malformed scores invalidate the response, not individual candidates. No
  // renderer filtering/reranking can substitute for backend pre-admission.
  if (ir.scenes.some((scene) => !Number.isFinite(scene.irCosine))) {
    return {
      kind: "raw",
      scenes: raw.scenes,
      ir: { status: "unavailable", reason: "invalid-response" },
    };
  }

  // The backend has already applied admission, scene-max, deterministic ties
  // and top-8. Keep its first representative; do not re-score in the renderer.
  const admitted = new Map<string, Nir1AdmittedScene>();
  for (const scene of ir.scenes) {
    if (!admitted.has(scene.sceneId)) admitted.set(scene.sceneId, scene);
  }
  const rawIds = new Set(raw.scenes.map((scene) => scene.sceneId));
  const scenes: Nir1FusedScene[] = raw.scenes.map((scene, index) => {
    const rank = {
      sceneId: scene.sceneId,
      sceneTitle: scene.sceneTitle,
      rank1: index + 1,
    };
    const shared = admitted.get(scene.sceneId);
    return shared
      ? { ...rank, kind: "raw-ir", raw: scene, ir: shared }
      : { ...rank, kind: "raw", raw: scene };
  });
  if (scenes.length < rankingPolicy.fusion.maxScenes) {
    const supplement = [...admitted.values()].find(
      (scene) => !rawIds.has(scene.sceneId),
    );
    if (supplement)
      scenes.push({
        kind: "ir",
        sceneId: supplement.sceneId,
        sceneTitle: supplement.sceneTitle,
        rank1: scenes.length + 1,
        ir: supplement,
      });
  }
  return { kind: "fused", scenes, ir: { status: "available" } };
}
