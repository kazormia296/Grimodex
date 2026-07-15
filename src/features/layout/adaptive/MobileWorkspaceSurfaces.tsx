import { useEffect, useMemo } from "react";
import { requestOpenEditorDocument } from "@/application/editor/editorNavigationRegistry";
import { useChatStore } from "@/features/chat/chatStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import {
  getAllProjectScenesInOrder,
  useTreeStore,
} from "@/features/tree/treeStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useCompactNavigationStore } from "./compactNavigationStore";
import { PhoneChatSurface } from "./mobile/PhoneChatSurface";
import { PhoneCodexNavigator } from "./mobile/PhoneCodexNavigator";
import {
  PhoneSceneNavigator,
  type PhoneSceneAction,
} from "./mobile/PhoneSceneNavigator";
import type { MobileWorkspaceSurfaces } from "./AdaptiveWorkspaceShell";

function openScene(sceneId: string): void {
  requestOpenEditorDocument({
    target: { kind: "scene", documentId: sceneId },
    mode: "pinned",
    revealEditor: true,
    focusEditor: true,
    syncSceneContext: true,
  });
  useCompactNavigationStore.getState().openSurface("editor");
}

function MoreSurface() {
  return (
    <section
      aria-label="More workspace actions"
      data-phone-more-surface
      className="grid gap-3 p-4"
    >
      <h1 className="text-xl font-semibold">More</h1>
      <p className="text-sm text-muted-foreground">
        Export, settings, and desktop-only panels remain available from the
        overflow menu without changing the saved desktop layout.
      </p>
    </section>
  );
}

export function useConnectedMobileWorkspaceSurfaces(): MobileWorkspaceSurfaces {
  const projectId = useProjectStore((state) => state.currentProjectId);
  const nodes = useTreeStore((state) => state.nodes);
  const activeSceneId = useTreeStore((state) => state.activeSceneId);
  const treeActions = useTreeStore();
  const entries = useCodexStore((state) => state.entries);
  const ensureEntriesLoaded = useCodexStore(
    (state) => state.ensureEntriesLoaded,
  );
  const phasesByEntry = usePhaseStore((state) => state.phasesByEntry);
  const loadPhasesForEntry = usePhaseStore((state) => state.loadPhasesForEntry);
  const messages = useChatStore((state) => state.messages);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const sendMessage = useChatStore((state) => state.sendMessage);

  useEffect(() => {
    if (projectId) void ensureEntriesLoaded();
  }, [ensureEntriesLoaded, projectId]);

  useEffect(() => {
    for (const entry of entries.slice(0, 64)) {
      if (!phasesByEntry[entry.id]) void loadPhasesForEntry(entry.id);
    }
  }, [entries, loadPhasesForEntry, phasesByEntry]);

  const scenes = useMemo(
    () =>
      getAllProjectScenesInOrder(nodes).map((scene) => ({
        id: scene.id,
        title: scene.title,
        chapterTitle: nodes.find((node) => node.id === scene.parentId)?.title,
      })),
    [nodes],
  );

  const codex = useMemo(
    () =>
      entries.map((entry) => ({
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
    [entries, phasesByEntry],
  );

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

  const onSceneAction = (sceneId: string, action: PhoneSceneAction): void => {
    const scene = nodes.find((node) => node.id === sceneId);
    if (!scene) return;
    const siblings = nodes
      .filter(
        (node) => node.parentId === scene.parentId && node.nodeType === "scene",
      )
      .sort((left, right) => left.sortOrder.localeCompare(right.sortOrder));
    const index = siblings.findIndex((node) => node.id === sceneId);
    if (action === "delete") {
      void treeActions.deleteNode(sceneId);
      return;
    }
    if (action === "duplicate") {
      void treeActions.createNode({
        nodeType: "scene",
        parentId: scene.parentId,
        afterId: sceneId,
        title: `${scene.title} copy`,
      });
      return;
    }
    if (action === "move-up" && index > 0) {
      void treeActions.moveNode(
        sceneId,
        scene.parentId,
        siblings[index - 2]?.id ?? null,
      );
      return;
    }
    if (action === "move-down" && index >= 0 && index < siblings.length - 1) {
      void treeActions.moveNode(
        sceneId,
        scene.parentId,
        siblings[index + 1]?.id,
      );
      return;
    }
    if (action === "move-to-chapter") {
      const chapter = nodes.find(
        (node) => node.nodeType === "folder" && node.id !== scene.parentId,
      );
      if (chapter) void treeActions.moveNode(sceneId, chapter.id, null);
    }
  };

  return {
    scenes: (
      <PhoneSceneNavigator
        scenes={scenes}
        currentSceneId={activeSceneId}
        onOpenScene={openScene}
        onSceneAction={onSceneAction}
      />
    ),
    codex: <PhoneCodexNavigator entries={codex} onOpenAnchor={openScene} />,
    ai: (
      <PhoneChatSurface
        messages={chat}
        disabled={isStreaming}
        onSend={(text) => void sendMessage(text)}
      />
    ),
    more: <MoreSurface />,
  };
}
