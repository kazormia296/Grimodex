import { debugLog } from "@/lib/debugLog";
import { errorDetail } from "@/lib/debugLog";
import {
  semanticIndexScene,
  codexIndexEntry,
  chatIndexMessage,
  eventsIndexEntry,
} from "./api";
import {
  cancelEditorAnalysisTask,
  scheduleEditorAnalysisTask,
} from "@/lib/editorAnalysisScheduler";

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

const sceneTaskIds = new Set<string>();
const codexTimers = new Map<string, ReturnType<typeof setTimeout>>();
const eventTimers = new Map<string, ReturnType<typeof setTimeout>>();
const chatTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sceneTaskKey(sceneId: string): string {
  return `semantic-scene:${sceneId}`;
}

export function scheduleSceneIndex(sceneId: string): void {
  if (!sceneId) return;
  sceneTaskIds.add(sceneId);
  scheduleEditorAnalysisTask({
    key: sceneTaskKey(sceneId),
    kind: "semantic",
    delayMs: INDEX_DEBOUNCE_MS,
    run: async () => {
      sceneTaskIds.delete(sceneId);
      try {
        await semanticIndexScene(sceneId);
      } catch (e) {
        // model 不在 / workspace 未オープン等は dev で通常発生する。
        // 静かに debugLog にだけ残す (ユーザー UI には出さない)。
        debugLog.warn(
          "semantic-search",
          `semantic_index_scene failed: ${sceneId}`,
          errorDetail(e),
        );
      }
    },
  });
}

export function cancelSceneIndex(sceneId: string): void {
  cancelEditorAnalysisTask(sceneTaskKey(sceneId));
  sceneTaskIds.delete(sceneId);
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
 * Chronicle event 保存後にデバウンス付きで `events_index_entry` を走らせる
 * (作中年表 RAG, Phase 3)。scene/codex 版と同型: title/note/参加者/主役/場所 変更時に
 * 呼び、2.5s 後 1 度だけ invoke。UI 経路 (chronicle/api.ts) と agent 経路
 * (agent_event_*) の両方から呼ぶこと。Rust の content_hash 再検証が正しさを担保。
 */
export function scheduleEventIndex(eventId: string): void {
  if (!eventId) return;
  const existing = eventTimers.get(eventId);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(() => {
    eventTimers.delete(eventId);
    eventsIndexEntry(eventId).catch((e) => {
      debugLog.warn(
        "semantic-search",
        `events_index_entry failed: ${eventId}`,
        errorDetail(e),
      );
    });
  }, INDEX_DEBOUNCE_MS);
  eventTimers.set(eventId, t);
}

export function cancelEventIndex(eventId: string): void {
  const t = eventTimers.get(eventId);
  if (t !== undefined) {
    clearTimeout(t);
    eventTimers.delete(eventId);
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
  for (const sceneId of sceneTaskIds) {
    cancelEditorAnalysisTask(sceneTaskKey(sceneId));
  }
  sceneTaskIds.clear();
  for (const t of codexTimers.values()) clearTimeout(t);
  codexTimers.clear();
  for (const t of eventTimers.values()) clearTimeout(t);
  eventTimers.clear();
  for (const t of chatTimers.values()) clearTimeout(t);
  chatTimers.clear();
}

/** テスト用: 現在保持しているタイマー件数 (scene + codex + event + chat)。 */
export function _pendingCount(): number {
  return (
    sceneTaskIds.size + codexTimers.size + eventTimers.size + chatTimers.size
  );
}
