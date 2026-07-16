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
import type { MobileWorkspaceSurfaceId } from "./AdaptiveWorkspaceShell";

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

function ConnectedSceneSurface() {
  const nodes = useTreeStore((state) => state.nodes);
  const activeSceneId = useTreeStore((state) => state.activeSceneId);
  const deleteNode = useTreeStore((state) => state.deleteNode);
  const moveNode = useTreeStore((state) => state.moveNode);
  const scenes = useMemo(
    () =>
      getAllProjectScenesInOrder(nodes).map((scene) => ({
        id: scene.id,
        title: scene.title,
        chapterTitle: nodes.find((node) => node.id === scene.parentId)?.title,
      })),
    [nodes],
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
      void deleteNode(sceneId);
      return;
    }
    if (action === "move-up" && index > 0) {
      void moveNode(sceneId, scene.parentId, siblings[index - 2]?.id ?? null);
      return;
    }
    if (action === "move-down" && index >= 0 && index < siblings.length - 1) {
      void moveNode(sceneId, scene.parentId, siblings[index + 1]?.id);
    }
  };

  return (
    <PhoneSceneNavigator
      scenes={scenes}
      currentSceneId={activeSceneId}
      onOpenScene={openScene}
      onSceneAction={onSceneAction}
    />
  );
}

function ConnectedCodexSurface() {
  const projectId = useProjectStore((state) => state.currentProjectId);
  const entries = useCodexStore((state) => state.entries);
  const ensureEntriesLoaded = useCodexStore(
    (state) => state.ensureEntriesLoaded,
  );
  const phasesByEntry = usePhaseStore((state) => state.phasesByEntry);
  const loadPhasesForEntry = usePhaseStore((state) => state.loadPhasesForEntry);

  useEffect(() => {
    if (projectId) void ensureEntriesLoaded();
  }, [ensureEntriesLoaded, projectId]);

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

  return (
    <PhoneCodexNavigator
      entries={codex}
      onOpenAnchor={openScene}
      onSelectEntry={(entryId) => {
        if (!projectId || phasesByEntry[entryId]) return;
        requestPhaseLoadOnce(projectId, entryId, loadPhasesForEntry);
      }}
    />
  );
}

function ConnectedAiSurface() {
  const messages = useChatStore((state) => state.messages);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const sendMessage = useChatStore((state) => state.sendMessage);
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
      onSend={(text) => void sendMessage(text)}
    />
  );
}

export function ConnectedMobileWorkspaceSurface({
  surface,
}: {
  surface: MobileWorkspaceSurfaceId;
}) {
  switch (surface) {
    case "scenes":
      return <ConnectedSceneSurface />;
    case "codex":
      return <ConnectedCodexSurface />;
    case "ai":
      return <ConnectedAiSurface />;
    case "more":
      return <MoreSurface />;
  }
}
