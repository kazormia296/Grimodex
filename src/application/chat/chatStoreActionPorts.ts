import type { ChatState } from "./chatStoreTypes";

export type ChatStoreSet = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
) => void;

export interface ChatStoreActionPorts {
  set: ChatStoreSet;
  get: () => ChatState;
}
