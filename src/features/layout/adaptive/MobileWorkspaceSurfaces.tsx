import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useChatStore } from "@/features/chat/chatStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { getCodexEntry } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
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

const phaseLoadsInFlight = new Map<string, Promise<void>>();

function requestPhaseLoadOnce(
  projectId: string,
  entryId: string,
  loadPhasesForEntry: (entryId: string) => Promise<void>,
): void {
  const key = `${projectId}:${entryId}`;
  if (phaseLoadsInFlight.has(key)) return;
  const operation = loadPhasesForEntry(entryId)
    .catch(() => undefined)
    .finally(() => {
      if (phaseLoadsInFlight.get(key) === operation)
        phaseLoadsInFlight.delete(key);
    });
  phaseLoadsInFlight.set(key, operation);
}

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
  if (documentId !== tree.activeSceneId && guardInlineAiPending()) {
    return false;
  }
  beforeOpen?.();
  tree.setActiveScene(documentId);
  useChatStore.getState().setActiveSceneId(documentId);
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
          }).then((created) => openDocument(created.id)),
        );
      }}
      onSceneAction={onSceneAction}
      active={active}
    />
  );
}

function ConnectedCodexSurface() {
  const projectId = useProjectStore((state) => state.currentProjectId);
  const entries = useCodexStore((state) => state.entries);
  const pendingEntryId = useCodexStore((state) => state.pendingEntryId);
  const selectedEntry = useCodexStore((state) => state.selectedEntry);
  const setSelectedEntry = useCodexStore((state) => state.setSelectedEntry);
  const clearPendingEntry = useCodexStore((state) => state.clearPendingEntry);
  const ensureEntriesLoaded = useCodexStore(
    (state) => state.ensureEntriesLoaded,
  );
  const phasesByEntry = usePhaseStore((state) => state.phasesByEntry);
  const loadPhasesForEntry = usePhaseStore((state) => state.loadPhasesForEntry);

  useEffect(() => {
    if (projectId) void ensureEntriesLoaded();
  }, [ensureEntriesLoaded, projectId]);

  useEffect(() => {
    if (!pendingEntryId) return;
    const entry = entries.find((candidate) => candidate.id === pendingEntryId);
    if (!entry) return;
    setSelectedEntry(entry);
    clearPendingEntry();
  }, [clearPendingEntry, entries, pendingEntryId, setSelectedEntry]);

  useEffect(() => {
    if (!projectId || !selectedEntry || phasesByEntry[selectedEntry.id]) return;
    requestPhaseLoadOnce(projectId, selectedEntry.id, loadPhasesForEntry);
  }, [loadPhasesForEntry, phasesByEntry, projectId, selectedEntry]);

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
        phases: (phasesByEntry[entry.id] ?? []).map((phase) => ({
          id: phase.id,
          label: phase.label,
          summary: phase.summaryOverride ?? undefined,
          anchorSceneId: phase.anchorNodeId ?? undefined,
        })),
      })),
    [phasesByEntry, visibleEntries],
  );

  return (
    <PhoneCodexNavigator
      entries={codex}
      selectedEntryId={selectedEntry?.id ?? null}
      onOpenAnchor={openDocument}
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
  const isStreaming = useChatStore((state) => state.isStreaming);
  const sendMessage = useChatStore((state) => state.sendMessage);
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

  return (
    <PhoneChatSurface
      messages={chat}
      disabled={isStreaming}
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
