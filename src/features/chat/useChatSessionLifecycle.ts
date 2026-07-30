import { useEffect, useReducer } from "react";
import { useChatStore } from "./chatStore";
import { resolveScopeSessionKey, type ChatScope } from "./chatScope";
import { markEnd, markStart } from "@/lib/perfLog";
import { subscribeQuiescenceLease } from "@/application/lifecycle/quiescenceLease";

export interface ChatSessionLifecycleOptions {
  isActive: boolean;
  treeActiveSceneId: string | null;
  chatScope: ChatScope;
  scopeAnchorId: string | null;
  activeSessionId: string | null;
  includeBodies: boolean;
  includeMapBoard: boolean;
  mapBoardId: string | null;
  agentMode: boolean;
  ragEnabled: boolean;
  routeAuthorityKey: string;
  provider: string | null | undefined;
  currentModel: string;
  allCodexEntries: readonly unknown[];
  loadAiSettings(): void;
  setActiveSceneId(sceneId: string | null): void;
  loadSessions(
    nodeId: string | null | undefined,
    codexAnchorId: string | null | undefined,
    snippetAnchorId: string | null | undefined,
  ): Promise<boolean>;
  selectSession(sessionId: string | null): Promise<void>;
  refreshContextLayers(): Promise<unknown>;
}

/** Owns Chat's scene/scope lifecycle and prevents hidden panels from doing stale work. */
export function useChatSessionLifecycle({
  isActive,
  treeActiveSceneId,
  chatScope,
  scopeAnchorId,
  activeSessionId,
  includeBodies,
  includeMapBoard,
  mapBoardId,
  agentMode,
  ragEnabled,
  routeAuthorityKey,
  provider,
  currentModel,
  allCodexEntries,
  loadAiSettings,
  setActiveSceneId,
  loadSessions,
  selectSession,
  refreshContextLayers,
}: ChatSessionLifecycleOptions): void {
  const [authorityResumeRevision, notifyAuthorityResumed] = useReducer(
    (revision: number) => revision + 1,
    0,
  );

  useEffect(() => {
    loadAiSettings();
  }, [loadAiSettings]);

  useEffect(
    () =>
      subscribeQuiescenceLease((change) => {
        if (
          !change.active &&
          change.releaseDisposition !== "renderer-teardown"
        ) {
          notifyAuthorityResumed();
        }
      }),
    [],
  );

  useEffect(() => {
    markStart("chatPanel.mirrorEffect");
    try {
      setActiveSceneId(treeActiveSceneId);
    } finally {
      markEnd("chatPanel.mirrorEffect");
    }
  }, [treeActiveSceneId, setActiveSceneId]);

  useEffect(() => {
    if (!isActive) return;
    if (chatScope === "scene" && !treeActiveSceneId) return;
    let stale = false;
    const {
      nodeId: effectiveNodeId,
      codexAnchorId,
      snippetAnchorId,
    } = resolveScopeSessionKey(chatScope, treeActiveSceneId, scopeAnchorId);
    (async () => {
      markStart("chatPanel.loadSessions");
      let loaded: boolean;
      try {
        loaded = await loadSessions(
          effectiveNodeId,
          codexAnchorId,
          snippetAnchorId,
        );
      } finally {
        markEnd("chatPanel.loadSessions");
      }
      if (stale || !loaded) return;
      const { sessions, activeSessionId: currentActiveSessionId } =
        useChatStore.getState();
      const targetSessionId =
        currentActiveSessionId &&
        sessions.some((session) => session.id === currentActiveSessionId)
          ? currentActiveSessionId
          : (sessions[0]?.id ?? null);
      if (
        targetSessionId === null ||
        targetSessionId === currentActiveSessionId
      ) {
        return;
      }
      markStart("chatPanel.selectSessionAfterLoad");
      try {
        await selectSession(targetSessionId);
      } finally {
        markEnd("chatPanel.selectSessionAfterLoad");
      }
    })();
    return () => {
      stale = true;
    };
  }, [
    isActive,
    treeActiveSceneId,
    chatScope,
    scopeAnchorId,
    authorityResumeRevision,
    loadSessions,
    selectSession,
  ]);

  useEffect(() => {
    if (!isActive) return;
    void refreshContextLayers();
  }, [
    isActive,
    treeActiveSceneId,
    activeSessionId,
    chatScope,
    scopeAnchorId,
    includeBodies,
    agentMode,
    ragEnabled,
    routeAuthorityKey,
    provider,
    currentModel,
    includeMapBoard,
    mapBoardId,
    allCodexEntries,
    refreshContextLayers,
  ]);
}
