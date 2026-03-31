import ReactMarkdown from "react-markdown";
import type { ChatMessage as ChatMessageType } from "../chatTypes";
import { ChatMessageActions } from "./ChatMessageActions";
import { MessageBadge } from "./MessageBadge";

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

  return (
    <div
      data-testid={`chat-message-${msg.id}`}
      data-role={msg.role}
      className={msg.role === "user" ? "flex justify-end" : "flex justify-start"}
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
            <p className="whitespace-pre-wrap">{msg.content}</p>
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
