import ReactMarkdown from "react-markdown";
import type { ChatMessage as ChatMessageType } from "../chatTypes";
import type { ToolCallRecord } from "../agent/agentTypes";
import { ChatMessageActions } from "./ChatMessageActions";
import { MessageBadge } from "./MessageBadge";
import { ToolCallBlock } from "./ToolCallBlock";
import { ThinkingBlock } from "./ThinkingBlock";

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
  onExtractCodex?: (messageId: string, selectedText: string | null) => void;
  onSaveSnippet?: (messageId: string, selectedText: string | null) => void;
}

export function ChatMessage({
  msg,
  isStreaming,
  onInsert,
  onExtractCodex,
  onSaveSnippet,
}: ChatMessageProps) {
  const isAssistant = msg.role === "assistant";
  const showActions = !isStreaming && msg.content.length > 0;
  const toolCalls = isAssistant ? parseToolCalls(msg.metadata) : [];
  const thinkingBlocks = isAssistant ? parseThinkingBlocks(msg.metadata) : [];

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
            : "max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
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
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            </div>
            {showActions && (
              <ChatMessageActions
                messageId={msg.id}
                onInsert={() => onInsert(msg.content, msg.id)}
                onExtractCodex={onExtractCodex}
                onSaveSnippet={onSaveSnippet}
              />
            )}
          </>
        ) : (
          <>
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            </div>
            {showActions && (
              <ChatMessageActions
                messageId={msg.id}
                onExtractCodex={onExtractCodex}
                onSaveSnippet={onSaveSnippet}
              />
            )}
          </>
        )}
        <MessageBadge messageId={msg.id} />
      </div>
    </div>
  );
}
