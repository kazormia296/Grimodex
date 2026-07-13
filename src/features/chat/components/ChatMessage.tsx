import { memo, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage as ChatMessageType } from "../chatTypes";
import type { ToolCallRecord, Citation } from "../agent/agentTypes";
import { ChatMessageActions } from "./ChatMessageActions";
import { CitationList } from "./CitationList";
import { formatCost } from "../modelPricing";
import { looksLikeMissingInfo } from "../agentSuggestion";
import { stripToolProtocol } from "../toolProtocol";
import { useChatStore } from "../chatStore";
import { getModelCapabilities } from "../agent/modelLimits";
import { useAiSettingsStore } from "../store";
import { MessageBadge } from "./MessageBadge";
import { ToolCallBlock } from "./ToolCallBlock";
import { AnsweredQuestionBlock } from "./AnsweredQuestionBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { SummaryBlock } from "./SummaryBlock";
import { CodexItemList } from "./CodexItemList";
import {
  copyChatMessageWithAttribution,
  handleCopyWithAttribution,
} from "@/lib/clipboardAttribution";
import { useEditorStore } from "@/features/editor/editorStore";
import { useTextSelection } from "@/features/chat/hooks/useTextSelection";
import { SelectionToolbar } from "./SelectionToolbar";
import { useCodexMarkdownComponents } from "@/features/chat/hooks/useCodexMarkdownComponents";
import { recordMark } from "@/lib/perfLog";

interface ParsedMetadata {
  tool_calls?: ToolCallRecord[];
  thinking_blocks?: Array<{
    thinking: string;
    signature: string;
    summary?: string;
  }>;
  /** Web 検索 (RAG) の引用ソース。 */
  citations?: Citation[];
  /** リクエストの概算コスト (USD)。OpenRouter のみ実値。 */
  cost?: number;
  codex_items?: unknown[];
  codex_warnings?: string[];
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
  onRetryWithAgent?: (messageId: string) => void;
  onViewPrompt?: (messageId: string) => void;
  onContextMenu?: (e: React.MouseEvent, msg: ChatMessageType) => void;
}

