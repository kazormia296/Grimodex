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
  isStarred?: number;
  isSummarized?: number;
  createdAt: string;
}

export interface ChatSummary {
  id: string;
  sessionId: string;
  summary: string;
  sourceMessageIds: string[]; // parsed from JSON
  tokenCount?: number | null;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  projectId: string;
  nodeId: string | null;
  title: string;
  titleManual: number;
  model: string;
  createdAt: string;
  updatedAt: string;
}
