import type { ChatState } from "./chatStoreTypes";
import * as chatApi from "@/features/chat/chatApi";
import type { MessageRole } from "@/features/chat/chatTypes";
import { debugLog, errorDetail } from "@/lib/debugLog";
import i18next from "@/lib/i18n";
import { toast } from "sonner";

type ChatStoreSet = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
) => void;

export function createChatPersistenceStoreActions(deps: {
  set: ChatStoreSet;
  get: () => ChatState;
}): Pick<ChatState, "persistMessage" | "appendAdoptedAbTurn"> {
  const { set, get } = deps;
  return {
    persistMessage: async (role: MessageRole, content: string) => {
      const { activeSessionId } = get();
      if (!activeSessionId) return;

      try {
        const message = await chatApi.addMessage(
          activeSessionId,
          role,
          content,
        );
        set((state) => ({
          messages: [...state.messages, message],
        }));
      } catch (e) {
        toast.error(i18next.t("chat.saveMessageFailed"));
        debugLog.error("ChatStore", "persistMessage", errorDetail(e));
      }
    },

    appendAdoptedAbTurn: async ({
      userDraft,
      basePrompt,
      mentionedSceneIds,
      assistantText,
      model,
    }) => {
      // A/B ダイアログはスコープを変えずに開くため、ensureSession は現在のスコープ
      // (scene/folder/project/codex/snippet) に対応する正しいセッションを返す。
      const sessionId = await get().ensureSession();
      if (!sessionId) {
        toast.error(i18next.t("chat.saveMessageFailed"));
        return false;
      }

      try {
        // user 下書き。@scene メンションは sendMessage と同じく metadata に残す。
        const userMetadata =
          mentionedSceneIds.length > 0
            ? JSON.stringify({ mentioned_scene_ids: mentionedSceneIds })
            : undefined;
        const userMsg = await chatApi.addMessage(sessionId, "user", userDraft, {
          ...(userMetadata ? { metadata: userMetadata } : {}),
        });

        // 制作過程開示: A/B 各構成へ実際に送ったフルプロンプトをスナップショット保存
        // (通常送信の saveMessagePrompt と同じ chat_message_prompts へ)。fire-and-forget。
        // 比較は単発 user メッセージで投げているため layers は空・tokens は不明。
        if (basePrompt) {
          void chatApi
            .saveMessagePrompt(userMsg.id, {
              systemPrompt: basePrompt,
              layers: [],
              totalTokens: null,
              model,
            })
            .catch((e) =>
              debugLog.warn(
                "ChatStore",
                "appendAdoptedAbTurn:saveMessagePrompt",
                errorDetail(e),
              ),
            );
        }

        // 採用応答。ab_adopted で provenance を残す (ライブ生成と区別)。
        // usage は A/B 実行時に recordAiUsage 済みなので二重記録しない。
        const assistantMsg = await chatApi.addMessage(
          sessionId,
          "assistant",
          assistantText,
          {
            ...(model ? { model } : {}),
            metadata: JSON.stringify({ ab_adopted: true }),
          },
        );

        set((state) => ({
          messages: [...state.messages, userMsg, assistantMsg],
        }));
        return true;
      } catch (e) {
        toast.error(i18next.t("chat.saveMessageFailed"));
        debugLog.error("ChatStore", "appendAdoptedAbTurn", errorDetail(e));
        return false;
      }
    },
  };
}
