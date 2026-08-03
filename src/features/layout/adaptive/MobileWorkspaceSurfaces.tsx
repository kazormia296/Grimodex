import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useChatStore } from "@/features/chat/chatStore";
import {
  resolveScopeSessionKey,
  type ScopeSessionKey,
} from "@/features/chat/chatScope";
import { useAiSettingsStore } from "@/features/chat/store";
import { getCodexEntry } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";
import {
  canEditEntry,
  useCodexEditLock,
} from "@/features/codex/multiwindow/codexEditLockStore";
import type { CommandCenterItem } from "@/features/commandCenter/providers/types";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { resolvePhoneEditorGroup } from "@/features/editor/phoneEditorGroup";
import { useTabStore } from "@/features/editor/tabStore";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { useSemanticNavStore } from "@/features/semantic-search/semanticNavStore";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import {
  getCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";
import i18next from "@/lib/i18n";
import { isChatSceneTransitionBlocked } from "@/lib/chatNavigationGuard";
import { useCompactNavigationStore } from "./compactNavigationStore";
import { PhoneChatSurface } from "./mobile/PhoneChatSurface";
import { PhoneCodexNavigator } from "./mobile/PhoneCodexNavigator";
import { PhoneMoreSurface } from "./mobile/PhoneMoreSurface";
import {
  PhoneSceneNavigator,
  type PhoneSceneAction,
} from "./mobile/PhoneSceneNavigator";
import type { MobileWorkspaceSurfaceId } from "./AdaptiveWorkspaceShell";

const CommandCenterResultsPanel = lazy(async () => {
  const module =
    await import("@/features/commandCenter/CommandCenterResultsPanel");
  return { default: module.CommandCenterResultsPanel };
});

function editorProjectionGroup(documentId: string): 0 | 1 {
  const tabs = useTabStore.getState();
  const inlineAi = useInlineAiStore.getState();
  const pending =
    inlineAi.status === "generating" ||
    inlineAi.status === "diffShown" ||
    inlineAi.status === "error";
  return resolvePhoneEditorGroup(
    tabs,
    documentId,
    pending ? inlineAi.activeEditorGroup : null,
  );
}

function openDocument(documentId: string, beforeOpen?: () => void): boolean {
  const tree = useTreeStore.getState();
  if (
    documentId !== tree.activeSceneId &&
    (guardInlineAiPending() || isChatSceneTransitionBlocked())
  ) {
    return false;
  }
  tree.setActiveScene(documentId);
  if (useTreeStore.getState().activeSceneId !== documentId) return false;
  beforeOpen?.();
  useCompactNavigationStore.getState().openSurface("editor");
  useEditorSessionStore
    .getState()
    .requestEditorFocus(editorProjectionGroup(documentId));
  return true;
}

function runPhoneSceneMutation(operation: Promise<unknown>): void {
  void operation.catch(() => {
    toast.error(i18next.t("mobileWorkspace.scenes.actionFailed"));
  });
}

function sessionMatchesScopeKey(
  session: {
    nodeId: string | null;
    codexAnchorId: string | null;
    snippetAnchorId: string | null;
  },
  key: ScopeSessionKey,
): boolean {
  return (
    session.nodeId === (key.nodeId ?? null) &&
    session.codexAnchorId === (key.codexAnchorId ?? null) &&
    session.snippetAnchorId === (key.snippetAnchorId ?? null)
  );
}

function parseSemanticResultId(id: string): { sceneId: string } | null {
  const parts = id.slice("semantic-chunk:".length).split(":");
  if (parts.length < 3) return null;
  const sceneId = parts.slice(0, -2).join(":");
  return sceneId ? { sceneId } : null;
}

async function selectPhoneCodexEntry(entryId: string): Promise<void> {
  const projectId = getCurrentProjectId();
  const codex = useCodexStore.getState();
  codex.setSelectedEntry(null);
  codex.requestSelectEntry(entryId);
  useCompactNavigationStore.getState().openSurface("codex");
  try {
    const entry = await getCodexEntry(projectId, entryId);
    const current = useCodexStore.getState();
    if (
      getCurrentProjectId() !== projectId ||
      current.pendingEntryId !== entryId
    ) {
      return;
    }
    if (!entry) {
      current.clearPendingEntry();
      toast.info(
        i18next.t("mobileWorkspace.surfaces.search.resultUnavailable"),
      );
      return;
    }
    current.setSelectedEntry(entry);
    current.clearPendingEntry();
  } catch {
    const current = useCodexStore.getState();
    if (
      getCurrentProjectId() !== projectId ||
      current.pendingEntryId !== entryId
    ) {
      return;
    }
    current.clearPendingEntry();
    toast.error(i18next.t("mobileWorkspace.surfaces.search.loadFailed"));
  }
}

function revealMobileSearchSelection(item: CommandCenterItem): true {
  if (item.kind === "lexical-scene") {
    openDocument(item.id.slice("lexical-scene:".length));
  } else if (item.kind === "lexical-codex") {
    void selectPhoneCodexEntry(item.id.slice("lexical-codex:".length));
  } else if (item.kind === "lexical-snippet") {
    toast.info(i18next.t("mobileWorkspace.surfaces.search.snippetUnavailable"));
  } else {
    const target = parseSemanticResultId(item.id);
    if (target && item.subtitle) {
      openDocument(target.sceneId, () => {
        useSemanticNavStore.getState().requestJump({
          sceneId: target.sceneId,
          chunkText: item.subtitle!,
        });
      });
    }
  }
  return true;
}

function getAllProjectDocumentsInOrder(
  nodes: readonly TreeNodeData[],
): TreeNodeData[] {
  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) =>
      left.sortOrder.localeCompare(right.sortOrder),
    );
  }

  const documents: TreeNodeData[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null): void => {
    for (const node of childrenByParent.get(parentId) ?? []) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      if (node.nodeType === "folder") {
        walk(node.id);
      } else {
        documents.push(node);
      }
    }
  };
  walk(null);
  return documents;
}

