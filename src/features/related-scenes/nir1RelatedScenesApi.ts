import type {
  Nir1EvidenceQualifyResponse,
  RelatedScenesBeginRequest,
  RelatedScenesBeginResponse,
  RelatedScenesContinueResponse,
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
  });
}

export function continueRelatedScenes(
  operationTicket: string,
): Promise<RelatedScenesContinueResponse> {
  return invoke("related_scenes_continue", { operationTicket });
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
