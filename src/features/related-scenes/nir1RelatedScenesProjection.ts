import type {
  RelatedScenesContinueResponse,
  RelatedScenesUnavailableReason,
} from "@/../electron/shared/relatedScenesSearchWire";
import {
  nir1SafeUnavailableReason,
  type Nir1AdmittedScene,
  type Nir1IrUnavailableReason,
  type Nir1RelatedScenesIr,
} from "./nir1RelatedScenesResult";

export function projectNir1UnavailableReason(
  reason: RelatedScenesUnavailableReason,
): Nir1IrUnavailableReason {
  if (reason === "expired") return "invalidated";
  if (reason === "capacity") return "failed";
  return nir1SafeUnavailableReason(reason);
}

/** Copy only admitted display fields; no envelope/material/diagnostic spread. */
export function projectNir1RelatedScenesIr(
  response: RelatedScenesContinueResponse,
  queryBinding: string,
): Nir1RelatedScenesIr {
  if (response.status === "unavailable") {
    return {
      status: "unavailable",
      reason: projectNir1UnavailableReason(response.reason),
    };
  }
  if (
    response.status !== "available" ||
    response.queryBinding !== queryBinding ||
    !Array.isArray(response.scenes)
  )
    return { status: "unavailable", reason: "invalid-response" };
  const scenes: Nir1AdmittedScene[] = [];
  for (const scene of response.scenes) {
    const interpretation = scene?.interpretation;
    const evidence = scene?.validatedEvidence;
    if (
      typeof scene?.sceneId !== "string" ||
      !scene.sceneId ||
      typeof scene.sceneTitle !== "string" ||
      !Number.isFinite(scene.irCosine) ||
      scene.review !== "human-approved" ||
      scene.freshness !== "fresh" ||
      typeof interpretation?.summary !== "string" ||
      typeof interpretation.actuality !== "string" ||
      typeof interpretation.attribution !== "string" ||
      typeof interpretation.narrativeFrame !== "string" ||
      typeof evidence?.excerpt !== "string" ||
      typeof evidence.navigationIdentity !== "string" ||
      !evidence.navigationIdentity
    )
      return { status: "unavailable", reason: "invalid-response" };
    scenes.push({
      sceneId: scene.sceneId,
      sceneTitle: scene.sceneTitle,
      irCosine: scene.irCosine,
      interpretation: {
        summary: interpretation.summary,
        actuality: interpretation.actuality,
        attribution: interpretation.attribution,
        narrativeFrame: interpretation.narrativeFrame,
      },
      validatedEvidence: {
        excerpt: evidence.excerpt,
        navigationIdentity: evidence.navigationIdentity,
      },
      review: scene.review,
      freshness: scene.freshness,
    });
  }
  return { status: "available", scenes };
}
