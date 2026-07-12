import { useChatHistoryStore } from "@/features/chat/chatHistoryStore";
import { useChatStore } from "@/features/chat/chatStore";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { useSceneBeatPovStore } from "@/features/editor/beat/sceneBeatPovStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useFocusedContentEditorStore } from "@/store/focusedContentEditorStore";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { useGridStore } from "@/features/grid/gridStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { useLintStore } from "@/features/lint/lintStore";
import { useTermDictionaryStore } from "@/features/lint/termDictionaryStore";
import { useMapStore } from "@/features/map/mapStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { usePromptLibraryStore } from "@/features/prompt-library/promptLibraryStore";
import { initializeExternalMounts } from "@/features/external-mount/mountManager";
import {
  useBarStore,
  usePanelStore,
} from "@/features/commandCenter/store/commandCenterStore";
import { useResultsPanelStore } from "@/features/commandCenter/store/resultsPanelStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  createProjectLifecycleRegistry,
  type ProjectLifecycleParticipant,
} from "./ProjectLifecycleRegistry";

/**
 * Project 境界を跨いで参照してはいけない Chat の turn/session/context 状態を破棄する。
 * streaming 中は resetForProject が旧 turn を先に中断する。
 */
export function resetChatForProject(projectId: string): void {
  useChatStore.getState().resetForProject(projectId);
}

/** Codex Phase の project-owned cache を破棄し、resolution mode は保持する。 */
export function resetPhaseStateForProject(): void {
  usePhaseStore.getState().resetForProject();
}

const participants: readonly ProjectLifecycleParticipant[] = [
  { id: "chat", reset: ({ projectId }) => resetChatForProject(projectId) },
  { id: "phase", reset: () => resetPhaseStateForProject() },
  {
    id: "global-history",
    reset: () => useGlobalHistoryStore.getState().clear(),
  },
  { id: "tabs", reset: () => useTabStore.getState().resetForProject() },
  {
    id: "chat-history",
    reset: () => useChatHistoryStore.getState().resetForProject(),
  },
  { id: "codex", reset: () => useCodexStore.getState().resetForProject() },
  { id: "snippets", reset: () => useSnippetStore.getState().resetForProject() },
  {
    id: "foreshadow",
    reset: () => useForeshadowStore.getState().resetForProject(),
  },
  {
    id: "scene-codex-pins",
    reset: () => useSceneCodexPinsStore.getState().resetForProject(),
  },
  {
    id: "scene-beat-pov",
    reset: () => useSceneBeatPovStore.getState().resetForProject(),
  },
  { id: "labels", reset: () => useLabelStore.getState().resetForProject() },
  {
    id: "grid-selection",
    reset: () => useGridStore.getState().clearSelection(),
  },
  {
    id: "timeline-selection",
    reset: () => useTimelineStore.getState().clearSelection(),
  },
  {
    id: "chronicle-selection",
    reset: () => useChronicleStore.getState().clearSelection(),
  },
  { id: "inline-ai", reset: () => useInlineAiStore.getState().reset() },
  { id: "editor", reset: () => useEditorStore.getState().setEditor(null) },
  {
    id: "focused-content-editor",
    reset: () => useFocusedContentEditorStore.getState().setCurrent(null, null),
  },
  {
    id: "scene-content",
    reset: () => useSceneContentStore.getState().resetForProject(),
  },
  { id: "command-bar", reset: () => useBarStore.getState().reset() },
  { id: "command-panel", reset: () => usePanelStore.getState().reset() },
  { id: "results-panel", reset: () => useResultsPanelStore.getState().reset() },
  { id: "lint", reset: () => useLintStore.getState().clear() },
  {
    id: "term-dictionary",
    reset: () => useTermDictionaryStore.getState().resetForProject(),
  },
  { id: "map", reset: () => useMapStore.getState().resetForProject() },
  {
    id: "prompt-library",
    reset: () => usePromptLibraryStore.getState().resetForProject(),
  },

  {
    id: "tree",
    hydrateCritical: async ({ projectId }) => {
      await useTreeStore
        .getState()
        .loadTree(projectId)
        .catch(() => {});
    },
  },
  {
    id: "chat-active-scene",
    hydrateCritical: () => {
      useChatStore
        .getState()
        .setActiveSceneId(useTreeStore.getState().activeSceneId);
    },
  },

  {
    id: "codex-load",
    hydrateOptional: () => useCodexStore.getState().loadEntries(),
  },
  {
    id: "snippets-load",
    hydrateOptional: () => useSnippetStore.getState().loadEntries(),
  },
  {
    id: "chat-history-load",
    hydrateOptional: ({ projectId }) =>
      useChatHistoryStore.getState().loadSessions(projectId),
  },
  {
    id: "foreshadow-load",
    hydrateOptional: ({ projectId }) =>
      useForeshadowStore.getState().load(projectId),
  },
  {
    id: "labels-load",
    hydrateOptional: ({ projectId }) =>
      useLabelStore.getState().load(projectId),
  },
  {
    id: "grid-load",
    hydrateOptional: ({ projectId }) =>
      useGridStore.getState().loadForProject(projectId),
  },
  {
    id: "trash-load",
    hydrateOptional: ({ projectId }) =>
      useTrashBinStore.getState().loadItems(projectId),
  },
  {
    id: "scene-codex-pins-load",
    hydrateOptional: ({ projectId }) =>
      useSceneCodexPinsStore.getState().loadAllForProject(projectId),
  },
  {
    id: "scene-beat-pov-load",
    hydrateOptional: ({ projectId }) =>
      useSceneBeatPovStore.getState().loadAllForProject(projectId),
  },
  {
    id: "plot-threads-load",
    hydrateOptional: ({ projectId }) =>
      usePlotThreadStore.getState().load(projectId),
  },

  {
    id: "external-mounts",
    activate: async () => {
      await initializeExternalMounts().catch(() => {});
    },
  },
];

export const projectLifecycleRegistry = createProjectLifecycleRegistry(
  participants,
  {
    optionalConcurrency: 3,
    onOptionalFailure: (participant, error) => {
      console.warn(
        `[project-lifecycle] ${participant.id} hydration failed`,
        error,
      );
    },
  },
);
