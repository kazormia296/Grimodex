import { useState, useRef, useEffect, useCallback } from "react";
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
import { CodexExtractionDialog } from "@/features/codex/CodexExtractionDialog";
import { SnippetExtractionDialog } from "@/features/snippets/SnippetExtractionDialog";
import { ContextBar } from "./components/ContextBar";
import { PinCodexDialog } from "./components/PinCodexDialog";
import { SessionsPanel } from "./components/SessionsPanel";
import * as chatApi from "./chatApi";
import { useAiSettingsStore } from "./store";
import { normalizeModelId } from "@/features/attribution/AuthorshipMark";
import { useTreeStore } from "@/features/tree/treeStore";
import { copyWithAttribution } from "@/lib/clipboardAttribution";
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
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const error = useChatStore((s) => s.error);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const editUserMessage = useChatStore((s) => s.editUserMessage);
  const regenerate = useChatStore((s) => s.regenerate);
  const contextTokenCount = useChatStore((s) => s.contextTokenCount);
  const contextLayers = useChatStore((s) => s.contextLayers);
  const detectedEntries = useChatStore((s) => s.detectedEntries);
  const alwaysEntries = useChatStore((s) => s.alwaysEntries);
  const systemPrompt = useChatStore(
    (s) => s.messages.find((m) => m.role === "system")?.content ?? "",
  );
  const setActiveSceneId = useChatStore((s) => s.setActiveSceneId);
  const refreshContextLayers = useChatStore((s) => s.refreshContextLayers);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const agentProgress = useChatStore((s) => s.agentProgress);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectSession = useChatStore((s) => s.selectSession);
  const createNewSession = useChatStore((s) => s.createNewSession);
  const isGlobalChat = useChatStore((s) => s.isGlobalChat);
  const setIsGlobalChat = useChatStore((s) => s.setIsGlobalChat);
  const starMessage = useChatStore((s) => s.starMessage);

  // chatStore の activeSceneId (手動変更可能)
  const chatSceneId = useChatStore((s) => s.activeSceneId);

  // ツリーのアクティブシーン → chatStore に同期
  const treeActiveSceneId = useSceneStore((s) => s.activeSceneId);
  const sceneTitle = useTreeStore(
    (s) =>
      s.nodes.find((n) => n.id === treeActiveSceneId)?.title ?? "このシーン",
  );

  const aiSettings = useAiSettingsStore((s) => s.settings);
  const loadAiSettings = useAiSettingsStore((s) => s.loadSettings);
  const currentModel = aiSettings?.model ?? "";

  useEffect(() => {
    loadAiSettings();
  }, [loadAiSettings]);

  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);
  const chatEditorRef = useRef<Editor | null>(null);

  // ツリーのシーン変更を chatStore に伝播
  useEffect(() => {
    setActiveSceneId(treeActiveSceneId);
  }, [treeActiveSceneId, setActiveSceneId]);

  // シーン/グローバルモード切替時にセッションを自動ロードし最新を選択 (P0-1)
  // シーンIDが空かつグローバルモードでもない初期状態ではスキップ
  useEffect(() => {
    if (!treeActiveSceneId && !isGlobalChat) return;
    let stale = false;
    const effectiveNodeId = isGlobalChat
      ? null
      : treeActiveSceneId || undefined;
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
  }, [treeActiveSceneId, isGlobalChat, loadSessions, selectSession]);

  useEffect(() => {
    refreshContextLayers();
  }, [treeActiveSceneId, activeSessionId, isGlobalChat, refreshContextLayers]);

  // Pinned codex entries
  const [pinnedEntries, setPinnedEntries] = useState<
    import("./chatApi").PinnedCodexEntryWithData[]
  >([]);
  const [pinnedSnippets, setPinnedSnippets] = useState<
    PinnedSnippetEntryWithData[]
  >([]);
  const [pinDialogOpen, setPinDialogOpen] = useState(false);

  useEffect(() => {
    if (!activeSessionId) {
      setPinnedEntries([]);
      setPinnedSnippets([]);
      return;
    }
    chatApi.listPinnedCodexEntries(activeSessionId).then(setPinnedEntries);
    chatApi.listPinnedSnippetEntries(activeSessionId).then(setPinnedSnippets);
  }, [activeSessionId]);

  const pinnedIds = new Set(pinnedEntries.map((e) => e.id));
  const pinnedSnippetIds = new Set(pinnedSnippets.map((s) => s.id));

  const handlePin = useCallback(
    async (entryId: string, type: "codex" | "snippet" = "codex") => {
      if (!activeSessionId) return;
      await chatApi.pinCodexEntry(
        activeSessionId,
        entryId,
        false,
        "manual",
        type,
      );
      const [updatedCodex, updatedSnippets] = await Promise.all([
        chatApi.listPinnedCodexEntries(activeSessionId),
        chatApi.listPinnedSnippetEntries(activeSessionId),
      ]);
      setPinnedEntries(updatedCodex);
      setPinnedSnippets(updatedSnippets);
    },
    [activeSessionId],
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

  const handleTogglePinChildren = useCallback(
    async (entryId: string, withChildren: boolean) => {
      if (!activeSessionId) return;
      await chatApi.togglePinChildren(activeSessionId, entryId, withChildren);
      const updated = await chatApi.listPinnedCodexEntries(activeSessionId);
      setPinnedEntries(updated);
    },
    [activeSessionId],
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
      }
      toast.success("Codexに抽出しました");
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
      const snippet = await createSnippet({
        title,
        content,
        sourceChatMessageId: messageId,
      });
      if (snippet) {
        await chatApi.updateMessageMetadata(messageId, {
          extractedSnippets: [snippet.id],
        });
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
        .then(() => toast.success("コピーしました"))
        .catch(() => toast.error("コピーに失敗しました"));
    },
    [messages],
  );

  const handleSend = useCallback(
    (markdown: string) => {
      const trimmed = markdown.trim();
      if (!trimmed || isStreaming) return;
      sendMessage(trimmed);
    },
    [isStreaming, sendMessage],
  );

  const handleToggleGlobalChat = useCallback(() => {
    setIsGlobalChat(!isGlobalChat);
  }, [isGlobalChat, setIsGlobalChat]);

  const handleSceneChange = useCallback(
    (sceneId: string) => {
      // isGlobalChat が ON のときシーンを変えると自動でOFFになる (setActiveSceneId 内で処理)
      setActiveSceneId(sceneId);
    },
    [setActiveSceneId],
  );

  const handleNewSession = useCallback(() => {
    createNewSession(
      "default-project",
      "New session",
      isGlobalChat ? undefined : chatSceneId || undefined,
    );
  }, [createNewSession, isGlobalChat, chatSceneId]);

  return (
    <div className="relative flex h-full flex-col bg-background">
      <ChatPanelHeader
        sessionsPanelOpen={sessionsPanelOpen}
        setSessionsPanelOpen={setSessionsPanelOpen}
        isGlobalChat={isGlobalChat}
        onToggleGlobalChat={handleToggleGlobalChat}
        chatSceneId={chatSceneId}
        onSceneChange={handleSceneChange}
        onNewSession={handleNewSession}
      />

      <ContextBar
        pinnedEntries={pinnedEntries}
        pinnedSnippets={pinnedSnippets}
        detectedEntries={detectedEntries}
        alwaysEntries={alwaysEntries}
        onUnpin={handleUnpin}
        onPin={handlePin}
        onOpenPinDialog={() => setPinDialogOpen(true)}
        contextTokenCount={contextTokenCount}
        contextLayers={contextLayers}
        systemPrompt={systemPrompt}
        model={currentModel}
        canUseCreator={false}
      />

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">
            メッセージはまだありません
          </p>
        ) : (
          <div className="space-y-4">
            {messages
              .filter((msg) => msg.role !== "system" && !msg.isSummarized)
              .map((msg) => (
                <ChatMessage
                  key={msg.id}
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
                  onStar={handleStar}
                  onContextMenu={handleContextMenu}
                />
              ))}
            {isStreaming && (
              <div
                data-testid="streaming-indicator"
                className="flex items-center gap-1 text-muted-foreground"
              >
                <span className="animate-pulse text-xs">生成中…</span>
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

      <ChatInput
        onSend={handleSend}
        disabled={isStreaming}
        editorRef={chatEditorRef}
        isGlobalChat={isGlobalChat}
        onMentionPin={(id) => handlePin(id, "codex")}
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
          const snippet = await createSnippet(data);
          if (snippet && snippetDialog.messageId) {
            await chatApi.updateMessageMetadata(snippetDialog.messageId, {
              extractedSnippets: [snippet.id],
            });
          }
        }}
        onClose={() => setSnippetDialog((s) => ({ ...s, open: false }))}
      />
      <PinCodexDialog
        open={pinDialogOpen}
        pinnedIds={pinnedIds}
        withChildrenIds={
          new Set(pinnedEntries.filter((e) => e.withChildren).map((e) => e.id))
        }
        pinnedSnippetIds={pinnedSnippetIds}
        onPin={handlePin}
        onUnpin={handleUnpin}
        onToggleChildren={handleTogglePinChildren}
        onClose={() => setPinDialogOpen(false)}
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
