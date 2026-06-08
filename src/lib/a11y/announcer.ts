/**
 * グローバル aria-live announcer。
 *
 * スクリーンリーダー利用者に「トーストを出さない無音イベント」(自動保存完了 /
 * AI ストリーム開始終了 / import 完了 / 外部編集取り込み等) を読み上げるための
 * 薄い singleton。React の外 (Zustand ストアの async コールバック等) からも
 * `announce()` を呼べるよう、module-level state + subscribe で実装している。
 *
 * 実 DOM への反映は `<LiveRegion>` (src/components/a11y/LiveRegion.tsx) が
 * `useSyncExternalStore` で購読して行う。
 *
 * Sonner のトーストは独自の aria-live を持つため、トーストを出すパスには
 * announce() を足さないこと (二重読み上げ防止)。
 */

export type AnnouncePoliteness = "polite" | "assertive";

export interface AnnouncerState {
  polite: string;
  assertive: string;
}

// 同一テキストを連続で流すと SR が「変化なし」とみなして読み上げを落とす。
// 末尾の zero-width space をトグルして DOM テキストノードを必ず変化させる
// (SR は ZWSP を発音しないので聞こえ方は同じ)。
const ZWSP = String.fromCharCode(0x200b);

let state: AnnouncerState = { polite: "", assertive: "" };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * メッセージを live region に流す。
 * @param level "polite" (既定, 進行中の作業を邪魔しない) / "assertive" (エラー等の割り込み)
 */
export function announce(
  message: string,
  level: AnnouncePoliteness = "polite",
): void {
  const text = message.trim();
  if (!text) return;

  const prev = level === "polite" ? state.polite : state.assertive;
  const next = prev.endsWith(ZWSP) ? text : `${text}${ZWSP}`;

  if (level === "polite") {
    state = { polite: next, assertive: state.assertive };
  } else {
    state = { polite: state.polite, assertive: next };
  }
  emit();
}

export function subscribeAnnouncer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAnnouncerState(): AnnouncerState {
  return state;
}

/** テスト用: state を初期化する。 */
export function __resetAnnouncerForTest(): void {
  state = { polite: "", assertive: "" };
}