function ConnectedSceneSurface() {
  const nodes = useTreeStore((state) => state.nodes);
  const activeSceneId = useTreeStore((state) => state.activeSceneId);
  const createNode = useTreeStore((state) => state.createNode);
  const deleteNode = useTreeStore((state) => state.deleteNode);
  const moveNode = useTreeStore((state) => state.moveNode);
  const active = useCompactNavigationStore(
    (state) => state.activeSurface === "scenes",
  );
  const documents = useMemo(
    () =>
      getAllProjectDocumentsInOrder(nodes).map((document) => ({
        id: document.id,
        title: document.title,
        nodeType: document.nodeType as "scene" | "note",
        chapterTitle: nodes.find((node) => node.id === document.parentId)
          ?.title,
      })),
    [nodes],
  );

  const onSceneAction = (sceneId: string, action: PhoneSceneAction): void => {
    const scene = nodes.find((node) => node.id === sceneId);
    if (!scene) return;
    const siblings = nodes
      .filter((node) => node.parentId === scene.parentId)
      .sort((left, right) => left.sortOrder.localeCompare(right.sortOrder));
    const index = siblings.findIndex((node) => node.id === sceneId);
    if (action === "delete") {
      runPhoneSceneMutation(deleteNode(sceneId));
      return;
    }
    if (action === "move-up" && index > 0) {
      runPhoneSceneMutation(
        moveNode(sceneId, scene.parentId, siblings[index - 2]?.id ?? null),
      );
      return;
    }
    if (action === "move-down" && index >= 0 && index < siblings.length - 1) {
      runPhoneSceneMutation(
        moveNode(sceneId, scene.parentId, siblings[index + 1]?.id),
      );
    }
  };

  return (
    <PhoneSceneNavigator
      scenes={documents}
      currentSceneId={activeSceneId}
      onOpenScene={openDocument}
      onCreateNode={(nodeType) => {
        const activeDocument = nodes.find((node) => node.id === activeSceneId);
        runPhoneSceneMutation(
          createNode({
            nodeType,
            parentId: activeDocument?.parentId ?? null,
            afterId: activeDocument?.id,
            interaction: "mobile",
          }).then((created) => (created ? openDocument(created.id) : false)),
        );
      }}
      onSceneAction={onSceneAction}
      active={active}
    />
  );
}

