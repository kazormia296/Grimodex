import { debugLog } from "@/lib/debugLog";
import { errorDetail } from "@/lib/debugLog";
import { semanticIndexScene, codexIndexEntry, chatIndexMessage } from "./api";

/**
 * シーン保存後にデバウンス付きでセマンティックインデックスを走らせるスケジューラ。
 *
 * 設計: temp/semantic-prose-search-context.md §3.6。
 *
 * - autoSave が `coreSave` を毎に呼ぶたび `scheduleSceneIndex(sceneId)` を呼ぶ。
 * - 内部で `sceneId` 別のタイマーマップを持ち、同じ id で再スケジュールされると
 *   既存タイマーをクリアして 2.5s 後に発火させる。
 * - 連続入力で `coreSave` が立て続けに走っても、最後の呼び出しから 2.5s 待ってから
 *   1 度だけ `semantic_index_scene` を invoke する。
 * - 失敗は `debugLog.warn` に流すだけ (model 不在の dev で console を汚さない)。
 *   正しさは Rust 側の `content_hash` 再検証で担保される (§3.4)。
 */

const INDEX_DEBOUNCE_MS = 2500;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const codexTimers = new Map<string, ReturnType<typeof setTimeout>>();
const chatTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleSceneIndex(sceneId: string): void {
  if (!sceneId) return;
  const existing = timers.get(sceneId);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(() => {
    timers.delete(sceneId);
    semanticIndexScene(sceneId).catch((e) => {
      // model 不在 / workspace 未オープン等は dev で通常発生する。
      // 静かに debugLog にだけ残す (ユーザー UI には出さない)。
      debugLog.warn(
        "semantic-search",
        `semantic_index_scene failed: ${sceneId}`,
        errorDetail(e),
      );
    });
  }, INDEX_DEBOUNCE_MS);
  timers.set(sceneId, t);
}

export function cancelSceneIndex(sceneId: string): void {
  const t = timers.get(sceneId);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(sceneId);
  }
}

/**
 * Codex エントリ保存後にデバウンス付きで `codex_index_entry` を走らせる。
 * scene 版と同型: name/summary/content/aliases 変更時に呼び、2.5s 後 1 度だけ invoke。
 * UI 経路 (codex/api.ts) と agent 経路 (agent_codex_*) の両方から呼ぶこと。
 */
export function scheduleCodexIndex(entryId: string): void {
  if (!entryId) return;
  const existing = codexTimers.get(entryId);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(() => {
    codexTimers.delete(entryId);
    codexIndexEntry(entryId).catch((e) => {
      debugLog.warn(
        "semantic-search",
        `codex_index_entry failed: ${entryId}`,
        errorDetail(e),
      );
    });
  }, INDEX_DEBOUNCE_MS);
  codexTimers.set(entryId, t);
}

export function cancelCodexIndex(entryId: string): void {
  const t = codexTimers.get(entryId);
  if (t !== undefined) {
    clearTimeout(t);
    codexTimers.delete(entryId);
  }
}

/**
 * チャットメッセージ確定後にデバウンス付きで `chat_index_message` を走らせる
 * (エピソード記憶の index)。scene/codex 版と同型。
 * - addMessage (user/assistant の確定 1 回) と updateMessageMetadata
 *   (insertedToEditor / extractedCodex 信号の変化 → weight 列更新) の両方から呼ぶ。
 * - 連続呼び出しは 2.5s デバウンスで 1 回に畳む (streaming delta は addMessage が
 *   確定時 1 回なので元々畳まれている)。Rust の content_hash 再検証が正しさを担保。
 */
export function scheduleChatIndex(messageId: string): void {
  if (!messageId) return;
  const existing = chatTimers.get(messageId);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(() => {
    chatTimers.delete(messageId);
    chatIndexMessage(messageId).catch((e) => {
      debugLog.warn(
        "semantic-search",
        `chat_index_message failed: ${messageId}`,
        errorDetail(e),
      );
    });
  }, INDEX_DEBOUNCE_MS);
  chatTimers.set(messageId, t);
}

export function cancelChatIndex(messageId: string): void {
  const t = chatTimers.get(messageId);
  if (t !== undefined) {
    clearTimeout(t);
    chatTimers.delete(messageId);
  }
}

/** テスト用: 全タイマーを破棄してマップを空に戻す。 */
export function _resetSchedulerForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  for (const t of codexTimers.values()) clearTimeout(t);
  codexTimers.clear();
  for (const t of chatTimers.values()) clearTimeout(t);
  chatTimers.clear();
}

/** テスト用: 現在保持しているタイマー件数 (scene + codex + chat)。 */
export function _pendingCount(): number {
  return timers.size + codexTimers.size + chatTimers.size;
}
