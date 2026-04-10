import { useCallback } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage as ChatMessageType } from "../chatTypes";
import type { ToolCallRecord } from "../agent/agentTypes";
import { ChatMessageActions } from "./ChatMessageActions";
import { MessageBadge } from "./MessageBadge";
import { ToolCallBlock } from "./ToolCallBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { copyChatMessageWithAttribution } from "@/lib/clipboardAttribution";

interface ParsedMetadata {
  tool_calls?: ToolCallRecord[];
  thinking_blocks?: Array<{
    thinking: string;
    signature: string;
    summary?: string;
  }>;
}

function parseMetadata(metadata: string | null | undefined): ParsedMetadata {
  if (!metadata) return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed && typeof parsed === "object") {
      return parsed as ParsedMetadata;
    }
  } catch {
    // corrupted metadata
  }
  return {};
}

function parseToolCalls(metadata: string | null | undefined): ToolCallRecord[] {
  return parseMetadata(metadata).tool_calls ?? [];
}

function parseThinkingBlocks(
  metadata: string | null | undefined,
): Array<{ thinking: string; summary?: string }> {
  return parseMetadata(metadata).thinking_blocks ?? [];
}

interface ChatMessageProps {
  msg: ChatMessageType;
  isStreaming: boolean;
  onInsert: (content: string, messageId: string) => void;
  onExtractCodexQuick?: (messageId: string) => void;
  onExtractCodexDetailed?: (
    messageId: string,
    selectedText: string | null,
  ) => void;
  onSaveSnippetQuick?: (messageId: string) => void;
  onSaveSnippetDetailed?: (
    messageId: string,
    selectedText: string | null,
  ) => void;
  onEdit?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
}

export function ChatMessage({
  msg,
  isStreaming,
  onInsert,
  onExtractCodexQuick,
  onExtractCodexDetailed,
  onSaveSnippetQuick,
  onSaveSnippetDetailed,
  onEdit,
  onDelete,
  onRegenerate,
}: ChatMessageProps) {
  const isAssistant = msg.role === "assistant";
  const isUser = msg.role === "user";
  const showActions = !isStreaming && msg.content.length > 0;
  const toolCalls = isAssistant ? parseToolCalls(msg.metadata) : [];
  const thinkingBlocks = isAssistant ? parseThinkingBlocks(msg.metadata) : [];

  // G2 + G23: Copy with attribution MIME
  const handleCopy = useCallback(() => {
    copyChatMessageWithAttribution(msg.content, msg.id, msg.model)
      .then(() => toast.success("コピーしました"))
      .catch(() => toast.error("コピーに失敗しました"));
  }, [msg.content, msg.id, msg.model]);

  return (
    <div
      data-testid={`chat-message-${msg.id}`}
      data-role={msg.role}
      className={
        msg.role === "user" ? "flex justify-end" : "flex justify-start"
      }
    >
      <div
        className={
          msg.role === "user"
            ? "max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
            : "max-w-[95%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
        }
      >
        {isAssistant ? (
          <>
            {thinkingBlocks.length > 0 && (
              <div className="mb-2 space-y-1">
                {thinkingBlocks.map((tb, i) => (
                  <ThinkingBlock
                    key={i}
                    content={tb.thinking}
                    summary={tb.summary}
                  />
                ))}
              </div>
            )}
            {toolCalls.length > 0 && (
              <div className="mb-2 space-y-1">
                {toolCalls.map((record, i) => (
                  <ToolCallBlock key={i} record={record} />
                ))}
              </div>
            )}
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {msg.content}
              </ReactMarkdown>
            </div>
            {/* G3: Meta info row */}
            {(msg.model || msg.tokensOut != null || msg.durationMs != null) && (
              <div className="mt-1 text-[10px] text-muted-foreground/60">
                {[
                  msg.model,
                  msg.tokensOut != null ? `${msg.tokensOut} tok` : null,
                  msg.durationMs != null
                    ? `${(msg.durationMs / 1000).toFixed(1)}s`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
            {showActions && (
              <ChatMessageActions
                messageId={msg.id}
                messageRole="assistant"
                onInsert={() => onInsert(msg.content, msg.id)}
                onExtractCodexQuick={onExtractCodexQuick}
                onExtractCodexDetailed={onExtractCodexDetailed}
                onSaveSnippetQuick={onSaveSnippetQuick}
                onSaveSnippetDetailed={onSaveSnippetDetailed}
                onCopy={handleCopy}
                onRegenerate={onRegenerate}
                onDelete={onDelete}
              />
            )}
          </>
        ) : isUser ? (
          <>
            <div className="prose prose-sm max-w-none dark:prose-invert prose-p:text-primary-foreground prose-strong:text-primary-foreground prose-em:text-primary-foreground prose-code:text-primary-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {msg.content}
              </ReactMarkdown>
            </div>
            {showActions && (
              <ChatMessageActions
                messageId={msg.id}
                messageRole="user"
                onEdit={onEdit}
                onDelete={onDelete}
              />
            )}
          </>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            {msg.content}
          </p>
        )}
        {(isAssistant || isUser) && <MessageBadge messageId={msg.id} />}
      </div>
    </div>
  );
}
