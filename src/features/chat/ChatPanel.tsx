import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { useReducedMotion } from "@/lib/animation";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { useChatStore } from "./chatStore";
import { useSceneStore } from "@/features/tree/store";
import { useEditorStore } from "@/features/editor/editorStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { ChatMessage } from "./components/ChatMessage";
import { ChatMessageContextMenu } from "./components/ChatMessageContextMenu";
import { ChatPanelHeader } from "./components/ChatPanelHeader";
import { ChatInput } from "./components/ChatInput";
import { AgentProgressBar } from "./components/AgentProgressBar";
import { QuickActionStrip } from "./components/QuickActionStrip";
import { CodexExtractionDialog } from "@/features/codex/CodexExtractionDialog";
import { SnippetExtractionDialog } from "@/features/snippets/SnippetExtractionDialog";
import { ContextBar } from "./components/ContextBar";
import { computeSpotlightCandidates } from "./spotlightSuggestion";
import { SessionsPanel } from "./components/SessionsPanel";
import { CodexPopover } from "@/features/editor/CodexPopover";
import * as chatApi from "./chatApi";
import { useAiSettingsStore } from "./store";
import { normalizeModelId } from "@/features/attribution/AuthorshipMark";
import { useTreeStore } from "@/features/tree/treeStore";
import { copyWithAttribution } from "@/lib/clipboardAttribution";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTabStore } from "@/features/editor/tabStore";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import type { ChatMessage as ChatMessageType } from "./chatTypes";
import type { PinnedSnippetEntryWithData } from "./chatApi";

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

