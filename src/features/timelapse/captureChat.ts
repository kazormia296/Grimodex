/**
 * 執筆タイムラプス — chat 会話フローの forward-only 記録アダプタ (P0, §17)。
 *
 * `change_events` には従来チャットが一切記録されていなかった (recorder の
 * Domain に 'chat' が無く、chat 配下は recorder を import しなかった)。本モジュールは
 * chatApi のチョークポイント (addMessage / deleteMessage / deleteMessagesFrom) から
 * 呼ばれ、会話の「追加・削除」を append-only イベントとして残す。後で P5 が
 * timestamp 順に再生してチャットの流れを動画化する。
 *
 * 設計上の確定事項 (§17 — forward-only ゆえ後で直せない):
 * - **本文 inline 焼き込み**: `chat_messages` は mutable で物理削除されるため、
 *   messageId 参照だけ残すと delete/regenerate 後に join 先が dangling する。
 *   role/text/sessionId を payload に焼き込む。
 * - **sceneId は必ず null**: `change_events.sceneId` は treeNodes への FK
 *   (onDelete:set null)。chat session id 等の非 treeNodes 値を入れると flush
 *   insert が FK 制約で落ち、recorder の全 flush が永久リトライ失敗で停止する。
 *   chat session id は payload.sessionId に載せる。
 * - **delete は別建てイベント**: 「いつ・どれが消えたか」も再現対象。regenerate /
 *   editUserMessage は deleteMessage 経由なのでこのフックで自動的に捕捉される。
 * - **streaming delta は P0 では記録しない**: addMessage は完了時 1 回の insert
 *   なので、完了時の snapshot のみ。打鍵感が要れば後方互換で stream を足せる。
 */

import {
  recordChangeEvent,
  reserveChangeEvents,
  type ChangeEventReservation,
  type RecordEventInput,
} from "./recorder";

export interface ChatMessageAddEventInput {
  /** Owning Project when the caller has captured immutable turn authority. */
  projectId?: string;
  sessionId: string;
  messageId: string;
  role: string;
  text: string;
  model?: string | null;
  /** ISO timestamp from chat_messages.createdAt (照合用)。 */
  createdAt: string;
}

function chatMessageAddEvent(
  input: ChatMessageAddEventInput,
): RecordEventInput {
  const timestamp = Date.parse(input.createdAt);
  return {
    domain: "chat",
    opType: "chat.message.add",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    entityType: "chat_message",
    entityId: input.messageId,
    sceneId: null,
    ...(Number.isFinite(timestamp) ? { timestamp } : {}),
    payload: {
      sessionId: input.sessionId,
      messageId: input.messageId,
      role: input.role,
      text: input.text,
      ...(input.model ? { model: input.model } : {}),
      createdAt: input.createdAt,
    },
  };
}

export function recordChatMessageAdd(input: ChatMessageAddEventInput): void {
  recordChangeEvent(chatMessageAddEvent(input));
}

/**
 * Holds completed-turn add events behind an in-memory Chronicle barrier until
 * the corresponding Chat rows are durable. Later events cannot overtake the
 * reservation, while failed/discarded turns never become phantom history.
 */
export function reserveChatMessageAdds(
  inputs: readonly ChatMessageAddEventInput[],
): ChangeEventReservation {
  return reserveChangeEvents(inputs.map(chatMessageAddEvent));
}

/**
 * 個別メッセージ削除。`chatApi.deleteMessage(messageId)` は sessionId を持たない
 * ため省略可。再生側は先行する add イベントの messageId→sessionId で対応づける。
 */
export function recordChatMessageDelete(input: {
  messageId: string;
  sessionId?: string;
}): void {
  recordChangeEvent({
    domain: "chat",
    opType: "chat.message.delete",
    entityType: "chat_message",
    entityId: input.messageId,
    sceneId: null,
    payload: input.sessionId
      ? { sessionId: input.sessionId, messageId: input.messageId }
      : { messageId: input.messageId },
  });
}

/** createdAt >= fromCreatedAt の範囲削除 (editUserMessage 等のトランケート)。 */
export function recordChatMessagesDeleteFrom(input: {
  sessionId: string;
  fromCreatedAt: string;
}): void {
  recordChangeEvent({
    domain: "chat",
    opType: "chat.message.deleteFrom",
    entityType: "chat_session",
    entityId: input.sessionId,
    sceneId: null,
    payload: {
      sessionId: input.sessionId,
      fromCreatedAt: input.fromCreatedAt,
    },
  });
}