function ConnectedCodexSurface() {
  const projectId = useProjectStore((state) => state.currentProjectId);
  const active = useCompactNavigationStore(
    (state) => state.activeSurface === "codex",
  );
  const entries = useCodexStore((state) => state.entries);
  const entryTypes = useCodexStore((state) => state.types);
  const pendingEntryId = useCodexStore((state) => state.pendingEntryId);
  const selectedEntry = useCodexStore((state) => state.selectedEntry);
  const setSelectedEntry = useCodexStore((state) => state.setSelectedEntry);
  const clearPendingEntry = useCodexStore((state) => state.clearPendingEntry);
  const ensureEntriesLoaded = useCodexStore(
    (state) => state.ensureEntriesLoaded,
  );
  const saveTypeAndSummary = useCodexStore((state) => state.saveTypeAndSummary);
  const canEditSelected = useCodexEditLock(
    active ? (selectedEntry?.id ?? null) : null,
  );

  useEffect(() => {
    if (active && projectId) void ensureEntriesLoaded();
  }, [active, ensureEntriesLoaded, projectId]);

  useEffect(() => {
    if (!pendingEntryId) return;
    const entry = entries.find((candidate) => candidate.id === pendingEntryId);
    if (!entry) return;
    setSelectedEntry(entry);
    clearPendingEntry();
  }, [clearPendingEntry, entries, pendingEntryId, setSelectedEntry]);

  const visibleEntries = useMemo(
    () =>
      selectedEntry && !entries.some((entry) => entry.id === selectedEntry.id)
        ? [selectedEntry, ...entries]
        : entries,
    [entries, selectedEntry],
  );
  const codex = useMemo(
    () =>
      visibleEntries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        summary: entry.summary ?? undefined,
      })),
    [visibleEntries],
  );

  return (
    <PhoneCodexNavigator
      entries={codex}
      entryTypes={entryTypes.map((entryType) => ({
        value: entryType.slug,
        label: entryType.label,
      }))}
      selectedEntryId={selectedEntry?.id ?? null}
      onSelectEntry={(entryId) => {
        const entry = entries.find((candidate) => candidate.id === entryId);
        if (entry) {
          clearPendingEntry();
          setSelectedEntry(entry);
        }
      }}
      onClearSelection={() => {
        clearPendingEntry();
        setSelectedEntry(null);
      }}
      onSaveEntry={async (entryId, edits) => {
        if (!canEditEntry(entryId)) return false;
        return saveTypeAndSummary(entryId, edits);
      }}
      readOnly={!canEditSelected}
    />
  );
}

