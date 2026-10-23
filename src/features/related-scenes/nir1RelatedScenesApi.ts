import type {
  Nir1EvidenceQualifyResponse,
  RelatedScenesBeginRequest,
  RelatedScenesBeginResponse,
  RelatedScenesContinueResponse,
  RelatedScenesGraphSettle,
  RelatedScenesGraphSettleResponse,
  RelatedScenesGraphWaitResponse,
  RelatedScenesReleaseResponse,
} from "@/../electron/shared/relatedScenesSearchWire";
import { invoke, listen } from "@/lib/tauri";

export function beginRelatedScenes(
  request: RelatedScenesBeginRequest,
): Promise<RelatedScenesBeginResponse> {
  return invoke("related_scenes_begin", {
    expectedWorkspacePath: request.expectedWorkspacePath,
    projectId: request.projectId,
    currentSceneId: request.currentSceneId,
    query: request.query,
    // Absent unless the caller passes a seed: the non-Graph request is
    // byte-identical to the one before CP-3a.
    ...(request.graphSeedEntityId !== undefined
      ? { graphSeedEntityId: request.graphSeedEntityId }
      : {}),
  });
}

export function continueRelatedScenes(
  operationTicket: string,
): Promise<RelatedScenesContinueResponse> {
  return invoke("related_scenes_continue", { operationTicket });
}

/**
 * Await the Graph started by a seeded begin (same ticket as IR). The Scene IDs
 * are the renderer's Raw R; Native checks them against the dense hits it
 * returned. REQUEST_BYTES-class limits stay in Native (not duplicated here).
 */
export function continueRelatedScenesGraph(
  operationTicket: string,
  rawSceneIds: readonly string[],
): Promise<RelatedScenesGraphWaitResponse> {
  return invoke("related_scenes_graph_continue", {
    operationTicket,
    rawSceneIds: [...rawSceneIds],
  });
}

/** Declare what the renderer did with the Graph; carries no plaintext. */
export function settleRelatedScenesGraph(
  operationTicket: string,
  settle: RelatedScenesGraphSettle,
): Promise<RelatedScenesGraphSettleResponse> {
  return invoke("related_scenes_graph_continue", { operationTicket, settle });
}

export function releaseRelatedScenes(
  operationTicket: string,
): Promise<RelatedScenesReleaseResponse> {
  return invoke("related_scenes_release", { operationTicket });
}

export function qualifyNir1Evidence(
  navigationIdentity: string,
): Promise<Nir1EvidenceQualifyResponse> {
  return invoke("nir1_evidence_qualify", { navigationIdentity });
}

export function listenRelatedScenesInvalidations(
  receive: (queryBinding: string) => void,
): Promise<() => void> {
  return listen<{ queryBinding?: unknown }>(
    "related-scenes:invalidated",
    (payload) => {
      if (typeof payload?.queryBinding === "string" && payload.queryBinding)
        receive(payload.queryBinding);
    },
  );
}

export function listenRelatedScenesIndexReady(
  receive: (projectId: string) => void,
): Promise<() => void> {
  return listen<{ projectId?: unknown }>(
    "related-scenes:index-ready",
    (payload) => {
      if (typeof payload?.projectId === "string" && payload.projectId)
        receive(payload.projectId);
    },
  );
}

export function listenRelatedScenesGraphReady(
  receive: (projectId: string) => void,
): Promise<() => void> {
  return listen<{ projectId?: unknown }>(
    "related-scenes:graph-ready",
    (payload) => {
      if (typeof payload?.projectId === "string" && payload.projectId)
        receive(payload.projectId);
    },
  );
}
