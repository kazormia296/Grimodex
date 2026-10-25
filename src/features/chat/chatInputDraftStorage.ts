/**
 * チャット入力の書きかけ（下書き）を renderer の localStorage に保存する。
 *
 * 保存先の選定（docs は PR 本文）:
 * - 主 DB（grimodex.db）へは書かない。入力のたびの commit は NIR-1 Graph の鮮度
 *   （`PRAGMA data_version`／`total_changes`）を失効させうるため。
 * - localStorage は同期 API なので、ウィンドウを閉じる直前（pagehide／beforeunload）でも
 *   書き終えられる。renderer の crash では Chromium の browser process 側に値が残るが、
 *   main の強制終了や電源断では、Chromium がディスクへ書くのを遅らせている分（数秒）が
 *   失われうる。
 * - 保存値そのものは外部へ送らず、監査・backup／restore・export・ログに含めない。
 *   ただし復元した文は入力欄の文として、端末内の文脈プレビュー（registerInputDraftProvider）の
 *   素材になる（送信時に AI へ送られるのは、入力欄の文を送ったときだけ）。
 *
 * 鍵は `gdx.chatDraft.v1|<workspace>|<projectId>|<slot>`。slot は既存 session なら
 * `s:<sessionId>`、まだ session の無い新しいチャットなら `n:<scope>`。
 */
import type { JSONContent } from "@tiptap/core";
import {
  CHAT_INPUT_DRAFT_KEY_PREFIX,
  getChatInputDraftPurges,
  hashChatInputDraftWorkspace,
} from "./chatInputDraftPurge";

/** 保存する JSON（UTF-8）の上限。超えたら保存せず、古い保存も消す（切り詰めない）。 */
export const CHAT_INPUT_DRAFT_MAX_BYTES = 64 * 1024;
/** 端末に残す下書きの数の上限。超えたら更新の古いものから消す。 */
export const CHAT_INPUT_DRAFT_MAX_ENTRIES = 50;
/**
 * 全下書きの合計の上限（鍵と値の UTF-16 の byte 数。Chromium の localStorage の数え方）。
 * localStorage は同じ origin の他の記録（AI 同意の記録、IME／性能のログ）と容量を共有する。
 * 超えたら更新の古いものから消す。
 */
export const CHAT_INPUT_DRAFT_MAX_TOTAL_BYTES = 1024 * 1024;

export interface ChatInputDraftTarget {
  /** 現在の workspace の path（無い環境では null）。鍵には hash だけを使う。 */
  workspacePath: string | null;
  projectId: string;
  /** 既存 session の id。新しいチャット（session 未作成）は null。 */
  sessionId: string | null;
  /** session 未作成のときの scope の識別（例: `scene:<id>`）。 */
  scopeSlot: string;
}

export interface ChatInputDraftContent {
  doc: JSONContent;
  commandId: string | null;
}

interface StoredChatInputDraft extends ChatInputDraftContent {
  v: 1;
  key: string;
  updatedAt: number;
}

export type ChatInputDraftWriteResult =
  | "saved"
  | "removed"
  | "too-large"
  | "purged"
  | "unavailable";

export function chatInputDraftKey(target: ChatInputDraftTarget): string {
  const slot =
    target.sessionId !== null
      ? "s:" + encodeURIComponent(target.sessionId)
      : "n:" + encodeURIComponent(target.scopeSlot);
  return (
    CHAT_INPUT_DRAFT_KEY_PREFIX +
    hashChatInputDraftWorkspace(target.workspacePath) +
    "|" +
    encodeURIComponent(target.projectId) +
    "|" +
    slot
  );
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parseStored(
  raw: string | null,
  key: string,
): StoredChatInputDraft | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredChatInputDraft> | null;
    if (
      !value ||
      value.v !== 1 ||
      value.key !== key ||
      typeof value.updatedAt !== "number" ||
      !value.doc ||
      typeof value.doc !== "object" ||
      value.doc.type !== "doc" ||
      (value.commandId !== null && typeof value.commandId !== "string")
    ) {
      return null;
    }
    return value as StoredChatInputDraft;
  } catch {
    return null;
  }
}

