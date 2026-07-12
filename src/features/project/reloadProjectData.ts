import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { _clearCodexCrossMentionCaches } from "@/features/codex/codexCrossMentions";
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
import {
  useBarStore,
  usePanelStore,
} from "@/features/commandCenter/store/commandCenterStore";
import { useResultsPanelStore } from "@/features/commandCenter/store/resultsPanelStore";
import { useLintStore } from "@/features/lint/lintStore";
import { useTermDictionaryStore } from "@/features/lint/termDictionaryStore";
import { useMapStore } from "@/features/map/mapStore";
import { usePromptLibraryStore } from "@/features/prompt-library/promptLibraryStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useFocusedContentEditorStore } from "@/store/focusedContentEditorStore";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { withProjectLoad } from "./projectLoadGate";
import { initializeExternalMounts } from "@/features/external-mount/mountManager";

/**
 * Project 境界を跨いで参照してはいけない Chat の turn/session/context 状態を破棄する。
 * streaming 中は、旧 Project の callback が reset 後の state を再更新しないよう、
 * 必ず先に turn を中断してから新 Project の初期状態へ切り替える。
 */
export function resetChatForProject(projectId: string): void {
  const chat = useChatStore.getState();
  if (chat.isStreaming) chat.stopGeneration();

  useChatStore.setState({
    activeSessionId: null,
    isLoadingSessions: false,
    isLoadingMessages: false,
    messages: [],
    sessions: [],
    isStreaming: false,
    activeProjectId: projectId,
    activeSceneId: "",
    error: null,
    contextTokenCount: 0,
    contextWindowSize: null,
    contextModel: null,
    contextLayers: [],
    contextPlan: null,
    lastSystemPrompt: "",
    lastSystemPromptKey: null,
    chatRecallPromoteSuggestion: null,
    pinsVersion: 0,
    projectOutline: undefined,
    chapterOutlines: [],
    detectedEntries: [],
    alwaysEntries: [],
    scopeAnchor: null,
    threadFocusOverride: null,
    excludedAutoEntryIds: [],
    inputPinnedEntryIds: [],
    agentMode: false,
    agentProgress: null,
    subAgentProgress: null,
    agentContinuation: null,
    pendingUserQuestion: null,
    ragEnabled: false,
    chatScope: "scene",
    scopeAnchorId: null,
    includeBodies: true,
    includeMapBoard: false,
    mapBoardId: null,
    _editingOldContent: null,
    pendingLookupText: null,
    summaryCount: 0,
    maxSummaryGeneration: 0,
    cacheInvalidatedReason: null,
    sessionStableCodexIds: [],
    sessionStableContextInitialized: false,
    sessionAgentToolsSnapshot: null,
    _lastCachedModel: null,
  });
}

/**
 * Codex Phase の cache は entry / Scene id をキーにするため Project 所有。
 * 同じ id が別 Project に存在しても旧解決結果を再利用しないよう全て破棄する。
 * projectStore が DB から先に適用した resolutionMode は保持し、SceneTimeIndex は
 * 空に戻して後続の treeStore.loadTree に新 Project の nodes から再構築させる。
 */
export function resetPhaseStateForProject(): void {
  usePhaseStore.getState().resetForProject();
}

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
    () => usePlotThreadStore.getState().load(projectId),
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
    resetChatForProject(projectId);
    resetPhaseStateForProject();
    useGlobalHistoryStore.getState().clear();

    const tabStore = useTabStore.getState();
    tabStore.closeAllTabsInGroup(0);
    tabStore.closeAllTabsInGroup(1);
    useTabStore.setState({
      secondaryGroupOpen: false,
      activeGroupIndex: 0,
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
      selectedEntry: null,
      previewPhaseByEntry: {},
    });
    _clearCodexCrossMentionCaches();

    useSnippetStore.setState({
      entries: [],
      searchQuery: "",
      pendingEntryId: null,
      selectedSnippet: null,
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
    // Timeline の選択（シーン + プロットのマーカー/スレッド）を破棄。残すと
    // 新 Project でインスペクタが旧プロジェクトの選択を指したまま開く。
    useTimelineStore.getState().clearSelection();
    // Chronicle も同様に ephemeral 選択を破棄。従来 chronicle だけ clearSelection
    // 自体が無く、旧プロジェクトの selectedEventId が新プロジェクトの
    // renderEvents に stale 一致して誤選択・クロスプロジェクト参照を生んでいた。
    useChronicleStore.getState().clearSelection();
    // エディタ関連の module/store 参照を破棄。これらは reloadProjectData の手動
    // 列挙から漏れており、旧プロジェクトのエディタ参照や live content、inline-AI
    // pending が新プロジェクトへ持ち越されると、Chat/Snippet 挿入や Accept/Reject
    // が別プロジェクトのエディタに向かう / 同 id 衝突時に旧本文が subscribe
    // コールバックへ渡る余地があった。
    useInlineAiStore.getState().reset();
    useEditorStore.getState().setEditor(null);
    useFocusedContentEditorStore.getState().setCurrent(null, null);
    // sceneId キーの live content（複数ペイン同期用の in-memory TipTap JSON）を
    // 全消去。clearContent は個別 id 削除のみで全消去手段が無かった。
    useSceneContentStore.setState({ liveContent: {} });
    useBarStore.getState().reset();
    usePanelStore.getState().reset();
    useResultsPanelStore.getState().reset();
    useLintStore.getState().clear();

    // 用語辞書は project スコープ (lint_term_dictionary)。isLoaded を倒して
    // 次回 lint / 設定パネル参照時に新 Project 分を読み直させる。
    useTermDictionaryStore.setState({
      rows: [],
      isLoaded: false,
      loading: false,
    });

    // Map の transient UI のみ破棄。board 選択 (activeBoardId) は
    // useMapBoardData が projectId 変化を検知して「このプロジェクトのボード」へ
    // 再解決する唯一の権威。ここで null にすると切替中に init effect と競合し、
    // 旧プロジェクトのボード/データが残る (または選択が消える) ため触らない。
    useMapStore.setState({
      focusedNodeId: null,
      searchVisible: false,
      pendingAutoArrange: null,
      pendingExport: null,
    });

    // プロンプトライブラリは project スコープ。loadedProjectId を倒して
    // 次回 ensureLoaded 参照時に新 Project 分を読み直させる。
    usePromptLibraryStore.setState({
      templates: [],
      loadedProjectId: null,
      isLoading: false,
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

    void initializeExternalMounts().catch(() => {});
  });
}
