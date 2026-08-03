import {
  migrateAppSettingsToScopedStores,
  migrateModelRoleKeys,
  removeRetiredDisplaySettings,
  seedProjectSettingsFromDefaults,
} from "@/features/settings/migration";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useLintConfigStore } from "@/features/lint/lintConfigStore";
import { loadAndSyncTimelineSettings } from "@/features/timeline/timelineStore";
import { loadAndSyncChronicleSettings } from "@/features/chronicle/chronicleStore";
import { useMapStore } from "@/features/map/mapStore";
import { useGridStore } from "@/features/grid/gridStore";
import { useMatrixStore } from "@/features/matrix/matrixStore";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import {
  registerWorkspaceHydrationDependencies,
  type WorkspaceHydrationDependencies,
} from "@/application/workspace/workspaceHydration";
import {
  registerExternalWriteProjectors,
  type ExternalWriteProjectors,
} from "@/application/externalWrites/externalWriteProjectors";
import {
  projectLifecycleRegistry,
  resetChatForProject,
  resetPhaseStateForProject,
  resetUnplacedBeatsForProject,
} from "@/application/project/defaultProjectLifecycle";
import { registerProjectLifecycle } from "@/application/project/projectLifecycle";
import { registerProjectRuntime } from "@/application/project/projectRuntime";
import { registerCodexAnchorLifecycle } from "@/application/codex/codexAnchorLifecycle";
import { codexAnchorLifecycleComposition } from "./codexAnchorLifecycleComposition";
import { projectRuntimeComposition } from "./projectRuntimeComposition";
import { registerChatContextPreparation } from "@/application/chat/chatContextPreparation";
import { chatContextPreparationComposition } from "./chatContextPreparationComposition";

const workspaceHydrationDependencies: WorkspaceHydrationDependencies = {
  migrateAppSettingsToScopedStores,
  migrateModelRoleKeys,
  removeRetiredDisplaySettings,
  seedProjectSettingsFromDefaults,
  loadSettings: (projectId) => useSettingsStore.getState().loadAll(projectId),
  initCursorSettings: () =>
    useCursorSettingsStore.getState().initFromSettings(),
  initCodexHighlight: () =>
    useCodexHighlightStore.getState().initFromSettings(),
  initAttribution: () => useAttributionStore.getState().initFromSettings(),
  initAnnotation: () =>
    useAnnotationStore.getState().initFromSettings({ resetLiveReader: true }),
  loadLintConfig: () => useLintConfigStore.getState().load(),
  loadTimelineSettings: loadAndSyncTimelineSettings,
  loadChronicleSettings: loadAndSyncChronicleSettings,
  loadMapSettings: (settings) =>
    useMapStore.getState().loadFromSettings(settings),
  loadGridSettings: (settings) =>
    useGridStore.getState().loadFromSettings(settings),
  loadMatrixSettings: (settings) =>
    useMatrixStore.getState().loadFromSettings(settings),
};

const externalWriteProjectors: ExternalWriteProjectors = {
  reloadForeshadows: (projectId) =>
    useForeshadowStore.getState().load(projectId),
  bumpChronicleRevision: () => useChronicleStore.getState().bumpRevision(),
  reloadPlotThreads: (projectId) =>
    usePlotThreadStore.getState().load(projectId),
  reloadLabels: (projectId) => useLabelStore.getState().load(projectId),
};

registerWorkspaceHydrationDependencies(workspaceHydrationDependencies);
registerExternalWriteProjectors(externalWriteProjectors);
registerProjectLifecycle(projectLifecycleRegistry, {
  resetChatForProject,
  resetPhaseStateForProject,
  resetUnplacedBeatsForProject,
});
registerCodexAnchorLifecycle(codexAnchorLifecycleComposition);
registerProjectRuntime(projectRuntimeComposition);
registerChatContextPreparation(chatContextPreparationComposition);
