import { createPortal } from "react-dom";
import { useState, useRef, useEffect } from "react";
import { invoke } from "@/lib/tauri";
import * as chatApi from "@/features/chat/chatApi";

interface AINodeDialogProps {
  boardId: string;
  contextLines: string[];
  spawnPosition: { x: number; y: number };
  onCreated: (node: {
    id: string;
    prompt: string;
    response: string;
    sessionId: string | null;
    position: { x: number; y: number };
  }) => void;
  onCancel: () => void;
}

interface ChatResponsePayload {
  blocks: Array<
    | { type: "text"; content: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "thinking"; content: string }
  >;
  stopReason: string;
  inputTokens?: number;
  outputTokens?: number;
}

const PROJECT_ID = "default-project";

export function AINodeDialog({
  boardId,
  contextLines,
  spawnPosition,
  onCreated,
  onCancel,
}: AINodeDialogProps) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);

    try {
      // Build context-injected prompt
      const contextBlock =
        contextLines.length > 0
          ? `現在Mapに表示されているノード:\n${contextLines.map((l) => `- ${l}`).join("\n")}\n\n`
          : "";
      const fullPrompt = contextBlock + trimmed;

      // Create a chat session for this AI node
      const session = await chatApi.createSession(
        PROJECT_ID,
        `Map: ${trimmed.slice(0, 40)}`,
      );

      // Save user message
      await chatApi.addMessage(session.id, "user", fullPrompt);

      // Call AI (non-streaming for simplicity)
      const result = await invoke<ChatResponsePayload>("send_chat_message", {
        messages: [{ role: "user", content: fullPrompt }],
        thinking: null,
        effort: null,
        reasoningEnabled: null,
        reasoningEffort: null,
      });

      const responseText = result.blocks
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; content: string }).content)
        .join("\n")
        .trim();

      // Save AI response
      await chatApi.addMessage(session.id, "assistant", responseText, {
        tokensOut: result.outputTokens,
      });

      // Create the AI node DB record
      const { createAINode, upsertNodePosition } = await import("./mapApi");
      const aiNode = await createAINode({
        boardId,
        prompt: trimmed,
        response: responseText,
        sessionId: session.id,
        tokenUsage: result.outputTokens ?? null,
      });

      await upsertNodePosition({
        boardId,
        nodeRefType: "ai",
        aiNodeId: aiNode.id,
        x: spawnPosition.x,
        y: spawnPosition.y,
      });

      onCreated({
        id: aiNode.id,
        prompt: trimmed,
        response: responseText,
        sessionId: session.id,
        position: spawnPosition,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "AIの呼び出しに失敗しました");
      setLoading(false);
    }
  }

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={loading ? undefined : onCancel}
    >
      <div
        className="bg-popover border border-border rounded-lg shadow-xl p-6"
        style={{ minWidth: 400, maxWidth: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}
          className="text-foreground"
        >
          ✨ AI ノードを作成
        </h3>
        {contextLines.length > 0 && (
          <p
            style={{ fontSize: 11, marginBottom: 8 }}
            className="text-muted-foreground"
          >
            コンテキスト: {contextLines.length} ノードを注入します
          </p>
        )}
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleSubmit();
            }
            if (e.key === "Escape" && !loading) onCancel();
          }}
          disabled={loading}
          placeholder="AIへの質問や指示を入力…"
          style={{
            width: "100%",
            minHeight: 100,
            resize: "vertical",
            border: "1px solid var(--border)",
            borderRadius: 5,
            padding: "8px 10px",
            fontSize: 13,
            lineHeight: 1.5,
            background: "var(--background)",
            color: "var(--foreground)",
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 8,
            opacity: loading ? 0.6 : 1,
          }}
        />
        {error && (
          <p
            style={{
              fontSize: 12,
              color: "var(--destructive)",
              marginBottom: 8,
            }}
          >
            {error}
          </p>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            alignItems: "center",
          }}
        >
          {loading && (
            <span style={{ fontSize: 12 }} className="text-muted-foreground">
              AIが回答中…
            </span>
          )}
          <button
            type="button"
            className="hover:bg-accent text-foreground"
            disabled={loading}
            style={{
              padding: "4px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "1px solid var(--border)",
              cursor: loading ? "not-allowed" : "pointer",
              background: "transparent",
            }}
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={loading || !prompt.trim()}
            style={{
              padding: "4px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "none",
              cursor: loading || !prompt.trim() ? "not-allowed" : "pointer",
              background: loading || !prompt.trim() ? "#9CA3AF" : "#534AB7",
              color: "#fff",
            }}
            onClick={handleSubmit}
          >
            {loading ? "…" : "実行 (Ctrl+Enter)"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
