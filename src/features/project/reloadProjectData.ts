import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useChatHistoryStore } from "@/features/chat/chatHistoryStore";
import { useChatStore } from "@/features/chat/chatStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { useGridStore } from "@/features/grid/gridStore";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useCommandCenterStore } from "@/features/commandCenter/store/commandCenterStore";
import { useResultsPanelStore } from "@/features/commandCenter/store/resultsPanelStore";
import { useLintStore } from "@/features/lint/lintStore";

/**
 * Project 切替時に mount 済みパネルの in-memory 状態を破棄し、
 * 新 Project のデータを再ロードする。Workspace 再オープン相当の処理。
 */
export async function reloadProjectData(projectId: string): Promise<void> {
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

  await useTreeStore.getState().loadTree(projectId);

  const activeSceneId = useTreeStore.getState().activeSceneId;
  useChatStore.setState({ activeSceneId });

  await Promise.all([
    useCodexStore.getState().loadEntries(),
    useSnippetStore.getState().loadEntries(),
    useChatHistoryStore.getState().loadSessions(projectId),
    useForeshadowStore.getState().load(projectId),
    useLabelStore.getState().load(projectId),
    useGridStore.getState().loadForProject(projectId),
    useTrashBinStore.getState().loadItems(projectId),
  ]);
}
