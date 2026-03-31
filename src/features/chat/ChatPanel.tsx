import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
} from "react";
import { Send } from "lucide-react";
import { useChatStore } from "./chatStore";
import { useSceneStore } from "@/features/scene/store";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { ChatMessage } from "./components/ChatMessage";
import { SnippetExtractionDialog } from "@/features/snippets/SnippetExtractionDialog";

interface SnippetDialogState {
  open: boolean;
  messageId: string;
  initialContent: string;
}

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const error = useChatStore((s) => s.error);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const contextTokenCount = useChatStore((s) => s.contextTokenCount);
  const setActiveSceneId = useChatStore((s) => s.setActiveSceneId);

  const activeSceneId = useSceneStore((s) => s.activeSceneId);

  // Sync scene store → chat store
  useEffect(() => {
    setActiveSceneId(activeSceneId);
  }, [activeSceneId, setActiveSceneId]);

  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Snippet extraction dialog state
  const [snippetDialog, setSnippetDialog] = useState<SnippetDialogState>({
    open: false,
    messageId: "",
    initialContent: "",
  });

  const createSnippet = useSnippetStore((s) => s.create);

  const handleSaveSnippet = useCallback(
    (messageId: string, selectedText: string | null) => {
      const msg = messages.find((m) => m.id === messageId);
      const content = selectedText ?? msg?.content ?? "";
      setSnippetDialog({ open: true, messageId, initialContent: content });
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

  const insertFromChat = useEditorStore((s) => s.insertFromChat);

  const canSend = input.trim().length > 0 && !isStreaming;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold text-foreground">AIチャット</h2>
        {contextTokenCount > 0 && (
          <span
            data-testid="context-token-count"
            className="text-xs text-muted-foreground"
          >
            ctx: {contextTokenCount.toLocaleString()} tokens
          </span>
        )}
      </div>

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
      <SnippetExtractionDialog
        open={snippetDialog.open}
        initialContent={snippetDialog.initialContent}
        messageId={snippetDialog.messageId}
        onSave={async (data) => {
          await createSnippet(data);
        }}
        onClose={() => setSnippetDialog((s) => ({ ...s, open: false }))}
      />
    </div>
  );
}
