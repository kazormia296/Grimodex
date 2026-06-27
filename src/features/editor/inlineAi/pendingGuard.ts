import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { useInlineAiStore } from "./inlineAiStore";

/**
 * インライン AI がペンディング中 (生成中 / diff 表示中 / error) かを **同期** で返す。
 *
 * これらの状態では本文 doc に未確定・未保存の AI 生成テキストが乗っており
 * (`InlineAIDiffPlugin` の装飾と `useInlineAiDiff` の history-less 挿入)、autosave は
 * 意図的に止まっている (`EditorPane`/`LinearSceneBlock` の onUpdate ゲート)。この窓で
 * シーンを離れる・エディタを閉じる・本文を破壊する・アプリを終了すると、未確定文や
 * 並行手動編集が flush されず喪失する。離脱/破壊系の実アクションはここを見て弾く。
 */
export function isInlineAiPending(): boolean {
  const s = useInlineAiStore.getState().status;
  return s === "generating" || s === "diffShown" || s === "error";
}

/**
 * 同一ユーザー操作が複数チョークポイント (例: TabBar の `setActiveTab` → 続く
 * `setActiveScene`) から guard を呼んでも toast / shake を多重発火させないための
 * スロットル窓 (ms)。ブロック判定自体は毎回行うが、通知だけ間引く。
 */
const NOTIFY_THROTTLE_MS = 300;
let notifyThrottled = false;

function notifyBlocked(): void {
  if (notifyThrottled) return;
  notifyThrottled = true;
  setTimeout(() => {
    notifyThrottled = false;
  }, NOTIFY_THROTTLE_MS);
  toast.info(i18next.t("inlineAi.pendingBlocked"));
  useInlineAiStore.getState().requestAttention();
}

/**
 * ペンディング中なら通知 (toast + ツールバー shake) して `true`(=ブロック) を返す。
 * 各離脱/破壊系チョークポイントは状態を書き換える **前** に
 * `if (guardInlineAiPending()) return;` で早期 return する。
 *
 * `silent: true` のときは判定だけ行い通知しない。TabBar→treeStore のように主防御で
 * 既に通知済みの経路を二重防御で塞ぐ内側用 (通知の重複や、判定だけしたい用途)。
 */
export function guardInlineAiPending(opts?: { silent?: boolean }): boolean {
  if (!isInlineAiPending()) return false;
  if (!opts?.silent) notifyBlocked();
  return true;
}

/** テスト専用: 通知スロットルをリセットする。 */
export function resetPendingGuardThrottle(): void {
  notifyThrottled = false;
}