export function ChatPanel() {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const error = useChatStore((s) => s.error);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const editUserMessage = useChatStore((s) => s.editUserMessage);
  const regenerate = useChatStore((s) => s.regenerate);
  const contextTokenCount = useChatStore((s) => s.contextTokenCount);
  const contextLayers = useChatStore((s) => s.contextLayers);
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
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectSession = useChatStore((s) => s.selectSession);
  const createNewSession = useChatStore((s) => s.createNewSession);
  const ensureSession = useChatStore((s) => s.ensureSession);
  const chatScope = useChatStore((s) => s.chatScope);
  const scopeAnchorId = useChatStore((s) => s.scopeAnchorId);
  const setChatScope = useChatStore((s) => s.setChatScope);
  const includeBodies = useChatStore((s) => s.includeBodies);
  const setIncludeBodies = useChatStore((s) => s.setIncludeBodies);
  const starMessage = useChatStore((s) => s.starMessage);

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
    setActiveSceneId(treeActiveSceneId);
  }, [treeActiveSceneId, setActiveSceneId]);

  // スコープ切替 / シーン切替時にセッションを自動ロードし最新を選択 (P0-1)
  // scene スコープでシーン未確定の場合は何もしない。
  useEffect(() => {
    if (chatScope === "scene" && !treeActiveSceneId) return;
    let stale = false;
    const effectiveNodeId =
      chatScope === "scene"
        ? treeActiveSceneId || undefined
        : chatScope === "folder"
          ? (scopeAnchorId ?? undefined)
          : null;
    (async () => {
      await loadSessions(effectiveNodeId);
      if (stale) return;
      const { sessions } = useChatStore.getState();
      if (sessions.length > 0) {
        await selectSession(sessions[0].id);
      } else {
        await selectSession(null);
      }
    })();
    return () => {
      stale = true;
    };
  }, [
    treeActiveSceneId,
    chatScope,
    scopeAnchorId,
    loadSessions,
    selectSession,
  ]);

  useEffect(() => {
    refreshContextLayers();
  }, [
    treeActiveSceneId,
    activeSessionId,
    chatScope,
    scopeAnchorId,
    includeBodies,
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

  useEffect(() => {
    if (!activeSessionId) {
      setPinnedEntries([]);
      setPinnedSnippets([]);
      return;
    }
    chatApi.listPinnedCodexEntries(activeSessionId).then(setPinnedEntries);
    chatApi.listPinnedSnippetEntries(activeSessionId).then(setPinnedSnippets);
    setDismissedViaChildIds(new Set());
  }, [activeSessionId]);

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

  // Codex extraction dialog
  const [extractionDialog, setExtractionDialog] = useState<{
    open: boolean;
    messageId: string;
    content: string;
    messageRole: "user" | "assistant";
  }>({ open: false, messageId: "", content: "", messageRole: "assistant" });

  const createCodexEntry = useCodexStore((s) => s.create);

  const handleExtractCodexDetailed = useCallback(
    (messageId: string, selectedText: string | null) => {
      const msg = messages.find((m) => m.id === messageId);
      const content = selectedText ?? msg?.content ?? "";
      const messageRole =
        msg?.role === "user" ? ("user" as const) : ("assistant" as const);
      setExtractionDialog({ open: true, messageId, content, messageRole });
    },
    [messages],
  );

  const handleExtractCodexQuick = useCallback(
    async (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (!msg) return;
      const text = msg.content;
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
    [messages, createCodexEntry],
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
      const msg = messages.find((m) => m.id === messageId);
      const content = selectedText ?? msg?.content ?? "";
      const messageRole =
        msg?.role === "user" ? ("user" as const) : ("assistant" as const);
      setSnippetDialog({
        open: true,
        messageId,
        initialContent: content,
        messageRole,
      });
    },
    [messages],
  );

  const handleSaveSnippetQuick = useCallback(
    async (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (!msg) return;
      const content = msg.content;
      const title =
        content.replace(/\n/g, " ").slice(0, 30).trimEnd() || "Untitled";
      const snippet = await createSnippet(
        { title, content, sourceChatMessageId: messageId },
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
    [messages, createSnippet],
  );

  useEffect(() => {
    if (typeof bottomRef.current?.scrollIntoView === "function") {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const rawInsertFromChat = useEditorStore((s) => s.insertFromChat);

  const insertFromChat = useCallback(
    (content: string, messageId: string) => {
      const model = aiSettings?.model
        ? normalizeModelId(aiSettings.provider, aiSettings.model)
        : null;
      rawInsertFromChat(content, messageId, model ?? undefined);
    },
    [rawInsertFromChat, aiSettings],
  );

  const handleEditMessage = useCallback(
    (messageId: string) => {
      const content = editUserMessage(messageId);
      if (content && chatEditorRef.current) {
        chatEditorRef.current.commands.setContent(content);
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

  const handleStar = useCallback(
    (messageId: string, starred: boolean) => {
      starMessage(messageId, starred);
    },
    [starMessage],
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
        messageContent: msg.content,
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
    (markdown: string, options?: { overrideAgentMode?: boolean }) => {
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
    (scope: "scene" | "folder" | "project", anchorId?: string | null) => {
      setChatScope(scope, anchorId);
    },
    [setChatScope],
  );

  const handleSelectScene = useCallback((sceneId: string) => {
    // ツリーや他のパネルと同じ navigation 経路で対象シーンを開く:
    // 1) tab を pinned で開いて active 化、2) Editor パネルを前面化、
    // 3) tree の active scene を更新（その変化を ChatPanel の mirror effect が
    //    chatStore.activeSceneId に伝播する）。
    useTabStore.getState().openPinned(sceneId);
    useLayoutStore.getState().showPanel("editor");
    useTreeStore.getState().setActiveScene(sceneId);
  }, []);

  const handleNewSession = useCallback(() => {
    const nodeId =
      chatScope === "scene"
        ? chatSceneId || undefined
        : chatScope === "folder"
          ? (scopeAnchorId ?? undefined)
          : undefined;
    createNewSession("default-project", "New session", nodeId);
  }, [createNewSession, chatScope, scopeAnchorId, chatSceneId]);

  return (
    <div className="relative flex h-full flex-col bg-background">
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
      />

      <ContextBar
        pinnedEntries={[...pinnedEntries, ...inputPinnedEntries]}
        pinnedSnippets={pinnedSnippets}
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
        agentMode={agentMode}
        canUseCreator={false}
        projectOutline={projectOutline}
        chapterOutlines={chapterOutlines}
      />

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">
            {t("chat.noMessages")}
          </p>
        ) : (
          <div className="space-y-4" ref={(el) => setMessagesContainerEl(el)}>
            <AnimatePresence initial={false}>
              {messages
                .filter((msg) => msg.role !== "system" && !msg.isSummarized)
                .map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={
                      msg.role === "user" ? { opacity: 0, x: 20 } : false
                    }
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
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
                      onStar={handleStar}
                      onContextMenu={handleContextMenu}
                    />
                  </motion.div>
                ))}
            </AnimatePresence>
            {isStreaming && (
              <div
                data-testid="streaming-indicator"
                className="flex items-center gap-1 text-muted-foreground"
              >
                <span className="animate-pulse text-xs">
                  {t("chat.generating")}
                </span>
              </div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="border-t border-destructive bg-destructive/10 px-4 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {agentProgress && isStreaming && (
        <AgentProgressBar
          calls={agentProgress.totalCalls}
          maxCalls={agentProgress.maxCalls}
          tokensUsed={agentProgress.tokensUsed}
          tokenBudget={agentProgress.tokenBudget}
          currentToolName={agentProgress.currentToolName}
        />
      )}

      <QuickActionStrip hidden={inputHasText} />

      <ChatInput
        onSend={handleSend}
        disabled={isStreaming}
        editorRef={chatEditorRef}
        onMentionPin={(id) => handlePin(id, "codex")}
        onDetectedEntries={handleDetectedEntries}
        onHasTextChange={setInputHasText}
      />

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
}
