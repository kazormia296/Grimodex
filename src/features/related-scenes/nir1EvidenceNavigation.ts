import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import {
  getCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  getCurrentWorkspaceIdentity,
  subscribeCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { qualifyNir1Evidence } from "./nir1RelatedScenesApi";
import {
  createNir1EvidenceNavigationState,
  type Nir1EvidenceNavigationRequest,
  type Nir1EvidenceOrigin,
} from "./nir1EvidenceNavigationState";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";
import type { Nir1RelatedScenesLease } from "./nir1RelatedScenesSession";

const navigation = createNir1EvidenceNavigationState();
interface PendingEvidence {
  readonly request: Nir1EvidenceNavigationRequest;
  readonly identity: string;
  readonly queryBinding: string;
  readonly lease: Nir1RelatedScenesLease;
  accepted: boolean;
  claimed: boolean;
  targetObserved: boolean;
  cleanup: () => void;
}
let pending: PendingEvidence | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function cancelNir1EvidenceNavigation(): void {
  const previous = pending;
  pending = null;
  navigation.invalidate();
  previous?.cleanup();
  previous?.lease.release();
  notify();
}

function context(origin: Nir1EvidenceOrigin): Nir1EvidenceOrigin | null {
  const workspace = getCurrentWorkspaceIdentity();
  if (!workspace) return null;
  return {
    workspacePath: workspace.path,
    openRevision: workspace.openRevision,
    projectId: getCurrentProjectId(),
    querySceneId: useTreeStore.getState().activeSceneId ?? "",
    queryGeneration: origin.queryGeneration,
  };
}

function matchesContext(item: PendingEvidence): boolean {
  const current = context(item.request.origin);
  const origin = item.request.origin;
  return Boolean(
    current &&
    item.lease.isActive() &&
    current.workspacePath === origin.workspacePath &&
    current.openRevision === origin.openRevision &&
    current.projectId === origin.projectId &&
    ((!item.targetObserved && current.querySceneId === origin.querySceneId) ||
      (item.accepted && current.querySceneId === item.request.targetSceneId)),
  );
}

/** A new S1 fetch caused by this navigation keeps the original S2 lease. */
export function observeNir1RelatedScenesQuery(sceneId: string): void {
  if (
    pending &&
    !(pending.accepted && sceneId === pending.request.targetSceneId)
  )
    cancelNir1EvidenceNavigation();
}

export function hasPendingNir1EvidenceNavigation(sceneId: string): boolean {
  return Boolean(
    pending?.accepted &&
    pending.request.targetSceneId === sceneId &&
    matchesContext(pending),
  );
}

export function subscribeNir1EvidenceNavigation(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Both editor load and already-loaded editor paths use this single claim. */
export function claimNir1EvidenceNavigation(sceneId: string) {
  const item = pending;
  if (!item || item.claimed || !hasPendingNir1EvidenceNavigation(sceneId))
    return null;
  const current = context(item.request.origin);
  if (!current) return null;
  const accepted = navigation.consume(current);
  if (!accepted) return null;
  item.claimed = true;
  return {
    identity: item.identity,
    queryBinding: item.queryBinding,
    sceneId,
    isCurrent: () => pending === item && matchesContext(item),
    finish: () => {
      if (pending === item) cancelNir1EvidenceNavigation();
    },
  };
}

export async function requestNir1EvidenceNavigation(
  fetch: Nir1RelatedScenesFetchResult,
  sceneId: string,
  identity: string,
): Promise<boolean> {
  cancelNir1EvidenceNavigation();
  if (
    !fetch.origin ||
    !fetch.queryBinding ||
    !fetch.session?.isActive() ||
    !useTreeStore.getState().nodes.some((node) => node.id === sceneId)
  )
    return false;
  const lease = fetch.session.retain();
  if (!lease) return false;
  const item: PendingEvidence = {
    request: navigation.begin(fetch.origin, sceneId),
    identity,
    queryBinding: fetch.queryBinding,
    lease,
    accepted: false,
    claimed: false,
    targetObserved: false,
    cleanup: () => {},
  };
  pending = item;
  const mode = usePhaseStore.getState().resolutionMode;
  const observe = () => {
    if (pending !== item) return;
    if (
      item.accepted &&
      useTreeStore.getState().activeSceneId === item.request.targetSceneId
    ) {
      item.targetObserved = true;
    }
    if (
      !matchesContext(item) ||
      usePhaseStore.getState().resolutionMode !== mode
    )
      cancelNir1EvidenceNavigation();
    else {
      const current = context(item.request.origin);
      if (current) navigation.observeContext(current);
    }
  };
  const cleanup = [
    useTreeStore.subscribe(observe),
    useProjectStore.subscribe(observe),
    usePhaseStore.subscribe(observe),
    subscribeCurrentWorkspaceIdentity(observe),
    fetch.session.subscribeInvalidation(() => cancelNir1EvidenceNavigation()),
  ];
  item.cleanup = () => {
    for (const release of cleanup) release();
  };
  if (pending !== item) {
    item.cleanup();
    return false;
  }
  try {
    observe();
    if (pending !== item) return false;
    const qualified = await qualifyNir1Evidence(identity);
    if (
      pending !== item ||
      !matchesContext(item) ||
      qualified.status !== "qualified" ||
      qualified.sceneId !== sceneId ||
      qualified.queryBinding !== item.queryBinding ||
      qualified.bindingKey !== identity ||
      !navigation.qualify(item.request, qualified.bindingKey)
    )
      return false;
    openEditorDocument(
      {
        target: { kind: "scene", documentId: sceneId },
        mode: "pinned",
        revealEditor: true,
        focusEditor: false,
        syncSceneContext: true,
      },
      {
        ...defaultEditorNavigationPorts,
        isNavigationBlocked(command) {
          if (defaultEditorNavigationPorts.isNavigationBlocked?.(command))
            return true;
          item.accepted = navigation.navigationAccepted(item.request);
          return !item.accepted;
        },
      },
    );
    if (!item.accepted || !matchesContext(item)) {
      item.accepted = false;
      return false;
    }
    notify();
    return true;
  } catch {
    if (pending === item) cancelNir1EvidenceNavigation();
    return false;
  } finally {
    if (pending === item && !item.accepted) cancelNir1EvidenceNavigation();
  }
}
