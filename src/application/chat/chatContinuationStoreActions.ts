import type { ChatState } from "./chatStoreTypes";
import { fetchProjectContext } from "./chatStoreSupport";
import type { SessionMutationAuthority } from "./chatSessionAuthority";
import { getPromptCatalog } from "@/prompts/index";

interface ChatComposerAuthoritySnapshot {
  activeSessionId: string | null;
  sessionMutation: SessionMutationAuthority;
  aiRoute: string;
}

type ChatStoreSet = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
) => void;

export function createChatContinuationStoreActions(deps: {
  set: ChatStoreSet;
  get: () => ChatState;
  captureAuthority: () => ChatComposerAuthoritySnapshot;
  awaitWritableAuthority: (
    authority: ChatComposerAuthoritySnapshot,
  ) => Promise<boolean>;
}): Pick<ChatState, "setAgentMode" | "continueAgentRun" | "setRagEnabled"> {
  const { set, get } = deps;
  return {
    setAgentMode: (on: boolean) => set({ agentMode: on }),

    continueAgentRun: async () => {
      const invocationState = get();
      const {
        agentContinuation: cont,
        isStreaming,
        isLoadingSessions,
        isLoadingMessages,
      } = invocationState;
      if (!cont || isStreaming || isLoadingSessions || isLoadingMessages) {
        return;
      }
      const authority = deps.captureAuthority();
      // 続行は別セッションへ切り替わっていたら無効（最新ターン専用）。
      if (cont.sessionId && cont.sessionId !== authority.activeSessionId) {
        set({ agentContinuation: null });
        return;
      }
      if (!(await deps.awaitWritableAuthority(authority))) return;
      const lang =
        (await fetchProjectContext(authority.sessionMutation.projectId))
          ?.language ?? "ja";
      if (!(await deps.awaitWritableAuthority(authority))) return;
      if (get().agentContinuation !== cont) return;
      const continuePrompt = getPromptCatalog(lang).agentControl.continuePrompt;
      // agent パスを強制（続行は常にエージェントターンの再開）。
      set({ agentContinuation: null });
      await get().sendMessage(continuePrompt, undefined, {
        overrideAgentMode: true,
      });
    },

    setRagEnabled: (on: boolean) => set({ ragEnabled: on }),
  };
}
