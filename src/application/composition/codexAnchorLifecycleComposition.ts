import type { CodexAnchorLifecyclePort } from "@/application/codex/codexAnchorLifecycle";
import { useChatStore } from "@/features/chat/chatStore";

export const codexAnchorLifecycleComposition: CodexAnchorLifecyclePort = {
  onDeleted: (entryId) => useChatStore.getState().onCodexAnchorDeleted(entryId),
};
