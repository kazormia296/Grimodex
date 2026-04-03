import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
} from "react";
import { Send } from "lucide-react";
import { useChatStore } from "./chatStore";
import { useSceneStore } from "@/features/tree/store";
import { useEditorStore } from "@/features/editor/editorStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { ChatMessage } from "./components/ChatMessage";
import { CodexExtractionDialog } from "@/features/codex/CodexExtractionDialog";
import { SnippetExtractionDialog } from "@/features/snippets/SnippetExtractionDialog";
import { PinnedCodexBadges } from "./components/PinnedCodexBadges";
import { PinCodexDialog } from "./components/PinCodexDialog";
import { StorySoFarCoverage } from "./components/StorySoFarCoverage";
import { SessionsPanel } from "./components/SessionsPanel";
import * as chatApi from "./chatApi";
import { useAiSettingsStore } from "./store";
import { normalizeModelId } from "@/features/attribution/AuthorshipMark";
import { useTreeStore } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";

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
  const setActiveSceneId = useChatStore((s) => s.setActiveSceneId);
  const activeSessionId = useChatStore((s) => s.activeSessionId);

  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const sceneTitle = useTreeStore(
    (s) => s.nodes.find((n) => n.id === activeSceneId)?.title ?? "このシーン",
  );

  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);

  // Sync scene store → chat store
  useEffect(() => {
    setActiveSceneId(activeSceneId);
  }, [activeSceneId, setActiveSceneId]);

  // Pinned codex entries state (Task 3.5)
  const [pinnedEntries, setPinnedEntries] = useState<CodexEntry[]>([]);
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

  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Codex extraction dialog state
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

  // Snippet extraction dialog state
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

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    sendMessage(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const rawInsertFromChat = useEditorStore((s) => s.insertFromChat);
  const aiSettings = useAiSettingsStore((s) => s.settings);
  const insertFromChat = useCallback(
    (content: string, messageId: string) => {
      const model = aiSettings
        ? normalizeModelId(aiSettings.provider, aiSettings.model)
        : null;
      rawInsertFromChat(content, messageId, model ?? undefined);
    },
    [rawInsertFromChat, aiSettings],
  );

  const canSend = input.trim().length > 0 && !isStreaming;

  return (
    <div className="relative flex h-full flex-col bg-background">
      <div className="flex flex-col border-b border-border">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              AIチャット
            </h2>
            <button
              type="button"
              onClick={() => setSessionsPanelOpen((v) => !v)}
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Sessions
            </button>
          </div>
          {contextTokenCount > 0 && (
            <span
              data-testid="context-token-count"
              className="text-xs text-muted-foreground"
            >
              ctx: {contextTokenCount.toLocaleString()} tokens
            </span>
          )}
        </div>
        {/* B-10: storySoFar coverage warning */}
        <div className="flex items-center gap-2 px-4 pb-1.5">
          <StorySoFarCoverage />
        </div>
      </div>

      {activeSessionId && (
        <PinnedCodexBadges
          pinnedEntries={pinnedEntries}
          onUnpin={handleUnpin}
          onOpenPinDialog={() => setPinDialogOpen(true)}
        />
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground mt-8">
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

      <div className="border-t border-border p-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="メッセージを入力…"
            rows={1}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            role="textbox"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="送信"
            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>

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
        onPin={handlePin}
        onUnpin={handleUnpin}
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
