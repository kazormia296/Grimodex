import { useEffect, type RefObject } from "react";
import { isWebKitGtk } from "@/lib/platform";

/**
 * WebKitGTK の vertical-rl スクロールリセットバグの検出即復元ガード。
 *
 * WebKitGTK (2.52 で実測) は vertical-rl のスクロールコンテナに対し、DOM 変異
 * （ポップオーバーの portal 追加・decoration 更新など、コンテナ外の変異でも）
 * による relayout 時に scrollLeft を scroll origin (= 0 = 縦書きの先頭・右端)
 * へリセットすることがある。JS は一切関与しないエンジン内部の挙動で、
 * Codex ホバーポップオーバー表示時の「先頭へスクロール」の真因
 * （scrollLeft/scrollTo/scrollIntoView/focus を全て監視して JS 呼び出しゼロを
 * 実機で確認済み）。focus/scrollToSelection 経路のガードでは防げない。
 *
 * 対策: コンテナの scrollLeft accessor をインスタンス上で shadow して
 * 「JS からの書き込み時刻」を記録し、scroll イベントで
 *   新値 === 0 かつ 直前値が十分奥 (< -RESET_MIN_DISTANCE_PX) かつ
 *   直近 JS_WRITE_WINDOW_MS 以内に JS 書き込みなし
 * のときだけエンジンリセットと判定して直前値へ同期復元する。
 * scroll イベントハンドラ内の同期復元なので 0 の状態はペイントされない
 * （WebKit のレンダリング更新は scroll steps → paint の順。実機で前後
 * スナップショット比較しチラつき無しを確認済み）。
 *
 * 誤爆しない設計（実機検証済み）:
 * - 正当な JS の「先頭へ」(scrollLeft=0 / setLogicalScrollOffset(0)) は
 *   shadow setter が書き込み時刻を記録するため素通しになる。
 * - wheel スクロール (useVerticalWheelScroll) も setter 経由なので干渉しない。
 * - smooth スクロール (scrollIntoView({behavior:"smooth"}) 等) は中間値を
 *   連続で通るため直前値が -RESET_MIN_DISTANCE_PX を跨いだ最終段では発火
 *   条件を満たさない。
 * - スクロールバードラッグも中間値を連続で通るため同様。
 * 念のため scrollTo/scroll/scrollBy のインスタンスメソッドも wrap して
 * JS 書き込み時刻を記録する。
 */

/** リセット判定の最小移動距離。これ未満の位置からの 0 到達は通常操作とみなす。 */
const RESET_MIN_DISTANCE_PX = 150;
/** この時間内に JS 書き込みがあれば 0 到達を JS 由来とみなす。 */
const JS_WRITE_WINDOW_MS = 250;

export function useWebKitGtkVerticalScrollResetGuard(
  containerRef: RefObject<HTMLElement | null>,
  vertical: boolean,
): void {
  useEffect(() => {
    if (!vertical || !isWebKitGtk()) return;
    const el = containerRef.current;
    if (!el) return;

    // prototype チェーンから元の scrollLeft accessor を探す
    let desc: PropertyDescriptor | undefined;
    for (
      let proto: object | null = Object.getPrototypeOf(el);
      proto;
      proto = Object.getPrototypeOf(proto)
    ) {
      desc = Object.getOwnPropertyDescriptor(proto, "scrollLeft");
      if (desc) break;
    }
    const getSl = desc?.get;
    const setSl = desc?.set;
    if (!getSl || !setSl) return;

    let lastJsWrite = 0;
    let lastScrollLeft = getSl.call(el) as number;
    let restoring = false;

    // インスタンス上に shadow accessor（グローバル汚染なし・cleanup で原状復帰）
    Object.defineProperty(el, "scrollLeft", {
      configurable: true,
      get() {
        return getSl.call(this) as number;
      },
      set(v: number) {
        lastJsWrite = Date.now();
        setSl.call(this, v);
      },
    });
    const originalScrollTo = el.scrollTo.bind(el);
    const originalScroll = el.scroll.bind(el);
    const originalScrollBy = el.scrollBy.bind(el);
    el.scrollTo = ((...args: Parameters<Element["scrollTo"]>) => {
      lastJsWrite = Date.now();
      originalScrollTo(...(args as [number, number]));
    }) as Element["scrollTo"];
    el.scroll = ((...args: Parameters<Element["scroll"]>) => {
      lastJsWrite = Date.now();
      originalScroll(...(args as [number, number]));
    }) as Element["scroll"];
    el.scrollBy = ((...args: Parameters<Element["scrollBy"]>) => {
      lastJsWrite = Date.now();
      originalScrollBy(...(args as [number, number]));
    }) as Element["scrollBy"];

    const onScroll = () => {
      const sl = getSl.call(el) as number;
      if (
        !restoring &&
        sl === 0 &&
        lastScrollLeft < -RESET_MIN_DISTANCE_PX &&
        Date.now() - lastJsWrite > JS_WRITE_WINDOW_MS
      ) {
        // エンジンの vertical-rl scroll origin リセットと判定 → 直前値へ復元。
        // lastScrollLeft は維持する（復元で再度 scroll イベントが来ても
        // 同値なので何も起きない）。
        restoring = true;
        setSl.call(el, lastScrollLeft);
        restoring = false;
        return;
      }
      lastScrollLeft = sl;
    };
    el.addEventListener("scroll", onScroll);

    return () => {
      el.removeEventListener("scroll", onScroll);
      // インスタンス shadow を除去して prototype accessor に戻す
      delete (el as unknown as Record<string, unknown>).scrollLeft;
      delete (el as unknown as Record<string, unknown>).scrollTo;
      delete (el as unknown as Record<string, unknown>).scroll;
      delete (el as unknown as Record<string, unknown>).scrollBy;
    };
  }, [containerRef, vertical]);
}
