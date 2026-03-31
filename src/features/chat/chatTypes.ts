export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  sceneId: string | null;
  createdAt: string;
  modifiedAt: string;
}