function ConnectedAiSurface({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const chatGate = useAiGate("chat");
  const aiSettings = useAiSettingsStore((state) => state.settings);
  const loadAiSettings = useAiSettingsStore((state) => state.loadSettings);
  const messages = useChatStore((state) => state.messages);
  const sessions = useChatStore((state) => state.sessions);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const isLoadingSessions = useChatStore((state) => state.isLoadingSessions);
  const isLoadingMessages = useChatStore((state) => state.isLoadingMessages);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const selectSession = useChatStore((state) => state.selectSession);
  const createNewSession = useChatStore((state) => state.createNewSession);
  const setChatActiveSceneId = useChatStore((state) => state.setActiveSceneId);
  const chatScope = useChatStore((state) => state.chatScope);
  const scopeAnchorId = useChatStore((state) => state.scopeAnchorId);
  const activeSceneId = useTreeStore((state) => state.activeSceneId);
  const createSessionInFlight = useRef(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const aiSurfaceActive = useCompactNavigationStore(
    (state) => state.activeSurface === "ai",
  );
  const sceneScopeWithoutScene = chatScope === "scene" && !activeSceneId;
  const sessionKey = useMemo(
    () => resolveScopeSessionKey(chatScope, activeSceneId, scopeAnchorId),
    [activeSceneId, chatScope, scopeAnchorId],
  );

  useEffect(() => {
    const nextSceneId = activeSceneId ?? "";
    setChatActiveSceneId(nextSceneId);
  }, [activeSceneId, setChatActiveSceneId]);

  useEffect(() => {
    let stale = false;
    if (!aiSurfaceActive || sceneScopeWithoutScene) return undefined;

    const requestedKey = sessionKey;
    void (async () => {
      const loaded = await loadSessions(
        requestedKey.nodeId,
        requestedKey.codexAnchorId,
        requestedKey.snippetAnchorId,
      );

      const currentTreeSceneId = useTreeStore.getState().activeSceneId;
      const currentChat = useChatStore.getState();
      if (currentChat.chatScope === "scene" && !currentTreeSceneId) {
        setChatActiveSceneId("");
        return;
      }
      if (stale) return;

      const currentKey = resolveScopeSessionKey(
        currentChat.chatScope,
        currentTreeSceneId,
        currentChat.scopeAnchorId,
      );
      if (
        currentKey.nodeId !== requestedKey.nodeId ||
        currentKey.codexAnchorId !== requestedKey.codexAnchorId ||
        currentKey.snippetAnchorId !== requestedKey.snippetAnchorId
      ) {
        return;
      }

      if (!loaded) return;

      const loadedSessionsMatchScope = currentChat.sessions.every((session) =>
        sessionMatchesScopeKey(session, requestedKey),
      );
      if (!loadedSessionsMatchScope) {
        await selectSession(null);
        return;
      }

      const currentActiveSessionId = currentChat.activeSessionId;
      const activeSessionIsAvailable =
        currentActiveSessionId !== null &&
        currentChat.sessions.some(
          (session) => session.id === currentActiveSessionId,
        );
      if (!activeSessionIsAvailable) {
        await selectSession(currentChat.sessions[0]?.id ?? null);
      }
    })();

    return () => {
      stale = true;
    };
  }, [
    aiSurfaceActive,
    loadSessions,
    sceneScopeWithoutScene,
    selectSession,
    setChatActiveSceneId,
    sessionKey,
  ]);

  useEffect(() => {
    if (!aiSettings) void loadAiSettings();
  }, [aiSettings, loadAiSettings]);

  const chat = useMemo(
    () =>
      messages
        .filter(
          (message) => message.role === "user" || message.role === "assistant",
        )
        .map((message, index, visible) => ({
          id: message.id,
          role: message.role as "user" | "assistant",
          text: message.content,
          streaming:
            isStreaming &&
            index === visible.length - 1 &&
            message.role === "assistant",
        })),
    [isStreaming, messages],
  );

  const scopedSessions = useMemo(
    () =>
      sessions.filter((session) => sessionMatchesScopeKey(session, sessionKey)),
    [sessionKey, sessions],
  );
  const scopedActiveSessionId = scopedSessions.some(
    (session) => session.id === activeSessionId,
  )
    ? activeSessionId
    : null;

  const handleCreateSession = () => {
    if (sceneScopeWithoutScene || createSessionInFlight.current) return;

    createSessionInFlight.current = true;
    setIsCreatingSession(true);
    const finish = () => {
      createSessionInFlight.current = false;
      setIsCreatingSession(false);
    };
    try {
      void createNewSession(
        getCurrentProjectId(),
        t("mobileWorkspace.surfaces.ai.newChat"),
        sessionKey.nodeId ?? undefined,
        sessionKey.codexAnchorId,
        sessionKey.snippetAnchorId,
      ).then(finish, finish);
    } catch {
      finish();
    }
  };

  return (
    <PhoneChatSurface
      messages={sceneScopeWithoutScene ? [] : chat}
      sessions={(sceneScopeWithoutScene ? [] : scopedSessions).map(
        (session) => ({
          id: session.id,
          title:
            session.title || t("mobileWorkspace.surfaces.ai.untitledHistory"),
        }),
      )}
      activeSessionId={sceneScopeWithoutScene ? null : scopedActiveSessionId}
      isLoadingSessions={sceneScopeWithoutScene ? false : isLoadingSessions}
      isLoadingMessages={isLoadingMessages}
      isCreatingSession={isCreatingSession}
      onSelectSession={(sessionId) => void selectSession(sessionId)}
      onCreateSession={handleCreateSession}
      disabled={isStreaming || sceneScopeWithoutScene}
      sendDisabled={chatGate.presentation !== "enabled"}
      disabledHint={
        chatGate.tooltip ??
        (chatGate.presentation === "hidden" ? t("chat.aiOffNote") : null)
      }
      hideComposer={chatGate.presentation === "hidden"}
      onOpenSettings={onOpenSettings}
      onSend={(text) => void sendMessage(text)}
    />
  );
}

export function ConnectedMobileWorkspaceSurface({
  surface,
  onOpenSettings,
  onOpenImport,
  onOpenExport,
  onContinueInGrimodex,
  onOpenAiSettings,
  workspaceControls,
}: {
  surface: MobileWorkspaceSurfaceId;
  onOpenSettings: () => void;
  onOpenAiSettings?: () => void;
  onOpenImport?: () => void;
  onOpenExport?: () => void;
  onContinueInGrimodex?: () => void;
  workspaceControls?: ReactNode;
}) {
  const { t } = useTranslation();

  switch (surface) {
    case "scenes":
      return <ConnectedSceneSurface />;
    case "codex":
      return <ConnectedCodexSurface />;
    case "ai":
      return (
        <ConnectedAiSurface
          onOpenSettings={onOpenAiSettings ?? onOpenSettings}
        />
      );
    case "more":
      return (
        <PhoneMoreSurface
          onOpenSearch={() =>
            useCompactNavigationStore.getState().openSurface("search")
          }
          onOpenSettings={onOpenSettings}
          onOpenImport={onOpenImport}
          onOpenExport={onOpenExport}
          onContinueInGrimodex={onContinueInGrimodex}
          workspaceControls={workspaceControls}
        />
      );
    case "search":
      return (
        <section
          aria-label={t("mobileWorkspace.surfaces.search.title")}
          data-phone-search-surface
          className="flex min-h-full w-full flex-col overflow-hidden"
        >
          <Suspense
            fallback={
              <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
                …
              </div>
            }
          >
            <CommandCenterResultsPanel
              onItemSelect={revealMobileSearchSelection}
            />
          </Suspense>
        </section>
      );
  }
}
