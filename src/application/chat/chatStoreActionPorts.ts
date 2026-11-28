import type { ChatState } from "./chatStoreTypes";
import type { StoreApi } from "zustand";

export type SubscribeChatState = StoreApi<ChatState>["subscribe"];

export type ChatStoreSet = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
) => void;

export interface ChatStoreActionPorts {
  set: ChatStoreSet;
  get: () => ChatState;
}

export interface ChatTurnStorePorts extends ChatStoreActionPorts {
  subscribe: SubscribeChatState;
}
