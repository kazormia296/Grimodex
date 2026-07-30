import type { ChatState } from "./chatStoreTypes";
import {
  fetchProjectContext,
  parseMentionedSceneIdsFromMetadata,
} from "./chatStoreSupport";
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
}): Pick<
  ChatState,
  "setAgentMode" | "continueAgentRun" | "setRagEnabled" | "regenerate"
> {
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

    regenerate: async (assistantMessageId, options) => {
      const { messages, isStreaming, isLoadingSessions, isLoadingMessages } =
        get();
      // sendMessage rejects while lifecycle reads are in flight. Keep the old
      // answer intact until its replacement has been persisted.
      if (isStreaming || isLoadingSessions || isLoadingMessages) return;
      const authority = deps.captureAuthority();
      const assistantIndex = messages.findIndex(
        (message) => message.id === assistantMessageId,
      );
      if (assistantIndex === -1) return;

      // 直前のユーザーメッセージを探す
      const userMessage = [...messages]
        .slice(0, assistantIndex)
        .reverse()
        .find((message) => message.role === "user");
      if (!userMessage) return;

      // @scene mention の per-message pin は user メッセージの metadata
      // (`mentioned_scene_ids`) に永続化されている。再生成時に復元しないと
      // 元の prompt と再生成 prompt で context が食い違うので拾い直す。
      const mentionedSceneIds = parseMentionedSceneIdsFromMetadata(
        userMessage.metadata,
      );

      if (!(await deps.awaitWritableAuthority(authority))) return;

      // 再送信。旧回答は turn history からだけ除外し、replacement の永続化に
      // 成功した後で削除する。途中の切替・失敗では旧回答を保全する。
      // withAgentMode: 一回限りの Agent mode 切替で再試行する場合
      const sendOptions: {
        overrideAgentMode?: boolean;
        mentionedSceneIds?: string[];
        _replaceAssistantMessageId: string;
      } = { _replaceAssistantMessageId: assistantMessageId };
      if (options?.withAgentMode) sendOptions.overrideAgentMode = true;
      if (mentionedSceneIds) {
        sendOptions.mentionedSceneIds = mentionedSceneIds;
      }
      await get().sendMessage(userMessage.content, undefined, sendOptions);
    },

    setRagEnabled: (on: boolean) => set({ ragEnabled: on }),
  };
}
