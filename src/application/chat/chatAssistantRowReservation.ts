import type * as chatApi from "@/features/chat/chatApi";
import type { ChatMessage } from "@/features/chat/chatTypes";
import type { ToolResult } from "@/features/chat/agent/agentTypes";
import { SOURCE_CHAT_MESSAGE_TOOLS } from "@/features/chat/agent/toolExecutors";
import { ChatTurnPersistenceError } from "./chatTurnPersistence";

/** 出典用に作った空の assistant 行（失敗・停止した turn の残り）は会話履歴として送らない。 */
export function isSendableHistoryMessage(
  message: Pick<ChatMessage, "role" | "content">,
): boolean {
  return message.role !== "assistant" || message.content.trim().length > 0;
}

/**
 * 出典に実行中の assistant message を使う書き込み tool（create_snippet／
 * create_codex_entry）は、`chat_messages` に行が無いと拒否される（検証／FK）。
 * agent の turn は完了後にまとめて保存するため、該当 tool の最初の実行の直前にだけ
 * assistant の空の行を作り、完了・停止・失敗時は同じ id の行を最終の内容へ更新する。
 * 該当 tool が無い turn は従来どおり完了時に INSERT する。user の行は作らない
 * （NIR-1 の role='user' INSERT trigger の時点を変えない）。
 */
/** 保存済みの metadata（JSON のオブジェクト）を読む。読めなければ空。 */
export function parseMetadataRecord(
  raw: string | null | undefined,
): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface AssistantRowReservation {
  /**
   * 出典に使う書き込み tool なら、実行の直前に行を（まだなら）作る。作れなければ
   * tool の失敗結果を返す（tool は実行しない）。
   */
  before(
    name: string,
    toolCallId: string,
    authorized: boolean,
  ): Promise<ToolResult | null>;
  /** 行を作った後か。 */
  readonly reserved: boolean;
  /** 完了・停止時の保存。行を作っていれば更新し、無ければ INSERT する。 */
  persist(
    sessionId: string,
    content: string,
    extra: {
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
      metadata?: string;
    },
  ): Promise<void>;
  /** 失敗した turn の残り（その時点の内容）で行を確定する。保存の失敗は返さず記録する。 */
  finalizeAfterFailure(
    error: unknown,
    failure: string,
    model: string,
  ): Promise<void>;
}

export function createAssistantRowReservation(deps: {
  chatApi: Pick<typeof chatApi, "addMessage">;
  getSessionId: () => string | null;
  message: Pick<ChatMessage, "id" | "createdAt">;
  /** 失敗時の確定に、その時点の assistant の本文を読む。 */
  getMessages: () => readonly Pick<ChatMessage, "id" | "content">[];
  /** 行を作った後に turn がまだ有効かを確かめる（無効なら投げる）。 */
  assertCurrent: () => void;
  debugLog: { warn: (scope: string, what: string, detail: string) => void };
  errorDetail: (error: unknown) => string;
}): AssistantRowReservation {
  let pending: Promise<void> | null = null;
  let reserved = false;
  let finalized = false;
  const { message } = deps;
  const write = (
    sessionId: string,
    content: string,
    extra: Record<string, unknown>,
    replace: boolean,
  ) =>
    deps.chatApi.addMessage(sessionId, "assistant", content, {
      ...extra,
      id: message.id,
      createdAt: message.createdAt,
      recordTimelapse: false,
      ...(replace ? { replaceReservedAssistant: true } : {}),
    });
  const persist: AssistantRowReservation["persist"] = async (
    sessionId,
    content,
    extra,
  ) => {
    await write(sessionId, content, extra, reserved);
    finalized = true;
  };
  return {
    get reserved() {
      return reserved;
    },
    persist,
    async before(name, toolCallId, authorized) {
      const sessionId = deps.getSessionId();
      if (!authorized || !sessionId || !SOURCE_CHAT_MESSAGE_TOOLS.has(name)) {
        return null;
      }
      pending ??= write(sessionId, "", {}, false).then(
        () => {
          reserved = true;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      try {
        await pending;
      } catch (error) {
        const summary = `assistant message row could not be reserved: ${deps.errorDetail(error)}`;
        return {
          toolCallId,
          name,
          content: null,
          summary,
          tokensUsed: 0,
          error: summary,
        };
      }
      deps.assertCurrent();
      return null;
    },
    async finalizeAfterFailure(error, failure, model) {
      const sessionId = deps.getSessionId();
      if (!reserved || finalized || !sessionId) return;
      if (error instanceof ChatTurnPersistenceError) return;
      try {
        await persist(
          sessionId,
          deps.getMessages().find((m) => m.id === message.id)?.content ?? "",
          {
            ...(model ? { model } : {}),
            metadata: JSON.stringify({ runtime_error: failure }),
          },
        );
      } catch (persistError) {
        deps.debugLog.warn(
          "ChatStore",
          "reserved assistant row",
          deps.errorDetail(persistError),
        );
      }
    },
  };
}
