import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useChatHistoryStore } from "@/features/chat/chatHistoryStore";
import { useChatStore } from "@/features/chat/chatStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { useGridStore } from "@/features/grid/gridStore";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { useSceneBeatPovStore } from "@/features/editor/beat/sceneBeatPovStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useCommandCenterStore } from "@/features/commandCenter/store/commandCenterStore";
import { useResultsPanelStore } from "@/features/commandCenter/store/resultsPanelStore";
import { useLintStore } from "@/features/lint/lintStore";
import { useTermDictionaryStore } from "@/features/lint/termDictionaryStore";
import { useMapStore } from "@/features/map/mapStore";
import { withProjectLoad } from "./projectLoadGate";

async function loadProjectStoresInBatches(
  projectId: string,
  batchSize = 3,
): Promise<void> {
  const loaders = [
    () => useCodexStore.getState().loadEntries(),
    () => useSnippetStore.getState().loadEntries(),
    () => useChatHistoryStore.getState().loadSessions(projectId),
    () => useForeshadowStore.getState().load(projectId),
    () => useLabelStore.getState().load(projectId),
    () => useGridStore.getState().loadForProject(projectId),
    () => useTrashBinStore.getState().loadItems(projectId),
    () => useSceneCodexPinsStore.getState().loadAllForProject(projectId),
    () => useSceneBeatPovStore.getState().loadAllForProject(projectId),
  ];

  for (let i = 0; i < loaders.length; i += batchSize) {
    await Promise.allSettled(
      loaders.slice(i, i + batchSize).map((load) => load()),
    );
  }
}

/**
 * Project 切替時に mount 済みパネルの in-memory 状態を破棄し、
 * 新 Project のデータを再ロードする。Workspace 再オープン相当の処理。
 */
export async function reloadProjectData(projectId: string): Promise<void> {
  return withProjectLoad(async () => {
  useGlobalHistoryStore.getState().clear();

  const tabStore = useTabStore.getState();
  tabStore.closeAllTabsInGroup(0);
  tabStore.closeAllTabsInGroup(1);
  useTabStore.setState({
    secondaryGroupOpen: false,
    activeGroupIndex: 0,
  });

  useChatStore.setState({
    activeSessionId: null,
    messages: [],
    sessions: [],
    activeProjectId: projectId,
    activeSceneId: "",
    error: null,
  });

  useChatHistoryStore.setState({
    sessions: [],
    searchQuery: "",
    searchResults: [],
    isSearchMode: false,
    sceneFilter: null,
  });

  useCodexStore.setState({
    entries: [],
    types: [],
    searchQuery: "",
    filterType: null,
    pendingEntryId: null,
  });

  useSnippetStore.setState({
    entries: [],
    searchQuery: "",
    pendingEntryId: null,
  });

  useForeshadowStore.setState({
    items: [],
    setupsByForeshadowId: {},
    sceneInfoBySceneId: {},
  });

  useSceneCodexPinsStore.setState({
    pinsByScene: {},
    bulkLoadedProjectId: null,
  });

  useSceneBeatPovStore.setState({
    povIdsByScene: {},
    bulkLoadedProjectId: null,
  });

  useLabelStore.setState({
    labels: [],
    nodeLabels: {},
    projectId: null,
  });

  useGridStore.getState().clearSelection();
  useCommandCenterStore.getState().reset();
  useResultsPanelStore.getState().reset();
  useLintStore.getState().clear();

  // 用語辞書は project スコープ (lint_term_dictionary)。isLoaded を倒して
  // 次回 lint / 設定パネル参照時に新 Project 分を読み直させる。
  useTermDictionaryStore.setState({
    rows: [],
    isLoaded: false,
    loading: false,
  });

  // Map の board 選択 / transient UI を破棄。board データ自体は
  // useMapBoardData が currentProjectId 変化を検知して読み直す。
  useMapStore.setState({
    activeBoardId: null,
    focusedNodeId: null,
    searchVisible: false,
    pendingAutoArrange: null,
    pendingExport: null,
  });

  // 1 ストアのロード失敗で切替全体を中断しない (他パネルは読み直せる)。
  // tree は activeSceneId の起点なので失敗しても後続を進める。
  await useTreeStore
    .getState()
    .loadTree(projectId)
    .catch(() => {});

  const activeSceneId = useTreeStore.getState().activeSceneId;
  useChatStore.setState({ activeSceneId });

  await loadProjectStoresInBatches(projectId);
  });
}
