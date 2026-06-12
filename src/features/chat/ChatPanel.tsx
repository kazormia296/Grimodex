import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useReducedMotion } from "@/lib/animation";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { useChatStore } from "./chatStore";
import { useMapBoardAutoActivate } from "./useMapBoardAutoActivate";
import { useMapStore } from "@/features/map/mapStore";
import { getMapBoard } from "@/features/map/mapApi";
import { useSceneStore } from "@/features/tree/store";
import { useEditorStore } from "@/features/editor/editorStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { ChatMessage } from "./components/ChatMessage";
import { ChatMessageContextMenu } from "./components/ChatMessageContextMenu";
import { ChatPanelHeader } from "./components/ChatPanelHeader";
import { ChatInput, restoreSceneMentionChips } from "./components/ChatInput";
import { AgentProgressBar } from "./components/AgentProgressBar";
import { UserQuestionCard } from "./components/UserQuestionCard";
import { QuickActionStrip } from "./components/QuickActionStrip";
import { CodexExtractionDialog } from "@/features/codex/CodexExtractionDialog";
import { SnippetExtractionDialog } from "@/features/snippets/SnippetExtractionDialog";
import { ContextBar } from "./components/ContextBar";
import { computeSpotlightCandidates } from "./spotlightSuggestion";
import { SessionsPanel } from "./components/SessionsPanel";
import { CodexPopover } from "@/features/editor/CodexPopover";
import * as chatApi from "./chatApi";
import { useAiSettingsStore, isRagCapableProvider } from "./store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { normalizeModelId } from "@/features/attribution/AuthorshipMark";
import { useTreeStore } from "@/features/tree/treeStore";
import { copyWithAttribution } from "@/lib/clipboardAttribution";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTabStore } from "@/features/editor/tabStore";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { resolveScopeSessionKey, type ChatScope } from "./chatScope";
import { markStart, markEnd, recordMark } from "@/lib/perfLog";
import type { ChatMessage as ChatMessageType } from "./chatTypes";
import type {
  PinnedSnippetEntryWithData,
  PinnedStickyEntryWithData,
} from "./chatApi";
import { MessageBubbleSkeletonList } from "@/components/ui/skeleton-patterns";
import { stripToolProtocol } from "./toolProtocol";

/**
 * メッセージ全文を抽出 (Codex/Snippet) / エディタ挿入 / コピーに使う前の正規化。
 * assistant 本文に混入した擬似ツール記法 (<tool_call>/<tool_response>) を除去し、
 * ナレッジベースや本文への焼き込みを防ぐ。選択テキスト経路は描画 DOM 由来で
 * 既に浄化済みのため対象外（呼び出し側で selectedText を優先する）。
 */
function wholeMessageContent(msg: ChatMessageType | undefined): string {
  if (!msg) return "";
  return msg.role === "assistant"
    ? stripToolProtocol(msg.content)
    : msg.content;
}

/**
 * チャットのシーンスコープ選択からエディタへシーンを同期する。
 * Editor パネルが表示されている場合のみ、ツリーや他のパネルと同じ
 * navigation 経路で対象シーンを開く（tab を pinned で開いて active 化＋
 * Editor パネルを前面化）。非表示時はレイアウトに触れない —
 * openPinned は内部で ensureEditorVisible を呼ぶため、ガード外に出すと
 * 非表示の Editor が強制表示されてしまう。
 *
 * tree の active scene 更新はレイアウト非接触の純粋な state set。
 * その変化を ChatPanel の mirror effect が chatStore.activeSceneId に
 * 伝播するため、Editor 非表示でもチャットの scene anchor は追従する。
 */
export function selectSceneFromChat(sceneId: string): void {
  if (useLayoutStore.getState().isPanelActive("editor")) {
    useTabStore.getState().openPinned(sceneId);
    useLayoutStore.getState().showPanel("editor");
  }
  useTreeStore.getState().setActiveScene(sceneId);
}

interface SnippetDialogState {
  open: boolean;
  messageId: string;
  initialContent: string;
  messageRole: "user" | "assistant";
}

interface ContextMenuState {
  messageId: string;
  messageRole: "user" | "assistant";
  messageContent: string;
  selectedText: string | null;
  x: number;
  y: number;
}