function ChatMessageImpl({
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
  onRetryWithAgent,
  onViewPrompt,
  onContextMenu,
}: ChatMessageProps) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const isAssistant = msg.role === "assistant";
  const isUser = msg.role === "user";
  const parsedMeta = useMemo(() => parseMetadata(msg.metadata), [msg.metadata]);
  const isSummary = "summary_id" in parsedMeta;
  // 一部モデルが本文に吐き出す擬似ツール記法 (<tool_call>/<tool_response>) を
  // 描画・コピー・挿入・履歴の全消費前に除去する。生は DB に保持（可逆）。
  // assistant 本文のみ対象（user 投稿やサマリは原文のまま）。
  const safeContent = useMemo(
    () =>
      isAssistant && !isSummary ? stripToolProtocol(msg.content) : msg.content,
    [isAssistant, isSummary, msg.content],
  );
  const showActions = !isStreaming && safeContent.length > 0 && !isSummary;
  const toolCalls =
    isAssistant && !isSummary ? (parsedMeta.tool_calls ?? []) : [];
  const thinkingBlocks =
    isAssistant && !isSummary ? (parsedMeta.thinking_blocks ?? []) : [];
  const citations =
    isAssistant && !isSummary ? (parsedMeta.citations ?? []) : [];
  const ragCost = isAssistant && !isSummary ? parsedMeta.cost : undefined;

  const containerRef = useRef<HTMLDivElement>(null);
  const codexComponents = useCodexMarkdownComponents();
  const showGhostPreview = useEditorStore((s) => s.showGhostPreview);
  const clearGhostPreview = useEditorStore((s) => s.clearGhostPreview);
  const { selectionInfo } = useTextSelection(containerRef);

  // Agent mode 未使用 (toolCalls なし) で「情報が足りない」っぽい応答に
  // 限り、再試行ボタンを表示。永続トグルは変えず一回限りの再生成。
  const currentModel = useAiSettingsStore((s) => s.settings?.model ?? "");
  const agentMode = useChatStore((s) => s.agentMode);
  const showAgentRetry =
    isAssistant &&
    !isSummary &&
    showActions &&
    !agentMode &&
    toolCalls.length === 0 &&
    !!onRetryWithAgent &&
    getModelCapabilities(currentModel).supportsTools &&
    looksLikeMissingInfo(safeContent);

  // G2 + G23: Copy with attribution MIME
  const handleCopy = useCallback(() => {
    copyChatMessageWithAttribution(safeContent, msg.id, msg.model)
      .then(() => toast.success(t("chat.copied")))
      .catch(() => toast.error(t("chat.copyFailed")));
  }, [safeContent, msg.id, msg.model, t]);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!showActions) return;
    e.preventDefault();
    onContextMenu?.(e, msg);
  };

  const __renderResult = (
    <div
      data-testid={`chat-message-${msg.id}`}
      data-role={msg.role}
      className={
        msg.role === "user" ? "flex justify-end" : "flex justify-start"
      }
      // ネイティブ Ctrl+C / ブラウザコピーで provenance を注入する。
      // 未対応だと ReactMarkdown のプレーン DOM がそのままコピーされ、
      // paste 時に EditorPane Case 3 へ落ちて "unknown" 化していた。
      // role→source は context-menu コピー (handleContextCopy) と同じ規則。
      onCopy={(e) =>
        handleCopyWithAttribution(e, msg.role === "assistant" ? "ai" : "human")
      }
    >
      <div
        ref={isAssistant ? containerRef : undefined}
        className={
          msg.role === "user"
            ? "max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
            : "max-w-[95%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
        }
        onContextMenu={handleContextMenu}
      >
        {isAssistant && isSummary ? (
          <SummaryBlock summary={msg.content} />
        ) : isAssistant ? (
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
                {toolCalls.map((record, i) =>
                  record.name === "ask_user" ? (
                    <AnsweredQuestionBlock key={i} record={record} />
                  ) : (
                    <ToolCallBlock key={i} record={record} />
                  ),
                )}
              </div>
            )}
            <CodexItemList raw={parsedMeta.codex_items} />
            {parsedMeta.codex_warnings &&
              parsedMeta.codex_warnings.length > 0 && (
                <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                  {parsedMeta.codex_warnings.join("\n")}
                </div>
              )}
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={codexComponents}
              >
                {safeContent}
              </ReactMarkdown>
            </div>
            {citations.length > 0 && <CitationList citations={citations} />}
            {/* G3: Meta info row */}
            {(msg.model ||
              msg.tokensIn != null ||
              msg.tokensOut != null ||
              msg.durationMs != null ||
              ragCost != null) && (
              <div className="mt-1 text-[10px] text-muted-foreground/60">
                {[
                  msg.model,
                  msg.tokensIn != null ? `${msg.tokensIn} in` : null,
                  msg.tokensOut != null ? `${msg.tokensOut} tok` : null,
                  msg.durationMs != null
                    ? `${(msg.durationMs / 1000).toFixed(1)}s`
                    : null,
                  ragCost != null ? formatCost(ragCost) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
            {showAgentRetry && (
              <button
                type="button"
                data-testid={`agent-retry-${msg.id}`}
                onClick={() => onRetryWithAgent?.(msg.id)}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-accent/30 px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                title={t("chat.agentRetryTitle")}
              >
                <Sparkles className="h-3 w-3 text-primary" />
                <span>{t("chat.agentRetryLabel")}</span>
              </button>
            )}
            {showActions && (
              <ChatMessageActions
                messageId={msg.id}
                messageRole="assistant"
                onInsert={() => onInsert(safeContent, msg.id)}
                onInsertHover={(hovering) =>
                  hovering ? showGhostPreview(safeContent) : clearGhostPreview()
                }
                onExtractCodexQuick={onExtractCodexQuick}
                onExtractCodexDetailed={onExtractCodexDetailed}
                onSaveSnippetQuick={onSaveSnippetQuick}
                onSaveSnippetDetailed={onSaveSnippetDetailed}
                onCopy={handleCopy}
                onRegenerate={onRegenerate}
                onDelete={onDelete}
              />
            )}
            {isAssistant && selectionInfo && (
              <SelectionToolbar
                selectionInfo={selectionInfo}
                messageId={msg.id}
                onInsertSelection={(text, messageId) => {
                  onInsert(text, messageId);
                }}
                onExtractCodex={(messageId, selectedText) => {
                  onExtractCodexDetailed?.(messageId, selectedText);
                }}
                onSaveSnippet={(messageId, selectedText) => {
                  onSaveSnippetDetailed?.(messageId, selectedText);
                }}
                onCopy={(text) => {
                  // SelectionToolbar は assistant メッセージのみで表示される
                  // (isAssistant && selectionInfo)。素の writeText だと "ai"
                  // provenance が乗らず paste で "unknown" 化するため、
                  // フルメッセージコピー (handleCopy) と同じ経路に揃える。
                  void copyChatMessageWithAttribution(text, msg.id, msg.model);
                }}
              />
            )}
          </>
        ) : isUser ? (
          <>
            <div className="prose prose-sm max-w-none dark:prose-invert prose-p:text-primary-foreground prose-strong:text-primary-foreground prose-em:text-primary-foreground prose-code:text-primary-foreground">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={codexComponents}
              >
                {msg.content}
              </ReactMarkdown>
            </div>
            {showActions && (
              <ChatMessageActions
                messageId={msg.id}
                messageRole="user"
                onEdit={onEdit}
                onDelete={onDelete}
                onViewPrompt={onViewPrompt}
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
  recordMark(
    "chatMessage.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}

// ストリーミング中は messages 配列が delta 毎に新参照になるが、確定済みの
// 過去メッセージは msg 参照が保たれる。memo 化しておくと streaming bubble
// 以外は再レンダー（= ReactMarkdown 再パース + codex matcher 再走査）を
// スキップできる。前提として ChatPanel 側で渡すコールバックが安定参照で
// あること（handleExtract*/handleSaveSnippet* は messages 依存を外し済み）。
export const ChatMessage = memo(ChatMessageImpl);