/** 保存値を読む。壊れた値・別の鍵の値は無視して消す。 */
export function readChatInputDraft(key: string): ChatInputDraftContent | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    const parsed = parseStored(raw, key);
    if (!parsed) {
      if (raw !== null) store.removeItem(key);
      return null;
    }
    return { doc: parsed.doc, commandId: parsed.commandId };
  } catch {
    return null;
  }
}

/** 鍵に保存があるか（壊れた値も「ある」とみなす。消すかどうかは読む側が決める）。 */
export function hasChatInputDraft(key: string): boolean {
  try {
    return storage()?.getItem(key) != null;
  } catch {
    return false;
  }
}

export function removeChatInputDraft(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // 消せなくても入力は続けられる。
  }
}

/**
 * `purgeIndex`（bind した時点の削除記録の長さ）より後に、この target を消す記録があるか。
 * session の削除と project の削除は恒久なので、記録の位置に関わらず照合する。
 */
export function isChatInputDraftPurged(
  target: Pick<
    ChatInputDraftTarget,
    "workspacePath" | "projectId" | "sessionId"
  >,
  purgeIndex: number,
): boolean {
  const workspace = hashChatInputDraftWorkspace(target.workspacePath);
  return getChatInputDraftPurges().some(
    ([purgedWorkspace, projectId, sessionId, permanent], index) =>
      purgedWorkspace === workspace &&
      projectId === target.projectId &&
      (sessionId === null || sessionId === target.sessionId) &&
      (permanent || index >= purgeIndex),
  );
}

/** `keepKey` に `size` byte を書く前に、数と合計の上限に収まるまで古いものから消す。 */
function evictOldest(store: Storage, keepKey: string, size: number): void {
  const entries: Array<{ key: string; raw: string; size: number }> = [];
  let total = size;
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key?.startsWith(CHAT_INPUT_DRAFT_KEY_PREFIX) || key === keepKey)
      continue;
    const raw = store.getItem(key) ?? "";
    const entrySize = (key.length + raw.length) * 2;
    entries.push({ key, raw, size: entrySize });
    total += entrySize;
  }
  let count = entries.length + 1;
  if (
    count <= CHAT_INPUT_DRAFT_MAX_ENTRIES &&
    total <= CHAT_INPUT_DRAFT_MAX_TOTAL_BYTES
  ) {
    return;
  }
  const ordered = entries
    .map((entry) => ({
      ...entry,
      updatedAt: parseStored(entry.raw, entry.key)?.updatedAt ?? -1,
    }))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const entry of ordered) {
    if (
      count <= CHAT_INPUT_DRAFT_MAX_ENTRIES &&
      total <= CHAT_INPUT_DRAFT_MAX_TOTAL_BYTES
    ) {
      break;
    }
    store.removeItem(entry.key);
    count -= 1;
    total -= entry.size;
  }
}

/**
 * 下書きを書く。`content` が null（空の入力）なら保存を消す。
 * 上限を超えたら保存せず、前の保存も消す（古い内容を復元させない）。ただし
 * `keepExistingWhenTooLarge` のときは、前の保存を残す（別の会話から持ち越した、保存できない
 * 内容で、移り先の下書きを消さないため）。
 */
export function writeChatInputDraft(
  key: string,
  target: Pick<
    ChatInputDraftTarget,
    "workspacePath" | "projectId" | "sessionId"
  >,
  purgeIndex: number,
  content: ChatInputDraftContent | null,
  now: number = Date.now(),
  keepExistingWhenTooLarge = false,
): ChatInputDraftWriteResult {
  if (isChatInputDraftPurged(target, purgeIndex)) return "purged";
  const store = storage();
  if (!store) return "unavailable";
  try {
    if (content === null) {
      store.removeItem(key);
      return "removed";
    }
    const value: StoredChatInputDraft = {
      v: 1,
      key,
      updatedAt: now,
      doc: content.doc,
      commandId: content.commandId,
    };
    const serialized = JSON.stringify(value);
    if (
      new TextEncoder().encode(serialized).length > CHAT_INPUT_DRAFT_MAX_BYTES
    ) {
      if (!keepExistingWhenTooLarge) store.removeItem(key);
      return "too-large";
    }
    evictOldest(store, key, (key.length + serialized.length) * 2);
    store.setItem(key, serialized);
    return "saved";
  } catch {
    // quota 超過など。本文はログに出さない。
    return "unavailable";
  }
}