export function ChatPanel({ isActive = true }: SlotPanelProps = {}) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const chatGate = useAiGate("chat");
  useMapBoardAutoActivate();
  const messages = useChatStore((s) => s.messages);
  const isLoadingMessages = useChatStore((s) => s.isLoadingMessages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const error = useChatStore((s) => s.error);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const editUserMessage = useChatStore((s) => s.editUserMessage);
  const regenerate = useChatStore((s) => s.regenerate);
  const contextTokenCount = useChatStore((s) => s.contextTokenCount);
  const contextLayers = useChatStore((s) => s.contextLayers);
  const pinsVersion = useChatStore((s) => s.pinsVersion);
  const projectOutline = useChatStore((s) => s.projectOutline);
  const chapterOutlines = useChatStore((s) => s.chapterOutlines);
  const detectedEntries = useChatStore((s) => s.detectedEntries);
  const alwaysEntries = useChatStore((s) => s.alwaysEntries);
  const systemPrompt = useChatStore((s) => s.lastSystemPrompt);
  const setActiveSceneId = useChatStore((s) => s.setActiveSceneId);
  const refreshContextLayers = useChatStore((s) => s.refreshContextLayers);
  const removeEntryFromAuto = useChatStore((s) => s.removeEntryFromAuto);
  const setInputPinnedEntryIds = useChatStore((s) => s.setInputPinnedEntryIds);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const agentMode = useChatStore((s) => s.agentMode);
  const agentProgress = useChatStore((s) => s.agentProgress);
  const pendingUserQuestion = useChatStore((s) => s.pendingUserQuestion);
  const resolveUserQuestion = useChatStore((s) => s.resolveUserQuestion);
  const dismissUserQuestion = useChatStore((s) => s.dismissUserQuestion);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectSession = useChatStore((s) => s.selectSession);
  const createNewSession = useChatStore((s) => s.createNewSession);
  const ensureSession = useChatStore((s) => s.ensureSession);
  const chatScope = useChatStore((s) => s.chatScope);
  const scopeAnchorId = useChatStore((s) => s.scopeAnchorId);
  const setChatScope = useChatStore((s) => s.setChatScope);
  const includeBodies = useChatStore((s) => s.includeBodies);
  const setIncludeBodies = useChatStore((s) => s.setIncludeBodies);
  const includeMapBoard = useChatStore((s) => s.includeMapBoard);
  const mapBoardIdFromStore = useChatStore((s) => s.mapBoardId);
  const setIncludeMapBoard = useChatStore((s) => s.setIncludeMapBoard);
  const ragEnabled = useChatStore((s) => s.ragEnabled);
  const setRagEnabled = useChatStore((s) => s.setRagEnabled);
  const [mapBoardTitle, setMapBoardTitle] = useState<string | null>(null);
  const syncInsertedToEditorMetadata = useChatStore(
    (s) => s.syncInsertedToEditorMetadata,
  );
  const createLinkedSession = useChatStore((s) => s.createLinkedSession);
  const dismissCacheInvalidated = useChatStore(
    (s) => s.dismissCacheInvalidated,
  );
  const summaryCount = useChatStore((s) => s.summaryCount);
  const maxSummaryGeneration = useChatStore((s) => s.maxSummaryGeneration);
  const cacheInvalidatedReason = useChatStore((s) => s.cacheInvalidatedReason);

  // Phase 2: scene と folder スコープでは本文（または集約本文）が context に
  // 入るので、そこから検出された codex を ContextBar に出す。project スコープは
  // 本文集約しないので detect 系は無効。
  const showDetectedEntries = chatScope !== "project";

  // chatStore の activeSceneId (手動変更可能)
  const chatSceneId = useChatStore((s) => s.activeSceneId);

  // ツリーのアクティブシーン → chatStore に同期
  const treeActiveSceneId = useSceneStore((s) => s.activeSceneId);
  const sceneTitle = useTreeStore(
    (s) =>
      s.nodes.find((n) => n.id === treeActiveSceneId)?.title ??
      t("chat.fallbackSceneTitle"),
  );

  const aiSettings = useAiSettingsStore((s) => s.settings);
  const loadAiSettings = useAiSettingsStore((s) => s.loadSettings);
  const currentModel = aiSettings?.model ?? "";

  useEffect(() => {
    loadAiSettings();
  }, [loadAiSettings]);

  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);
  const [inputHasText, setInputHasText] = useState(false);
  const chatEditorRef = useRef<Editor | null>(null);
  // メッセージリストコンテナの DOM 要素（Codex ポップオーバー用）
  const [messagesContainerEl, setMessagesContainerEl] =
    useState<HTMLElement | null>(null);

  const allCodexEntries = useCodexStore((s) => s.entries);

  // ツリーのシーン変更を chatStore に伝播
  useEffect(() => {
    markStart("chatPanel.mirrorEffect");
    try {
      setActiveSceneId(treeActiveSceneId);
    } finally {
      markEnd("chatPanel.mirrorEffect");
    }
  }, [treeActiveSceneId, setActiveSceneId]);

  // スコープ切替 / シーン切替時にセッションを自動ロードし最新を選択 (P0-1)
  // scene スコープでシーン未確定の場合は何もしない。
  // keepalive で hidden のときはシーン追従の load を bail し、再アクティブ化時に
  // isActive deps 経由で最終シーンの値で 1 回再実行して catch up する
  // (selectSession/loadSessions は replace-semantics なので中間シーンの残渣なし)。
  useEffect(() => {
    if (!isActive) return;
    if (chatScope === "scene" && !treeActiveSceneId) return;
    let stale = false;
    const {
      nodeId: effectiveNodeId,
      codexAnchorId,
      snippetAnchorId,
    } = resolveScopeSessionKey(chatScope, treeActiveSceneId, scopeAnchorId);
    (async () => {
      markStart("chatPanel.loadSessions");
      try {
        await loadSessions(effectiveNodeId, codexAnchorId, snippetAnchorId);
      } finally {
        markEnd("chatPanel.loadSessions");
      }
      if (stale) return;
      const { sessions } = useChatStore.getState();
      markStart("chatPanel.selectSessionAfterLoad");
      try {
        if (sessions.length > 0) {
          await selectSession(sessions[0].id);
        } else {
          await selectSession(null);
        }
      } finally {
        markEnd("chatPanel.selectSessionAfterLoad");
      }
    })();
    return () => {
      stale = true;
    };
  }, [
    isActive,
    treeActiveSceneId,
    chatScope,
    scopeAnchorId,
    loadSessions,
    selectSession,
  ]);

  // hidden 中は context layer の再構築 (DB 読込 + prompt 再構築 + lastSystemPrompt
  // 書込) を bail。再アクティブ化時に最終状態で 1 回再実行 (set は replace-semantics)。
  useEffect(() => {
    if (!isActive) return;
    refreshContextLayers();
  }, [
    isActive,
    treeActiveSceneId,
    activeSessionId,
    chatScope,
    scopeAnchorId,
    includeBodies,
    // agentMode は project スコープの集約 tier（push 全 synopsis vs pull 委譲）を
    // 左右するため deps に含める。これが無いとトグルしても lastSystemPrompt /
    // context bar が再構築されず、非 agent / CLI 送信は古い prompt を流用してしまう。
    agentMode,
    // provider も同様: pull 委譲は CLI（ツール無し）では無効化されるため、
    // OpenRouter↔CLI の切替で集約 tier が変わる。切替時に再構築が要る。
    aiSettings?.provider,
    includeMapBoard,
    mapBoardIdFromStore,
    allCodexEntries,
    refreshContextLayers,
  ]);

  // Pinned codex entries
  const [pinnedEntries, setPinnedEntries] = useState<
    import("./chatApi").PinnedCodexEntryWithData[]
  >([]);
  const [pinnedSnippets, setPinnedSnippets] = useState<
    PinnedSnippetEntryWithData[]
  >([]);
  // Map "Spotlight" stickies (chatSessionPinnedCodex with stickyId set).
  // Internal naming keeps "pinned" to match the underlying DB column /
  // chat API; the user-visible label says Spotlight.
  const [pinnedStickies, setPinnedStickies] = useState<
    PinnedStickyEntryWithData[]
  >([]);

  useEffect(() => {
    if (!isActive) return;
    if (!activeSessionId) {
      setPinnedEntries([]);
      setPinnedSnippets([]);
      setPinnedStickies([]);
      return;
    }
    chatApi.listPinnedCodexEntries(activeSessionId).then(setPinnedEntries);
    chatApi.listPinnedSnippetEntries(activeSessionId).then(setPinnedSnippets);
    chatApi.listPinnedStickyEntries(activeSessionId).then(setPinnedStickies);
    setDismissedViaChildIds(new Set());
    // pinsVersion bumps after any refreshContextLayers run; including it
    // in deps lets us pick up Map / Codex / Sticky pin changes that
    // happen outside this panel. hidden 中は bail し再アクティブ化で catch up。
  }, [isActive, activeSessionId, pinsVersion]);

  const pinnedIds = useMemo(
    () => new Set(pinnedEntries.map((e) => e.id)),
    [pinnedEntries],
  );
  const pinnedSnippetIds = useMemo(
    () => new Set(pinnedSnippets.map((s) => s.id)),
    [pinnedSnippets],
  );

  // 入力欄でリアルタイム検出されたCodexエントリID
  const [inputDetectedIds, setInputDetectedIds] = useState<string[]>([]);
  // ユーザーが × で明示却下したID（送信まで保持）
  const [inputDismissedIds, setInputDismissedIds] = useState<Set<string>>(
    new Set(),
  );
  // via表示の子エントリで × を押して一時非表示にしたID（セッション切替でリセット）
  const [dismissedViaChildIds, setDismissedViaChildIds] = useState<Set<string>>(
    new Set(),
  );
  const handleDetectedEntries = useCallback((ids: string[]) => {
    setInputDetectedIds(ids);
  }, []);

  // 入力欄検出エントリを chat_mention ピン済みとして扱う
  // （DB未確定のインメモリ状態。送信時に P2-5 が DB に永続化する）
  const inputPinnedEntries = useMemo(() => {
    return inputDetectedIds
      .filter((id) => !inputDismissedIds.has(id) && !pinnedIds.has(id))
      .map((id) => allCodexEntries.find((e) => e.id === id))
      .filter((e): e is (typeof allCodexEntries)[0] => e !== undefined)
      .map((e) => ({
        ...e,
        // UI-only flag: prompt uses the G21 block independently
        withChildren: true,
        pinnedType: "codex" as const,
        pinSource: "chat_mention" as const,
      }));
  }, [inputDetectedIds, inputDismissedIds, allCodexEntries, pinnedIds]);

  const inputPinnedIds = useMemo(
    () => new Set(inputPinnedEntries.map((e) => e.id)),
    [inputPinnedEntries],
  );

  // G21: chatStore に inputPinnedEntryIds を同期して prompt preview / copy に反映
  useEffect(() => {
    setInputPinnedEntryIds(inputPinnedEntries.map((e) => e.id));
  }, [inputPinnedEntries, setInputPinnedEntryIds]);

  const handlePin = useCallback(
    async (entryId: string, type: "codex" | "snippet" = "codex") => {
      // 新規シーンでメッセージ未送信のときは activeSessionId がまだ無い。
      // sendMessage と同じく、ピン操作時にもセッションを自動作成して紐づける。
      const sessionId = await ensureSession();
      if (!sessionId) return;
      await chatApi.pinCodexEntry(sessionId, entryId, false, "manual", type);
      // Bug#1: ピン直後にautoリストから即時除去
      removeEntryFromAuto(entryId);
      const [updatedCodex, updatedSnippets] = await Promise.all([
        chatApi.listPinnedCodexEntries(sessionId),
        chatApi.listPinnedSnippetEntries(sessionId),
      ]);
      setPinnedEntries(updatedCodex);
      setPinnedSnippets(updatedSnippets);
      await refreshContextLayers();
    },
    [ensureSession, removeEntryFromAuto, refreshContextLayers],
  );

  const handleUnpin = useCallback(
    async (entryId: string) => {
      if (!activeSessionId) return;
      await chatApi.unpinCodexEntry(activeSessionId, entryId);
      const [updatedCodex, updatedSnippets] = await Promise.all([
        chatApi.listPinnedCodexEntries(activeSessionId),
        chatApi.listPinnedSnippetEntries(activeSessionId),
      ]);
      setPinnedEntries(updatedCodex);
      setPinnedSnippets(updatedSnippets);
    },
    [activeSessionId],
  );

  // 手動ピンをautoに戻す: unpin後にコンテキスト再構築してautoリストへ即時反映
  const handleReturnToAuto = useCallback(
    async (entryId: string) => {
      await handleUnpin(entryId);
      await refreshContextLayers();
    },
    [handleUnpin, refreshContextLayers],
  );

  // ピンエントリをコンテキストから完全除去: unpin + autoリストからも即時除去
  const handleRemoveFromContext = useCallback(
    async (entryId: string) => {
      await handleUnpin(entryId);
      removeEntryFromAuto(entryId);
    },
    [handleUnpin, removeEntryFromAuto],
  );

  // autoエントリをコンテキストから即時除去（DBへの書き込みなし）
  const handleRemoveAuto = useCallback(
    (entryId: string) => {
      removeEntryFromAuto(entryId);
    },
    [removeEntryFromAuto],
  );

  // ピン除去の統合ハンドラ:
  // - 入力欄検出（インメモリ）ピン → 却下セットに追加（DB操作なし）
  // - DB確定ピン → handleRemoveFromContext
  const handleRemoveEntry = useCallback(
    async (entryId: string) => {
      if (inputPinnedIds.has(entryId)) {
        setInputDismissedIds((prev) => new Set([...prev, entryId]));
      } else {
        await handleRemoveFromContext(entryId);
      }
    },
    [inputPinnedIds, handleRemoveFromContext],
  );

  const handleDismissViaChild = useCallback((childId: string) => {
    setDismissedViaChildIds((prev) => new Set([...prev, childId]));
  }, []);

  const handleTogglePinChildren = useCallback(
    async (entryId: string, withChildren: boolean) => {
      const sessionId = await ensureSession();
      if (!sessionId) return;
      await chatApi.togglePinChildren(sessionId, entryId, withChildren);
      const updated = await chatApi.listPinnedCodexEntries(sessionId);
      setPinnedEntries(updated);
    },
    [ensureSession],
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // 末尾追従 (stick) フラグ。更新規則は handleListScroll のコメント参照。
  // virtualizer の補正述語からも読むため宣言だけ先に置く。
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  // 描画対象メッセージ (system / 要約済みを除外)。仮想化の count と
  // getItemKey の正本になるので、render 毎の filter 再生成を避けて memo する。
  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role !== "system" && !m.isSummarized),
    [messages],
  );

  // メッセージ一覧の仮想化 (perf 2026-06-10: 非仮想化・全件 ReactMarkdown・
  // isStreaming トグルで全件再描画の解消)。高さは行ごとにまちまちなので
  // measureElement による動的測定に任せ、estimateSize は初期推定のみ。
  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    overscan: 6,
    // id キーで測定キャッシュを安定させる (index キーだと削除で全行ズレる)
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
    // anchorTo: "end" / followOnAppend は使わない: virtual-core の at-end
    // scrollTop 補正は React が sized div の height を再レンダーする前に走る
    // ため旧 height でクランプされ、その時点の scroll イベントが
    // stickToBottomRef を false に倒して末尾追従が恒久停止する競合がある
    // (browser test 3 が gate)。末尾追従は下の stick + totalSize effect に
    // 一本化する。
  });

  // 末尾追従中は virtual-core 内蔵の「サイズ変化時 scrollTop 補正」を無効化
  // する (オプションではなくインスタンス公開フィールド)。isStreaming トグルで
  // 表示中の全 bubble が一斉に縮む (ChatMessage の showActions) と、デフォルト
  // 述語が負 delta を scrollTo で反映して scrollTop が上方向に動き、その
  // scroll イベントを handleListScroll がユーザーの上スクロールと誤認して
  // stick を恒久 OFF にするレースがある (遅いマシンで顕在化、browser test 3
  // が gate)。追従中のアンカー権威は下の totalSize effect ただ一つ。
  // 非追従中 (履歴読み) は読書位置の安定のためデフォルト相当の補正を残す。
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
    item,
    _delta,
    instance,
  ) =>
    !stickToBottomRef.current &&
    item.start < (instance.scrollOffset ?? 0) &&
    instance.scrollDirection !== "backward";

  // 仮想化では行が scroll out/in のたびに remount するため、AnimatePresence や
  // 無条件 initial では過去メッセージの入場アニメが再生されてしまう。
  // 「直前の messages からこの render で新規 append された user メッセージ」
  // だけに入場アニメを付ける。messages の遷移ごとに 1 回だけ確定させ、無関係な
  // 再レンダー (pinsVersion 等の非同期更新) では維持したいので、render 中の
  // 派生 state 調整 (adjust-state-on-render) で持つ。セッション読込直後
  // (prevLoading) は一括ロードなので全件アニメ無し (従来の AnimatePresence
  // initial={false} と同じ見え方)。
  const [entranceAnim, setEntranceAnim] = useState<{
    prevMessages: ChatMessageType[] | null;
    prevLoading: boolean;
    animateIds: ReadonlySet<string>;
  }>({ prevMessages: null, prevLoading: true, animateIds: new Set() });
  if (
    entranceAnim.prevMessages !== visibleMessages ||
    entranceAnim.prevLoading !== isLoadingMessages
  ) {
    const prev = entranceAnim.prevMessages;
    // ストリーミング delta は「同一 id 列のまま末尾 content だけが伸びる」更新。
    // チャット操作に長さ不変のまま中間 id が入れ替わる経路は無いので、
    // 長さ + 先頭/末尾 id の O(1) 比較で検出し、O(n) の id 差分も
    // render-phase setState (= 二重 render) も毎 delta で踏まないようにする。
    // prevMessages は古い参照のまま残るが、id 列が同じなので次の差分計算は
    // 壊れない (gate: ChatPanel.virtualization.test.tsx の render 回数 assert)。
    const isPureDelta =
      prev !== null &&
      entranceAnim.prevLoading === isLoadingMessages &&
      prev.length === visibleMessages.length &&
      prev.length > 0 &&
      prev[0].id === visibleMessages[0].id &&
      prev[prev.length - 1].id ===
        visibleMessages[visibleMessages.length - 1].id;
    if (!isPureDelta) {
      const canAnimate = prev !== null && !entranceAnim.prevLoading;
      let animateIds: ReadonlySet<string>;
      if (canAnimate) {
        const prevIds = new Set(prev!.map((m) => m.id));
        animateIds = new Set(
          visibleMessages
            .filter((m) => m.role === "user" && !prevIds.has(m.id))
            .map((m) => m.id),
        );
      } else {
        animateIds = new Set();
      }
      setEntranceAnim({
        prevMessages: visibleMessages,
        prevLoading: isLoadingMessages,
        animateIds,
      });
    }
  }

  // Codex extraction dialog
  const [extractionDialog, setExtractionDialog] = useState<{
    open: boolean;
    messageId: string;
    content: string;
    messageRole: "user" | "assistant";
  }>({ open: false, messageId: "", content: "", messageRole: "assistant" });

  const createCodexEntry = useCodexStore((s) => s.create);

  // NOTE: ChatMessage は memo 化されている。これらのハンドラを messages 依存に
  // すると delta 毎に新参照になり memo が全 bubble で破綻するため、最新 messages
  // は呼び出し時に getState() から読む（イベントハンドラなので call-time 読みで正)。
  const handleExtractCodexDetailed = useCallback(
    (messageId: string, selectedText: string | null) => {
      const msg = useChatStore
        .getState()
        .messages.find((m) => m.id === messageId);
      const content = selectedText ?? wholeMessageContent(msg);
      const messageRole =
        msg?.role === "user" ? ("user" as const) : ("assistant" as const);
      setExtractionDialog({ open: true, messageId, content, messageRole });
    },
    [],
  );

  const handleExtractCodexQuick = useCallback(
    async (messageId: string) => {
      const msg = useChatStore
        .getState()
        .messages.find((m) => m.id === messageId);
      if (!msg) return;
      const text = wholeMessageContent(msg);
      const name =
        text.replace(/\n/g, " ").slice(0, 30).trimEnd() || "Untitled";
      const entry = await createCodexEntry({
        name,
        type: "lore",
        summary: text,
        sourceChatMessageId: messageId,
      });
      if (entry) {
        await chatApi.updateMessageMetadata(messageId, {
          extractedCodex: [entry.id],
        });
        useLayoutStore.getState().showPanel("codex");
        useCodexStore.getState().requestSelectEntry(entry.id);
      }
    },
    [createCodexEntry],
  );

  // Snippet extraction dialog
  const [snippetDialog, setSnippetDialog] = useState<SnippetDialogState>({
    open: false,
    messageId: "",
    initialContent: "",
    messageRole: "assistant",
  });

  const createSnippet = useSnippetStore((s) => s.create);

  const handleSaveSnippetDetailed = useCallback(
    (messageId: string, selectedText: string | null) => {
      const msg = useChatStore
        .getState()
        .messages.find((m) => m.id === messageId);
      const content = selectedText ?? wholeMessageContent(msg);
      const messageRole =
        msg?.role === "user" ? ("user" as const) : ("assistant" as const);
      setSnippetDialog({
        open: true,
        messageId,
        initialContent: content,
        messageRole,
      });
    },
    [],
  );

  const handleSaveSnippetQuick = useCallback(
    async (messageId: string) => {
      const msg = useChatStore
        .getState()
        .messages.find((m) => m.id === messageId);
      if (!msg) return;
      const content = wholeMessageContent(msg);
      const title =
        content.replace(/\n/g, " ").slice(0, 30).trimEnd() || "Untitled";
      const snippet = await createSnippet(
        {
          title,
          content,
          sourceChatMessageId: messageId,
          contentSource: msg.role === "assistant" ? "ai" : "human",
        },
        { silent: true },
      );
      if (snippet) {
        await chatApi.updateMessageMetadata(messageId, {
          extractedSnippets: [snippet.id],
        });
        useLayoutStore.getState().showPanel("snippets");
        useSnippetStore.getState().requestSelectEntry(snippet.id);
      }
    },
    [createSnippet],
  );

  const scrollToBottom = useCallback(() => {
    const node = bottomRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      // smooth だと delta 毎に進行中アニメを cancel+restart してレイアウトを
      // 強制するため auto。stick ガードと併せてストリーミング中のカクつき
      // と「上スクロールしても下端に引き戻される」UX バグを解消する。
      node.scrollIntoView({ behavior: "auto" });
    }
  }, []);

  // 末尾追従 (stick) の更新規則:
  //   - 最下部 120px 以内に入ったら ON (旧 isNearBottom と同じ閾値)
  //   - 「上方向への移動 かつ 120px 超」のときだけ OFF
  //   - 下方向の移動で 120px 超のままでも維持する
  // 最後の条件が肝: ストリーミング中は自前の再アンカー (scrollIntoView) が
  // 測定途中の旧 height に短着地して distance>120 の scroll イベントを発火
  // しうる。distance だけで OFF にすると自分のスクロールで追従を殺して
  // ドリフトが恒久化する (browser test 3 が gate)。上方向はユーザーの
  // 履歴読みだけなので、方向で意図を分離できる。
  // (ref の宣言は virtualizer の補正述語から参照するため上方にある)
  const handleListScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 120) {
      stickToBottomRef.current = true;
    } else if (el.scrollTop < lastScrollTopRef.current) {
      stickToBottomRef.current = false;
    }
    lastScrollTopRef.current = el.scrollTop;
  }, []);

  // 動的測定で totalSize が確定 / 伸長するたび、追従中なら末尾へ貼り直す。
  // render 後 (= sized div の height が新しい) の effect で再アンカーするのが
  // 唯一の追従機構。新規 append (count 変化) もストリーミング伸長 (測定変化)
  // もどちらも totalSize に現れるのでこの 1 本で覆える。
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    // 保険: 実際は最下部近傍に居るのに stick が倒れていたら立て直す。
    // プログラム起因 scroll の誤検知が補正述語の無効化をすり抜けても、
    // 次の伸長で追従に復帰できる (恒久停止だけは構造的に防ぐ)。
    if (!stickToBottomRef.current) {
      const el = scrollContainerRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
        stickToBottomRef.current = true;
      }
    }
    if (stickToBottomRef.current) scrollToBottom();
  }, [totalSize, scrollToBottom]);

  // セッション切替後、メッセージ load が完了した最初の render で必ず末尾へ
  // ジャンプする。selectSession は activeSessionId を切り替えた瞬間に
  // messages を空 + isLoadingMessages=true にし、load 完了時に messages と
  // isLoadingMessages=false を 1 回の set で同時更新する (chatStore.selectSession)。
  // そのため activeSessionId だけを deps にすると、本文到着前 (空) に
  // ジャンプして履歴のあるセッションを開くたび先頭に着地する回帰になる。
  // load 完了を待ってジャンプする。
  //
  // ジャンプ先は推定 totalSize 由来でズレうるが、stick を立てておけば以降の
  // 動的測定差分は totalSize effect の再アンカーで収束する。同一セッション内の
  // ストリーミング追従も同 effect に任せる (旧実装の messages 依存
  // isNearBottom 追従 effect は廃止)。
  const lastJumpedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeSessionId !== lastJumpedSessionRef.current &&
      !isLoadingMessages
    ) {
      lastJumpedSessionRef.current = activeSessionId;
      stickToBottomRef.current = true;
      scrollToBottom();
    }
  }, [activeSessionId, isLoadingMessages, scrollToBottom]);

  const rawInsertFromChat = useEditorStore((s) => s.insertFromChat);

  const insertFromChat = useCallback(
    (content: string, messageId: string) => {
      const model = aiSettings?.model
        ? normalizeModelId(aiSettings.provider, aiSettings.model)
        : null;
      const ok = rawInsertFromChat(content, messageId, model ?? undefined);
      if (ok) {
        syncInsertedToEditorMetadata(messageId);
      }
    },
    [rawInsertFromChat, aiSettings, syncInsertedToEditorMetadata],
  );

  const handleEditMessage = useCallback(
    (messageId: string) => {
      const { content, mentionedSceneIds } = editUserMessage(messageId);
      if (content && chatEditorRef.current) {
        chatEditorRef.current.commands.setContent(content);
        // tiptap-markdown が mention を `@Title` に潰すため metadata から
        // chip を再構築する (詳細は restoreSceneMentionChips のコメント参照)。
        if (mentionedSceneIds && mentionedSceneIds.length > 0) {
          restoreSceneMentionChips(chatEditorRef.current, mentionedSceneIds);
        }
        chatEditorRef.current.commands.focus("end");
      }
    },
    [editUserMessage],
  );

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      deleteMessage(messageId);
    },
    [deleteMessage],
  );

  const handleRegenerate = useCallback(
    (messageId: string) => {
      regenerate(messageId);
    },
    [regenerate],
  );

  const handleRetryWithAgent = useCallback(
    (messageId: string) => {
      regenerate(messageId, { withAgentMode: true });
    },
    [regenerate],
  );

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, msg: ChatMessageType) => {
      const sel = window.getSelection();
      let selectedText: string | null = null;
      if (sel && !sel.isCollapsed) {
        const text = sel.toString().trim();
        if (text.length > 0) selectedText = text;
      }
      setContextMenu({
        messageId: msg.id,
        messageRole: msg.role === "user" ? "user" : "assistant",
        messageContent: wholeMessageContent(msg),
        selectedText,
        x: e.clientX,
        y: e.clientY,
      });
    },
    [],
  );

  const handleContextCopy = useCallback(
    (text: string, messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      const source = msg?.role === "assistant" ? "ai" : "human";
      copyWithAttribution(text, source)
        .then(() => toast.success(t("chat.copied")))
        .catch(() => toast.error(t("chat.copyFailed")));
    },
    [messages, t],
  );

  const handleSend = useCallback(
    (
      markdown: string,
      options?: {
        overrideAgentMode?: boolean;
        mentionedSceneIds?: string[];
      },
    ) => {
      const trimmed = markdown.trim();
      if (!trimmed || isStreaming) return;
      // 送信時に却下セットをリセット（次のメッセージでは再検出可能にする）
      setInputDismissedIds(new Set());
      // Flush any pending editor save so sendMessage reads latest scene content from DB.
      const flushAndSend = async () => {
        if (chatSceneId) await saveScene(chatSceneId);
        sendMessage(trimmed, undefined, options);
      };
      void flushAndSend();
    },
    [isStreaming, sendMessage, chatSceneId],
  );

  const handleScopeChange = useCallback(
    (scope: ChatScope, anchorId?: string | null) => {
      setChatScope(scope, anchorId);
    },
    [setChatScope],
  );

  const handleSelectScene = useCallback((sceneId: string) => {
    selectSceneFromChat(sceneId);
  }, []);

  const handleNewSession = useCallback(() => {
    const { nodeId, codexAnchorId, snippetAnchorId } = resolveScopeSessionKey(
      chatScope,
      chatSceneId,
      scopeAnchorId,
    );
    createNewSession(
      getCurrentProjectId(),
      "New session",
      nodeId === null ? undefined : nodeId,
      codexAnchorId,
      snippetAnchorId,
    );
  }, [createNewSession, chatScope, scopeAnchorId, chatSceneId]);

  // Map overlay chip 表示用の board title 取得。includeMapBoard が ON のとき
  // のみ fetch する（OFF 時に余計な DB アクセスを発生させない）。
  const activeBoardIdForChip = useMapStore((s) => s.activeBoardId);
  const resolvedMapBoardId = mapBoardIdFromStore ?? activeBoardIdForChip;
  // Map 注入トグルは Map panel が表示されている場合のみ有効。
  // `useMapBoardAutoActivate` と同じ `isPanelActive("map")` 述語で gate し、
  // overlay の auto-OFF と disabled 状態を一致させる。
  const mapPanelActive = useLayoutStore((s) => s.isPanelActive("map"));
  useEffect(() => {
    if (!includeMapBoard || !resolvedMapBoardId) {
      setMapBoardTitle(null);
      return;
    }
    let cancelled = false;
    getMapBoard(resolvedMapBoardId)
      .then((b) => {
        if (!cancelled) setMapBoardTitle(b?.title ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [includeMapBoard, resolvedMapBoardId]);

  const handleToggleMapOverlay = useCallback(() => {
    const next = !includeMapBoard;
    setIncludeMapBoard(next, {
      source: "user",
      boardId: next ? (resolvedMapBoardId ?? null) : null,
    });
  }, [includeMapBoard, resolvedMapBoardId, setIncludeMapBoard]);

  // Web 検索 (RAG): OpenRouter / Anthropic のみ対応。他プロバイダではトグル無効。
  const ragCapable = isRagCapableProvider(aiSettings?.provider);
  const handleToggleRag = useCallback(() => {
    setRagEnabled(!ragEnabled);
  }, [ragEnabled, setRagEnabled]);

  const __renderResult = (
    <div className="glass-chat relative flex h-full flex-col bg-background">
      {/* メッセージリスト内の Codex ハイライトポップオーバー（単一インスタンス） */}
      <CodexPopover containerEl={messagesContainerEl} />

      <ChatPanelHeader
        sessionsPanelOpen={sessionsPanelOpen}
        setSessionsPanelOpen={setSessionsPanelOpen}
        chatScope={chatScope}
        scopeAnchorId={scopeAnchorId}
        chatSceneId={chatSceneId}
        editorActiveSceneId={treeActiveSceneId}
        onScopeChange={handleScopeChange}
        onSelectScene={handleSelectScene}
        onNewSession={handleNewSession}
        includeBodies={includeBodies}
        onToggleIncludeBodies={() => setIncludeBodies(!includeBodies)}
        includeMapBoard={includeMapBoard}
        mapBoardTitle={mapBoardTitle}
        mapDisabled={!mapPanelActive}
        onToggleIncludeMapBoard={handleToggleMapOverlay}
        ragEnabled={ragEnabled}
        ragDisabled={!ragCapable}
        onToggleRag={handleToggleRag}
      />

      <ContextBar
        pinnedEntries={[...pinnedEntries, ...inputPinnedEntries]}
        pinnedSnippets={pinnedSnippets}
        pinnedStickies={pinnedStickies}
        onUnpinSticky={async (stickyId) => {
          if (!activeSessionId) return;
          await chatApi.unpinStickyEntry(activeSessionId, stickyId);
          await useChatStore.getState().refreshContextLayers();
        }}
        detectedEntries={
          showDetectedEntries
            ? detectedEntries.filter((e) => !inputPinnedIds.has(e.id))
            : []
        }
        alwaysEntries={alwaysEntries.filter((e) => !inputPinnedIds.has(e.id))}
        spotlightCandidateIds={computeSpotlightCandidates(
          showDetectedEntries ? detectedEntries : [],
          alwaysEntries,
          new Set([...pinnedIds, ...inputPinnedIds]),
        )}
        onReturnToAuto={handleReturnToAuto}
        onRemove={handleRemoveEntry}
        onRemoveAuto={handleRemoveAuto}
        onPin={handlePin}
        onDismissViaChild={handleDismissViaChild}
        dismissedViaChildIds={dismissedViaChildIds}
        pinnedSnippetIds={pinnedSnippetIds}
        onPinEntry={handlePin}
        onUnpinEntry={handleUnpin}
        onTogglePinChildren={handleTogglePinChildren}
        contextTokenCount={contextTokenCount}
        contextLayers={contextLayers}
        systemPrompt={systemPrompt}
        model={currentModel}
        canUseCreator={false}
        projectOutline={projectOutline}
        chapterOutlines={chapterOutlines}
        summaryCount={summaryCount}
        maxSummaryGeneration={maxSummaryGeneration}
        onCreateLinkedSession={() => void createLinkedSession()}
        cacheInvalidatedReason={cacheInvalidatedReason}
        onDismissCacheInvalidated={dismissCacheInvalidated}
      />

      <div
        ref={scrollContainerRef}
        data-testid="chat-scroll-container"
        onScroll={handleListScroll}
        // overflow-anchor: ブラウザ自身の scroll anchoring も stick 判定を汚す
        // プログラム起因 scrollTop 移動源になるため切る (アンカーは自前管理)
        className="flex-1 overflow-y-auto px-4 py-3 [overflow-anchor:none]"
      >
        {isLoadingMessages ? (
          <MessageBubbleSkeletonList testId="chat-messages-loading" />
        ) : messages.length === 0 ? (
          <div className="mt-8 text-center">
            <p className="text-sm text-muted-foreground">
              {t("chat.noMessages")}
            </p>
            {/* AI ミス免責: 常設だと狭いパネルで邪魔なので空状態にのみ表示。
                会話が始まると消える（期待値調整は開封時で十分）。 */}
            <p className="mt-2 text-[11px] leading-tight text-muted-foreground/70">
              {t("chat.disclaimer")}
            </p>
          </div>
        ) : (
          <>
            {/* 行は absolute + translateY 配置なので、行間 (旧 space-y-4) は
                各行の pb-4 として測定高さに含める */}
            <div
              data-testid="chat-virtual-list"
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
              // ref はインライン関数にしない: render 毎に identity が変わると
              // React が commit 毎に null→el で呼び直し、setState(null) 経由の
              // 余剰 render が毎 delta に乗る (gate: virtualization.test.tsx)
              ref={setMessagesContainerEl}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const msg = visibleMessages[vItem.index];
                if (!msg) return null;
                const animateIn = entranceAnim.animateIds.has(msg.id);
                return (
                  <div
                    key={msg.id}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full pb-4"
                    style={{ transform: `translateY(${vItem.start}px)` }}
                  >
                    <motion.div
                      data-animate-in={animateIn || undefined}
                      initial={animateIn ? { opacity: 0, x: 20 } : false}
                      animate={{ opacity: 1, x: 0 }}
                      transition={
                        reduced
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 260, damping: 22 }
                      }
                    >
                      <ChatMessage
                        msg={msg}
                        isStreaming={isStreaming}
                        onInsert={insertFromChat}
                        onExtractCodexQuick={handleExtractCodexQuick}
                        onExtractCodexDetailed={handleExtractCodexDetailed}
                        onSaveSnippetQuick={handleSaveSnippetQuick}
                        onSaveSnippetDetailed={handleSaveSnippetDetailed}
                        onEdit={handleEditMessage}
                        onDelete={handleDeleteMessage}
                        onRegenerate={handleRegenerate}
                        onRetryWithAgent={handleRetryWithAgent}
                        onContextMenu={handleContextMenu}
                      />
                    </motion.div>
                  </div>
                );
              })}
            </div>
            {/* 質問カード / streaming indicator はスペーサ外の通常フロー。
                高さは virtualizer の totalSize に乗らないが、scrollToBottom
                が bottomRef (全兄弟の後) に着地するため末尾はズレない。 */}
            {pendingUserQuestion &&
              pendingUserQuestion.sessionId === activeSessionId && (
                <UserQuestionCard
                  key={pendingUserQuestion.toolCallId}
                  spec={pendingUserQuestion.spec}
                  onSubmit={resolveUserQuestion}
                  onSkip={dismissUserQuestion}
                />
              )}
            {isStreaming && !pendingUserQuestion && (
              <div
                data-testid="streaming-indicator"
                className="flex items-center gap-1 text-muted-foreground"
              >
                <span className="animate-pulse text-xs">
                  {t("chat.generating")}
                </span>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="border-t border-destructive bg-destructive/10 px-4 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {agentProgress && isStreaming && !pendingUserQuestion && (
        <AgentProgressBar
          calls={agentProgress.totalCalls}
          maxCalls={agentProgress.maxCalls}
          tokensUsed={agentProgress.tokensUsed}
          tokenBudget={agentProgress.tokenBudget}
          currentToolName={agentProgress.currentToolName}
        />
      )}

      {chatGate.presentation === "hidden" ? (
        // chat がポリシーで OFF: composer 自体を隠す（モード扱い）。履歴は残す。
        // 「なぜ／変更」の導線として project 設定を開くリンクを置く
        // (エディタヘッダの AiPolicyBadge と同じ open-settings イベント)。
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {t("chat.aiOffNote")}{" "}
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("open-settings", {
                  detail: { category: "project" },
                }),
              )
            }
            className="underline hover:text-foreground"
          >
            {t("chat.aiOffOpenSettings")}
          </button>
        </div>
      ) : (
        <>
          <QuickActionStrip hidden={inputHasText} />

          <ChatInput
            onSend={handleSend}
            disabled={isStreaming}
            policyDisabled={chatGate.presentation !== "enabled"}
            editorRef={chatEditorRef}
            onMentionPin={(id) => handlePin(id, "codex")}
            onDetectedEntries={handleDetectedEntries}
            onHasTextChange={setInputHasText}
          />
        </>
      )}

      <CodexExtractionDialog
        open={extractionDialog.open}
        messageId={extractionDialog.messageId}
        initialContent={extractionDialog.content}
        messageRole={extractionDialog.messageRole}
        onSave={async (data) => {
          const entry = await createCodexEntry(data);
          if (entry && extractionDialog.messageId) {
            await chatApi.updateMessageMetadata(extractionDialog.messageId, {
              extractedCodex: [entry.id],
            });
          }
          setExtractionDialog({
            open: false,
            messageId: "",
            content: "",
            messageRole: "assistant",
          });
          if (entry) {
            useLayoutStore.getState().showPanel("codex");
            useCodexStore.getState().requestSelectEntry(entry.id);
          }
        }}
        onClose={() =>
          setExtractionDialog({
            open: false,
            messageId: "",
            content: "",
            messageRole: "assistant",
          })
        }
      />
      <SnippetExtractionDialog
        open={snippetDialog.open}
        initialContent={snippetDialog.initialContent}
        messageId={snippetDialog.messageId}
        messageRole={snippetDialog.messageRole}
        onSave={async (data) => {
          const snippet = await createSnippet(data, { silent: true });
          if (snippet && snippetDialog.messageId) {
            await chatApi.updateMessageMetadata(snippetDialog.messageId, {
              extractedSnippets: [snippet.id],
            });
          }
          if (snippet) {
            useLayoutStore.getState().showPanel("snippets");
            useSnippetStore.getState().requestSelectEntry(snippet.id);
          }
        }}
        onClose={() => setSnippetDialog((s) => ({ ...s, open: false }))}
      />
      {sessionsPanelOpen && (
        <SessionsPanel
          sceneTitle={sceneTitle}
          activeSceneId={treeActiveSceneId}
          onClose={() => setSessionsPanelOpen(false)}
        />
      )}
      {contextMenu && (
        <ChatMessageContextMenu
          messageId={contextMenu.messageId}
          messageRole={contextMenu.messageRole}
          messageContent={contextMenu.messageContent}
          selectedText={contextMenu.selectedText}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onInsert={insertFromChat}
          onExtractCodexQuick={handleExtractCodexQuick}
          onExtractCodexDetailed={handleExtractCodexDetailed}
          onSaveSnippetQuick={handleSaveSnippetQuick}
          onSaveSnippetDetailed={handleSaveSnippetDetailed}
          onCopy={handleContextCopy}
          onEdit={handleEditMessage}
          onDelete={handleDeleteMessage}
          onRegenerate={handleRegenerate}
        />
      )}
    </div>
  );
  recordMark("chatPanel.render", performance.now() - __perfStart, __perfStart);
  return __renderResult;
}
