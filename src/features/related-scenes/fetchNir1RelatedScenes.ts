import { loadSceneContent } from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import { semanticSearch } from "@/features/semantic-search/api";
import {
  buildSemanticRecallQuery,
  fetchSparseSceneIds,
  recallParamsForLang,
  SEMANTIC_RECALL_RESCUE_MARGIN,
} from "@/features/chat/semanticRecall";
import { computeSceneTimeIndex } from "@/features/codex/phaseResolver";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  getCurrentProjectId,
  getCurrentProjectLanguage,
} from "@/features/project/projectStore";
import {
  getCurrentWorkspaceIdentity,
  isCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { debugLog } from "@/lib/debugLog";
import {
  selectRelatedPastScenesWithAnchor,
  type RelatedSceneSelection,
} from "./selectRelatedScenes";
import {
  beginRelatedScenes,
  continueRelatedScenes,
} from "./nir1RelatedScenesApi";
import { createNir1RelatedScenesSession } from "./nir1RelatedScenesSession";
import {
  projectNir1RelatedScenesIr,
  projectNir1UnavailableReason,
} from "./nir1RelatedScenesProjection";
import { fuseNir1RelatedScenes } from "./nir1RelatedScenesFusion";
import { awaitNir1RelatedScenes } from "./awaitNir1RelatedScenes";
import type {
  Nir1RelatedScenesFetchOptions,
  Nir1RelatedScenesFetchResult,
} from "./nir1RelatedScenesFetchTypes";
import type {
  Nir1RelatedScenesIr,
  Nir1IrUnavailableReason,
} from "./nir1RelatedScenesResult";
import type { Nir1InitialUsabilitySnapshot } from "./nir1RelatedScenesDeadline";
import {
  RELATED_SCENES_FETCH_LIMIT,
  RELATED_SCENES_MAX,
  RELATED_SCENES_RELATIVE_GAP,
} from "./relatedScenesConfig";
import { buildSparseQuery } from "./seedTerms";

let nextQueryGeneration = 0;

export async function fetchNir1RelatedPastScenes(
  sceneId: string,
  options: Nir1RelatedScenesFetchOptions,
): Promise<Nir1RelatedScenesFetchResult> {
  const tFetchMs = performance.now();
  const workspace = getCurrentWorkspaceIdentity();
  const projectId = getCurrentProjectId();
  const language = getCurrentProjectLanguage();
  const mode = usePhaseStore.getState().resolutionMode;
  const activeSceneId = useTreeStore.getState().activeSceneId;
  const queryGeneration = options.queryGeneration ?? ++nextQueryGeneration;
  const origin = workspace
    ? Object.freeze({
        workspacePath: workspace.path,
        openRevision: workspace.openRevision,
        projectId,
        querySceneId: sceneId,
        queryGeneration,
      })
    : null;
  const session =
    workspace && projectId && sceneId
      ? createNir1RelatedScenesSession(projectId, options.signal)
      : null;
  let nodesAtBegin: ReturnType<typeof useTreeStore.getState>["nodes"] | null =
    null;
  let queryBinding: string | null = null;
  let initialSnapshot: Nir1InitialUsabilitySnapshot | null = null;
  let raw: RelatedSceneSelection = { scenes: [], anchorSceneId: null };
  let rawStatus: Nir1RelatedScenesFetchResult["rawStatus"] = "not-started";
  let tRawReadyMs: number | null = null;
  let nativeTiming: Nir1RelatedScenesFetchResult["timing"]["native"];
  const isCurrent = () =>
    Boolean(
      workspace &&
      isCurrentWorkspaceIdentity(workspace) &&
      projectId === getCurrentProjectId() &&
      language === getCurrentProjectLanguage() &&
      mode === usePhaseStore.getState().resolutionMode &&
      activeSceneId === useTreeStore.getState().activeSceneId &&
      (nodesAtBegin === null ||
        nodesAtBegin === useTreeStore.getState().nodes) &&
      (options.isCurrent?.() ?? true),
    );
  const stopIfContextChanged = () => {
    const current = isCurrent();
    if (!current) session?.invalidate();
    return !current || options.signal?.aborted === true;
  };

  function output(
    status: Nir1RelatedScenesFetchResult["status"],
    reason: Nir1IrUnavailableReason,
    completed?: Pick<Nir1RelatedScenesFetchResult, "result" | "completion">,
  ): Nir1RelatedScenesFetchResult {
    const result =
      completed?.result ??
      fuseNir1RelatedScenes(raw, { status: "unavailable", reason });
    session?.completeFetch();
    if (result.kind === "raw") session?.releaseOperation();
    if (status !== "completed" || rawStatus !== "completed") session?.release();
    return {
      status,
      rawStatus,
      origin,
      queryBinding,
      initialSnapshot,
      completion: completed?.completion ?? null,
      rawScenes: raw.scenes,
      result,
      session,
      timing: {
        tFetchMs,
        tRawReadyMs,
        tReturnMs: performance.now(),
        ...(nativeTiming ? { native: nativeTiming } : {}),
      },
    };
  }

  if (!session || !workspace) return output("failed", "index-unavailable");
  if (options.signal?.aborted) return output("cancelled", "cancelled");
  const connected = session.connect();
  try {
    // This exact existing Raw pipeline includes loadSceneContent's pending
    // source-write barrier. Native independently checks the same saved query.
    const json = await loadSceneContent(sceneId);
    if (stopIfContextChanged()) return output("cancelled", "invalidated");
    const body = prosemirrorToText(json ?? "");
    const query = buildSemanticRecallQuery({
      userMessage: "",
      sceneBody: body,
    });
    if (!query.trim()) {
      rawStatus = "completed";
      tRawReadyMs = performance.now();
      session.release();
      return output("completed", "unsupported-query");
    }
    const listening = await connected;
    if (stopIfContextChanged()) return output("cancelled", "invalidated");
    if (listening && !session.isActive())
      return output("cancelled", "invalidated");
    nodesAtBegin = useTreeStore.getState().nodes;
    const params = recallParamsForLang(language);
    const selectionOptions = {
      currentSceneId: sceneId,
      sceneOrder: computeSceneTimeIndex(nodesAtBegin, mode),
      minScore: params.gateScore,
      maxScenes: RELATED_SCENES_MAX,
      rescueMargin: SEMANTIC_RECALL_RESCUE_MARGIN,
      relativeRescue: { gap: RELATED_SCENES_RELATIVE_GAP },
    };
    const sparse = fetchSparseSceneIds({
      projectId,
      query: buildSparseQuery(query, body),
    }).catch(() => {
      debugLog.warn(
        "RelatedScenes",
        "sparse search failed (dense-only fallback)",
      );
      return [] as string[];
    });
    if (!listening) {
      if (session.stopReason !== "listener-unavailable")
        return output("cancelled", "invalidated");
      const denseHits = await semanticSearch({
        projectId,
        query,
        limit: RELATED_SCENES_FETCH_LIMIT,
      });
      raw = selectRelatedPastScenesWithAnchor(denseHits, {
        ...selectionOptions,
        sparseSceneIds: await sparse,
      });
      rawStatus = "completed";
      tRawReadyMs = performance.now();
      return output(
        stopIfContextChanged() ? "cancelled" : "completed",
        "failed",
      );
    }
    const response = await beginRelatedScenes({
      expectedWorkspacePath: workspace.path,
      projectId,
      currentSceneId: sceneId,
      query,
    });
    if (
      response.timing?.clock === "native-monotonic" &&
      Number.isFinite(response.timing.firstSnapshotElapsedMs) &&
      response.timing.firstSnapshotElapsedMs >= 0 &&
      Number.isFinite(response.timing.rawReadyElapsedMs) &&
      response.timing.rawReadyElapsedMs >=
        response.timing.firstSnapshotElapsedMs
    )
      nativeTiming = response.timing;
    queryBinding = response.snapshot.queryBinding;
    initialSnapshot = Object.freeze({
      indexUsable: response.snapshot.originalSnapshotUsable,
      querySupported: response.snapshot.supportedProfile,
    });
    const operationTicket =
      response.ir.status === "pending" ? response.ir.operationTicket : null;
    const bound = session.bind(queryBinding, operationTicket);
    const contextCancelled = stopIfContextChanged();
    // Begin already starts IR work; continue only awaits it. Subscribe before
    // sparse completes so the renderer can receive IR while Raw R is forming.
    const ir: Promise<Nir1RelatedScenesIr> =
      bound && !contextCancelled && operationTicket
        ? continueRelatedScenes(operationTicket)
            .then((value) => projectNir1RelatedScenesIr(value, queryBinding!))
            .catch(() => ({ status: "unavailable", reason: "failed" }))
        : Promise.resolve({
            status: "unavailable",
            reason:
              response.ir.status === "unavailable"
                ? projectNir1UnavailableReason(response.ir.reason)
                : "invalidated",
          });
    const sparseSceneIds = await sparse;
    raw = selectRelatedPastScenesWithAnchor(
      response.denseHits.map((hit) => ({ ...hit })),
      { ...selectionOptions, sparseSceneIds },
    );
    rawStatus = "completed";
    tRawReadyMs = performance.now();
    stopIfContextChanged();
    const completed = await awaitNir1RelatedScenes({
      raw,
      rawReadyAtMs: tRawReadyMs,
      snapshot: initialSnapshot,
      ir,
      session,
      isCurrent,
    });
    return output(completed.status, "failed", completed);
  } catch {
    rawStatus = "failed";
    debugLog.warn("RelatedScenes", "Related Scenes query failed");
    session.release();
    return output(
      stopIfContextChanged() || options.signal?.aborted
        ? "cancelled"
        : "failed",
      "failed",
    );
  }
}
