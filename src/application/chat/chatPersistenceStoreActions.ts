import type { ChatStoreActionPorts } from "./chatStoreActionPorts";
import type { ChatState } from "./chatStoreTypes";
import type { ChatMessage, MessageRole } from "@/features/chat/chatTypes";

interface ChatPersistenceRepository {
  addMessage: (
    sessionId: string,
    role: MessageRole,
    content: string,
    extra?: {
      model?: string;
      metadata?: string;
    },
  ) => Promise<ChatMessage>;
  saveMessagePrompt: (
    messageId: string,
    snapshot: {
      systemPrompt: string;
      layers: [];
      totalTokens: null;
      model: string | null;
    },
  ) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
}

interface ChatPersistenceRuntime {
  notifySaveFailure: () => void;
  notifyDeleteFailure: () => void;
  reportError: (operation: string, error: unknown) => void;
  reportWarning: (operation: string, error: unknown) => void;
  parseMentionedSceneIds: (
    metadata: string | null | undefined,
  ) => string[] | undefined;
}

export function createChatPersistenceStoreActions(
  deps: ChatStoreActionPorts & {
    repository: ChatPersistenceRepository;
    runtime: ChatPersistenceRuntime;
  },
): Pick<
  ChatState,
  "persistMessage" | "appendAdoptedAbTurn" | "deleteMessage" | "editUserMessage"
> {
  const { set, get, repository, runtime } = deps;
  return {
    persistMessage: async (role: MessageRole, content: string) => {
      const { activeSessionId } = get();
      if (!activeSessionId) return;

      try {
        const message = await repository.addMessage(
          activeSessionId,
          role,
          content,
        );
        set((state) => ({
          messages: [...state.messages, message],
        }));
      } catch (error) {
        runtime.notifySaveFailure();
        runtime.reportError("persistMessage", error);
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
        runtime.notifySaveFailure();
        return false;
      }

      try {
        // user 下書き。@scene メンションは sendMessage と同じく metadata に残す。
        const userMetadata =
          mentionedSceneIds.length > 0
            ? JSON.stringify({ mentioned_scene_ids: mentionedSceneIds })
            : undefined;
        const userMsg = await repository.addMessage(
          sessionId,
          "user",
          userDraft,
          {
            ...(userMetadata ? { metadata: userMetadata } : {}),
          },
        );

        // 制作過程開示: A/B 各構成へ実際に送ったフルプロンプトをスナップショット保存
        // (通常送信の saveMessagePrompt と同じ chat_message_prompts へ)。fire-and-forget。
        // 比較は単発 user メッセージで投げているため layers は空・tokens は不明。
        if (basePrompt) {
          void repository
            .saveMessagePrompt(userMsg.id, {
              systemPrompt: basePrompt,
              layers: [],
              totalTokens: null,
              model,
            })
            .catch((error) =>
              runtime.reportWarning(
                "appendAdoptedAbTurn:saveMessagePrompt",
                error,
              ),
            );
        }

        // 採用応答。ab_adopted で provenance を残す (ライブ生成と区別)。
        // usage は A/B 実行時に recordAiUsage 済みなので二重記録しない。
        const assistantMsg = await repository.addMessage(
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
      } catch (error) {
        runtime.notifySaveFailure();
        runtime.reportError("appendAdoptedAbTurn", error);
        return false;
      }
    },

    deleteMessage: async (messageId) => {
      const { activeSessionId, messages } = get();
      const index = messages.findIndex((message) => message.id === messageId);
      if (index === -1) return;
      const message = messages[index];
      try {
        if (message.role === "user") {
          const toDelete = messages
            .slice(index)
            .filter((candidate) => candidate.role !== "system");
          if (activeSessionId) {
            for (const candidate of toDelete) {
              await repository.deleteMessage(candidate.id);
            }
          }
          set({ messages: messages.slice(0, index) });
        } else {
          if (activeSessionId) {
            await repository.deleteMessage(messageId);
          }
          set({
            messages: messages.filter(
              (candidate) => candidate.id !== messageId,
            ),
          });
        }
      } catch (error) {
        runtime.notifyDeleteFailure();
        runtime.reportError("deleteMessage", error);
      }
    },

    editUserMessage: (messageId) => {
      const { activeSessionId, messages } = get();
      const index = messages.findIndex((message) => message.id === messageId);
      if (index === -1) return { content: "" };
      const message = messages[index];
      const content = message.content;
      const mentionedSceneIds = runtime.parseMentionedSceneIds(
        message.metadata,
      );
      const toDelete = messages
        .slice(index)
        .filter((candidate) => candidate.role !== "system");
      if (activeSessionId) {
        Promise.all(
          toDelete.map((candidate) => repository.deleteMessage(candidate.id)),
        ).catch((error) => runtime.reportError("editUserMessage", error));
      }
      set({ messages: messages.slice(0, index) });
      return mentionedSceneIds ? { content, mentionedSceneIds } : { content };
    },
  };
}
