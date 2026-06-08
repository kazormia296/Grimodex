import { useSyncExternalStore } from "react";

import { getAnnouncerState, subscribeAnnouncer } from "@/lib/a11y/announcer";

/**
 * グローバル aria-live region。App ルートに常設し、`announce()`
 * (src/lib/a11y/announcer.ts) で流されたメッセージをスクリーンリーダーへ
 * 読み上げさせる。視覚的には何も表示しない (sr-only)。
 *
 * - polite: 進行中の作業を邪魔しない通常通知 (保存完了・生成完了など)
 * - assertive (role=alert): 割り込みが必要な通知 (エラーなど)
 */
export function LiveRegion() {
  const stateSnapshot = useSyncExternalStore(
    subscribeAnnouncer,
    getAnnouncerState,
    getAnnouncerState,
  );

  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {stateSnapshot.polite}
      </div>
      <div
        aria-live="assertive"
        role="alert"
        aria-atomic="true"
        className="sr-only"
      >
        {stateSnapshot.assertive}
      </div>
    </>
  );
}
