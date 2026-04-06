import { useState, useRef, useEffect, useCallback } from "react";
import { useChatStore } from "./chatStore";
import { useSceneStore } from "@/features/tree/store";
import { useEditorStore } from "@/features/editor/editorStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { ChatMessage } from "./components/ChatMessage";
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
import { modelSupportsTools } from "./agent/modelLimits";

interface SnippetDialogState {
  open: boolean;
  messageId: string;
  initialContent: string;
  messageRole: "user" | "assistant";
}

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const error = useChatStore((s) => s.error);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const contextTokenCount = useChatStore((s) => s.contextTokenCount);
  const contextLayers = useChatStore((s) => s.contextLayers);
  const systemPrompt = useChatStore(
    (s) => s.messages.find((m) => m.role === "system")?.content ?? "",
  );
  const setActiveSceneId = useChatStore((s) => s.setActiveSceneId);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const agentMode = useChatStore((s) => s.agentMode);
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  const agentProgress = useChatStore((s) => s.agentProgress);

  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const sceneTitle = useTreeStore(
    (s) => s.nodes.find((n) => n.id === activeSceneId)?.title ?? "このシーン",
  );

  const aiSettings = useAiSettingsStore((s) => s.settings);
  const loadAiSettings = useAiSettingsStore((s) => s.loadSettings);
  const currentModel = aiSettings?.model ?? "";
  const canUseTools = modelSupportsTools(currentModel);
  const thinkingEnabled = aiSettings?.thinkingEnabled ?? true;

  useEffect(() => {
    loadAiSettings();
  }, [loadAiSettings]);

  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);
  const [input, setInput] = useState("");

  useEffect(() => {
    setActiveSceneId(activeSceneId);
  }, [activeSceneId, setActiveSceneId]);

  // Pinned codex entries
  const [pinnedEntries, setPinnedEntries] = useState<
    import("./chatApi").PinnedCodexEntryWithData[]
  >([]);
  const [pinDialogOpen, setPinDialogOpen] = useState(false);

  useEffect(() => {
    if (!activeSessionId) {
      setPinnedEntries([]);
      return;
    }
    chatApi.listPinnedCodexEntries(activeSessionId).then(setPinnedEntries);
  }, [activeSessionId]);

  const pinnedIds = new Set(pinnedEntries.map((e) => e.id));

  const handlePin = useCallback(
    async (entryId: string) => {
      if (!activeSessionId) return;
      await chatApi.pinCodexEntry(activeSessionId, entryId);
      const updated = await chatApi.listPinnedCodexEntries(activeSessionId);
      setPinnedEntries(updated);
    },
    [activeSessionId],
  );

  const handleUnpin = useCallback(
    async (entryId: string) => {
      if (!activeSessionId) return;
      await chatApi.unpinCodexEntry(activeSessionId, entryId);
      const updated = await chatApi.listPinnedCodexEntries(activeSessionId);
      setPinnedEntries(updated);
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

  const handleExtractCodex = useCallback(
    (messageId: string, selectedText: string | null) => {
      const msg = messages.find((m) => m.id === messageId);
      const content = selectedText ?? msg?.content ?? "";
      const messageRole =
        msg?.role === "user" ? ("user" as const) : ("assistant" as const);
      setExtractionDialog({ open: true, messageId, content, messageRole });
    },
    [messages],
  );

  // Snippet extraction dialog
  const [snippetDialog, setSnippetDialog] = useState<SnippetDialogState>({
    open: false,
    messageId: "",
    initialContent: "",
    messageRole: "assistant",
  });

  const createSnippet = useSnippetStore((s) => s.create);

  const handleSaveSnippet = useCallback(
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

  useEffect(() => {
    if (typeof bottomRef.current?.scrollIntoView === "function") {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const rawInsertFromChat = useEditorStore((s) => s.insertFromChat);

  const insertFromChat = useCallback(
    (content: string, messageId: string) => {
      const model = aiSettings
        ? normalizeModelId(aiSettings.provider, aiSettings.model)
        : null;
      rawInsertFromChat(content, messageId, model ?? undefined);
    },
    [rawInsertFromChat, aiSettings],
  );

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    sendMessage(trimmed);
  };

  return (
    <div className="relative flex h-full flex-col bg-background">
      <ChatPanelHeader
        sessionsPanelOpen={sessionsPanelOpen}
        setSessionsPanelOpen={setSessionsPanelOpen}
        contextTokenCount={contextTokenCount}
        agentMode={agentMode}
        setAgentMode={setAgentMode}
        modelSupportsTools={canUseTools}
        currentModel={currentModel}
        thinkingEnabled={thinkingEnabled}
      />

      <ContextBar
        pinnedEntries={pinnedEntries}
        onUnpin={handleUnpin}
        onPin={handlePin}
        onOpenPinDialog={() => setPinDialogOpen(true)}
        contextTokenCount={contextTokenCount}
        contextLayers={contextLayers}
        systemPrompt={systemPrompt}
        model={currentModel}
        canUseCreator={canUseTools}
      />

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">
            メッセージはまだありません
          </p>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                msg={msg}
                isStreaming={isStreaming}
                onInsert={insertFromChat}
                onExtractCodex={handleExtractCodex}
                onSaveSnippet={handleSaveSnippet}
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
        value={input}
        onChange={setInput}
        onSend={handleSend}
        disabled={isStreaming}
      />

      <CodexExtractionDialog
        open={extractionDialog.open}
        messageId={extractionDialog.messageId}
        initialContent={extractionDialog.content}
        messageRole={extractionDialog.messageRole}
        onSave={async (data) => {
          await createCodexEntry(data);
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
          await createSnippet(data);
        }}
        onClose={() => setSnippetDialog((s) => ({ ...s, open: false }))}
      />
      <PinCodexDialog
        open={pinDialogOpen}
        pinnedIds={pinnedIds}
        withChildrenIds={
          new Set(pinnedEntries.filter((e) => e.withChildren).map((e) => e.id))
        }
        onPin={handlePin}
        onUnpin={handleUnpin}
        onToggleChildren={handleTogglePinChildren}
        onClose={() => setPinDialogOpen(false)}
      />
      {sessionsPanelOpen && (
        <SessionsPanel
          sceneTitle={sceneTitle}
          activeSceneId={activeSceneId}
          onClose={() => setSessionsPanelOpen(false)}
        />
      )}
    </div>
  );
}
