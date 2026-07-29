import { useChatHistoryStore } from "@/features/chat/chatHistoryStore";
import { useChatStore } from "@/features/chat/chatStore";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { useSceneBeatPovStore } from "@/features/editor/beat/sceneBeatPovStore";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
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
import { usePanelStore } from "@/features/commandCenter/store/commandCenterStore";
import { useResultsPanelStore } from "@/features/commandCenter/store/resultsPanelStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  applyTreeHydration,
  prepareTreeHydration,
  useTreeStore,
} from "@/features/tree/treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  createProjectLifecycleRegistry,
  type ProjectLifecycleParticipant,
} from "./ProjectLifecycleRegistry";
import { debugLog } from "@/lib/debugLog";

/** Abort and clear project-scoped chat state before a Project boundary commit. */
export function resetChatForProject(projectId: string): void {
  useChatStore.getState().resetForProject(projectId);
}

/** Clear Phase caches while retaining the user's resolution mode. */
export function resetPhaseStateForProject(): void {
  usePhaseStore.getState().resetForProject();
}

/** Clear scene-keyed beat caches so same-id scenes cannot leak across Projects. */
export function resetUnplacedBeatsForProject(): void {
  useUnplacedBeatsStore.getState().resetForProject();
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
    id: "plot-threads",
    reset: ({ projectId }) =>
      usePlotThreadStore.getState().resetForProject(projectId),
  },
  {
    id: "trash",
    reset: ({ projectId }) =>
      useTrashBinStore.getState().resetForProject(projectId),
  },
  {
    id: "scene-codex-pins",
    reset: () => useSceneCodexPinsStore.getState().resetForProject(),
  },
  {
    id: "scene-beat-pov",
    reset: () => useSceneBeatPovStore.getState().resetForProject(),
  },
  {
    id: "unplaced-beats",
    reset: () => resetUnplacedBeatsForProject(),
  },
  { id: "labels", reset: () => useLabelStore.getState().resetForProject() },
  {
    id: "grid-selection",
    reset: ({ projectId }) =>
      useGridStore.getState().resetForProject(projectId),
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
    id: "settings",
    prepareCritical: async ({ projectId }) => {
      const snapshot = await useSettingsStore
        .getState()
        .prepareHydration(projectId);
      return () => useSettingsStore.getState().applyHydration(snapshot);
    },
  },
  {
    id: "tree",
    prepareCritical: async ({ projectId, workspaceOpenRevision }) => {
      const snapshot = await prepareTreeHydration(
        projectId,
        workspaceOpenRevision,
      );
      return () => applyTreeHydration(snapshot);
    },
  },
  {
    id: "chat-active-scene",
    commitCritical: () => {
      useChatStore
        .getState()
        .setActiveSceneId(useTreeStore.getState().activeSceneId);
    },
  },

  {
    id: "codex-load",
    hydrateOptional: () =>
      useCodexStore.getState().loadEntries({ propagateError: true }),
  },
  {
    id: "snippets-load",
    hydrateOptional: () =>
      useSnippetStore.getState().loadEntries({ propagateError: true }),
  },
  {
    id: "chat-history-load",
    hydrateOptional: ({ projectId }) =>
      useChatHistoryStore
        .getState()
        .loadSessions(projectId, { propagateError: true }),
  },
  {
    id: "foreshadow-load",
    hydrateOptional: ({ projectId }) =>
      useForeshadowStore.getState().load(projectId, { propagateError: true }),
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
    activate: ({ projectId, workspaceOpenRevision }) =>
      initializeExternalMounts({ projectId, workspaceOpenRevision }),
  },
];

export const projectLifecycleRegistry = createProjectLifecycleRegistry(
  participants,
  {
    optionalConcurrency: 3,
    onOptionalFailure: (participant, _error) => {
      debugLog.warn("project-lifecycle", "optional hydration failed", {
        sensitivity: "safe",
        fields: {
          participantId: participant.id,
          operation: "hydrateOptional",
          outcome: "failed",
        },
      });
    },
  },
);
