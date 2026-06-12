export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs?: number | null;
  metadata?: string | null;
  /** @deprecated Tier-based protection replaced starred; read-only compat */
  isStarred?: number;
  isSummarized?: number;
  createdAt: string;
}

export interface ChatMessageMetadata {
  extractedCodex?: string[];
  extractedSnippets?: string[];
  insertedToEditor?: boolean;
  tool_calls?: unknown[];
  mentioned_scene_ids?: string[];
  summary_id?: string;
  [key: string]: unknown;
}

export function parseChatMessageMetadata(
  raw: string | null | undefined,
): ChatMessageMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ChatMessageMetadata;
    }
  } catch {
    // ignore malformed metadata
  }
  return {};
}

export interface ChatSummary {
  id: string;
  sessionId: string;
  summary: string;
  sourceMessageIds: string[];
  tokenCount?: number | null;
  generation: number;
  sourceMsgCount: number;
  lastMsgId?: string | null;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  projectId: string;
  nodeId: string | null;
  codexAnchorId: string | null;
  snippetAnchorId: string | null;
  title: string;
  titleManual: number;
  model: string;
  createdAt: string;
  updatedAt: string;
}
