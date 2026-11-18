import type * as chatApi from "@/features/chat/chatApi";
import type { ChatMessage } from "@/features/chat/chatTypes";
import type { ToolResult } from "@/features/chat/agent/agentTypes";
import { SOURCE_CHAT_MESSAGE_TOOLS } from "@/features/chat/agent/toolExecutors";
import { ChatTurnPersistenceError } from "./chatTurnPersistence";

/**
 * 会話履歴として送る列。この修正が残す行（出典用に作った assistant の行）のうち、
 * 本文が空のもの、失敗・停止の印（`runtime_error`／`stopped`）があって直前に user が
 * 無いもの（user の行は完了時にしか保存しないため、失敗した turn では assistant の行
 * だけが残る）を除く。system の行と要約のマーカー（metadata の `summary_id`）は通し、
 * 交互には数えない。印の無い既存の行は位置で落とさない。要約は live store から列を
 * 作り直すので、`maybeRunSummarization` の戻り値（`isSummarized` で絞る前）に掛ける。
 */
export function sendableHistory<
  T extends Pick<ChatMessage, "role" | "content"> & {
    metadata?: string | null;
  },
>(messages: readonly T[]): T[] {
  const sendable: T[] = [];
  let previousRole: ChatMessage["role"] | null = null;
  for (const message of messages) {
    const metadata = parseMetadataRecord(message.metadata);
    if (message.role === "system" || "summary_id" in metadata) {
      sendable.push(message);
      continue;
    }
    const leftByFailedTurn =
      ("runtime_error" in metadata || metadata.stopped === true) &&
      previousRole !== "user";
    const orphan =
      message.role === "assistant" &&
      (!message.content.trim() || leftByFailedTurn);
    if (!orphan) {
      sendable.push(message);
      previousRole = message.role;
    }
  }
  return sendable;
}

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
  /** 行を作った後か（作れたか分からないときも true。完了時は UPSERT で書く）。 */
  readonly reserved: boolean;
  /** 本文の断片を控える（turn が current でなくなり store から消えた後の確定に使う）。 */
  observeText(text: string): void;
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
  /**
   * 確定も失敗の確定もせずに turn を抜けるとき（停止の後に turn が current でない、
   * 完了時に turn の権限を失った等）、行を `stopped` で確定する。行を作っていない、
   * 確定済み、または書いてよくない（`writeGuards`）なら何もしない。
   */
  settleAbandoned(model: string): Promise<void>;
}

export function createAssistantRowReservation(deps: {
  chatApi: Pick<typeof chatApi, "addMessage" | "listMessages">;
  getSessionId: () => string | null;
  message: Pick<ChatMessage, "id" | "createdAt">;
  /** 失敗時の確定に、その時点の assistant の本文を読む。 */
  getMessages: () => readonly Pick<ChatMessage, "id" | "content">[];
  /** 行を作った後に turn がまだ有効かを確かめる（無効なら投げる）。 */
  assertCurrent: () => void;
  /**
   * turn を抜けた後に、捕まえた workspace／project の DB へまだ書いてよいか（すべて true）。
   * 切り替わった後は書かない（空の行は sendableHistory が送信から外す）。
   */
  writeGuards: readonly (() => boolean)[];
  debugLog: { warn: (scope: string, what: string, detail: string) => void };
  errorDetail: (error: unknown) => string;
}): AssistantRowReservation {
  let pending: Promise<void> | null = null;
  let reserved = false;
  let finalized = false;
  let observedText = "";
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
  /** 失敗・停止の残り（その時点の内容）で行を確定する。保存の失敗は返さず記録する。 */
  const settle = async (
    model: string,
    marker: Record<string, unknown>,
  ): Promise<void> => {
    const sessionId = deps.getSessionId();
    if (!reserved || finalized || !sessionId) return;
    const current = deps.getMessages().find((m) => m.id === message.id);
    try {
      await persist(sessionId, current?.content ?? observedText, {
        ...(model ? { model } : {}),
        metadata: JSON.stringify(marker),
      });
    } catch (persistError) {
      deps.debugLog.warn(
        "ChatStore",
        "reserved assistant row",
        deps.errorDetail(persistError),
      );
    }
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
        async (error: unknown) => {
          pending = null;
          // INSERT の後（chat_sessions の UPDATE など）で失敗しても行は残る。
          // 行の有無を読み直し、読めなければ「あるかもしれない」とする（完了時は
          // UPSERT なので、どちらでも同じ id へ書ける）。
          reserved = await deps.chatApi.listMessages(sessionId).then(
            (rows) => rows.some((row) => row.id === message.id),
            () => true,
          );
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
    observeText(text) {
      observedText += text;
    },
    async finalizeAfterFailure(error, failure, model) {
      if (error instanceof ChatTurnPersistenceError) return;
      await settle(model, { runtime_error: failure });
    },
    async settleAbandoned(model) {
      if (!deps.writeGuards.every((guard) => guard())) return;
      await settle(model, { stopped: true });
    },
  };
}
