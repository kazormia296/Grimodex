export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface ChatThread {
  id: string;
  sceneId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
}
