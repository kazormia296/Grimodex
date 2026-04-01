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
  createdAt: string;
}

export interface ChatSession {
  id: string;
  projectId: string;
  nodeId: string | null;
  title: string;
  titleManual: number;
  model: string | null;
  pinnedCodex: string; // JSON string[]
  createdAt: string;
  updatedAt: string;
}
