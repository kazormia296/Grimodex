import { useEffect, type RefObject } from "react";
import { isWebKitGtk } from "@/lib/platform";

/**
 * WebKitGTK の vertical-rl スクロールリセットバグの検出即復元ガード。
 *
 * WebKitGTK (2.52 で実測) は vertical-rl のスクロールコンテナに対し、DOM 変異
 * （ポップオーバーの portal 追加・decoration 再構築・reorder ハンドル一斉付与
 * など、コンテナ外の変異でも）による relayout 時に scrollLeft を scroll
 * origin (= 0 = 縦書きの先頭・右端) へリセットすることがある。JS は一切関与
 * しないエンジン内部の挙動（scroll 系 API 全 monkeypatch で呼び出しゼロを
 * 実機確認済み）で、Codex ホバーポップオーバー・入力直後のデコレーション
 * 再構築・Alt 押下（reorder ハンドル付与）での「先頭へスクロール」の真因。
 *
 * 対策は三層:
 * 1. 【治癒】リセット検出時にスクローラ自身のジオメトリを一瞬摂動する —
 *    実測でスクローラのジオメトリ変更後は同一セッション中この現象が
 *    再発しなくなる（armed 状態の解除）。ガード有効化時にも一度行う。
 * 2. 【復元】scroll イベントで「新値が先頭 × 直前値が十分奥 × 直近の JS
 *    書き込みで説明できない」ときエンジンリセットと判定し、直前値へ同期
 *    復元する。scroll イベントハンドラ内の同期復元なので 0 の状態は
 *    ペイントされない（実機で前後スナップショット一致を確認済み）。
 * 3. 【再アサート】変異ストーム中は relayout 直後に scrollWidth が一時的に
 *    縮んで復元書き込みがクランプされ、そのまま scroll イベントが来ずに
 *    先頭で止まることがある。復元後 0/50/150/300ms に再確認し、先頭に
 *    戻されていれば書き直す（その間に JS 書き込みが入ったら即座に手を引く）。
 *
 * 誤爆しない設計:
 * - JS からのあらゆるスクロール書き込み（scrollLeft setter / scrollTo /
 *   scroll / scrollBy）はインスタンス shadow で時刻と値を記録する。
 *   「直近の書き込みが先頭近傍 (> -RESET_MIN_DISTANCE_PX) の値」だった場合
 *   のみ 0 到達を JS 由来（Ctrl+Home 等）とみなして素通しする — 奥の値を
 *   書いた直後（入力中の PM の caret 追従など）にエンジンが 0 へ落とした
 *   ケースは復元対象のまま。
 * - wheel スクロール (useVerticalWheelScroll) は setter 経由 = 値が記録される
 *   ため干渉しない。smooth スクロールやスクロールバードラッグは中間値を
 *   連続で通るため「直前値が -RESET_MIN_DISTANCE_PX より奥」の条件を最終段
 *   では満たさない。
 * - 既知の限界: ネイティブの慣性フリングが減速せず >150px/フレームの跳びで
 *   先頭境界へ着地した場合は誤検知しうるが、縦書きのホイールは JS 変換経由
 *   のため実経路では起きない。
 */

/** リセット判定の最小移動距離。これ未満の位置からの先頭到達は通常操作とみなす。 */
const RESET_MIN_DISTANCE_PX = 150;
/** この時間内の「先頭近傍への JS 書き込み」があれば先頭到達を JS 由来とみなす。 */
const JS_WRITE_WINDOW_MS = 250;
/** 復元後の再アサート時刻（クランプされた復元の書き直し）。 */
const REASSERT_DELAYS_MS = [0, 50, 150, 300];

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
    /** 直近の JS 書き込みの絶対値（不明な相対書き込みは null）。 */
    let lastJsWriteValue: number | null = null;
    let lastScrollLeft = getSl.call(el) as number;
    let restoring = false;
    let reassertTimers: ReturnType<typeof setTimeout>[] = [];

    const noteJsWrite = (value: number | null) => {
      lastJsWrite = Date.now();
      lastJsWriteValue = value;
    };

    // インスタンス上に shadow accessor（グローバル汚染なし・cleanup で原状復帰）
    Object.defineProperty(el, "scrollLeft", {
      configurable: true,
      get() {
        return getSl.call(this) as number;
      },
      set(v: number) {
        noteJsWrite(v);
        setSl.call(this, v);
      },
    });
    const originalScrollTo = el.scrollTo.bind(el);
    const originalScroll = el.scroll.bind(el);
    const originalScrollBy = el.scrollBy.bind(el);
    const leftOf = (args: unknown[]): number | null => {
      const a = args[0];
      if (typeof a === "number") return a;
      if (a && typeof a === "object" && "left" in a) {
        const left = (a as ScrollToOptions).left;
        return typeof left === "number" ? left : null;
      }
      return null;
    };
    el.scrollTo = ((...args: Parameters<Element["scrollTo"]>) => {
      noteJsWrite(leftOf(args));
      originalScrollTo(...(args as [number, number]));
    }) as Element["scrollTo"];
    el.scroll = ((...args: Parameters<Element["scroll"]>) => {
      noteJsWrite(leftOf(args));
      originalScroll(...(args as [number, number]));
    }) as Element["scroll"];
    el.scrollBy = ((...args: Parameters<Element["scrollBy"]>) => {
      noteJsWrite(null); // 相対量なので着地値は不明
      originalScrollBy(...(args as [number, number]));
    }) as Element["scrollBy"];

    /** 先頭到達が直近の JS 書き込みで説明できるか（Ctrl+Home 等の素通し判定）。 */
    const explainedByJsWrite = () =>
      Date.now() - lastJsWrite <= JS_WRITE_WINDOW_MS &&
      (lastJsWriteValue === null || lastJsWriteValue > -RESET_MIN_DISTANCE_PX);

    /** armed 状態の解除。スクローラのジオメトリを一瞬摂動して同期 reflow を挟む。 */
    const perturbGeometry = () => {
      const prev = el.style.paddingRight;
      el.style.paddingRight = "0.5px";
      void el.offsetWidth;
      el.style.paddingRight = prev;
      void el.offsetWidth;
    };

    const clearReasserts = () => {
      for (const t of reassertTimers) clearTimeout(t);
      reassertTimers = [];
    };

    /** 復元書き込み（クランプされた場合に備えた遅延再アサート付き）。 */
    const restoreTo = (target: number) => {
      restoring = true;
      setSl.call(el, target);
      restoring = false;
      clearReasserts();
      const campaignStart = Date.now();
      for (const delay of REASSERT_DELAYS_MS) {
        reassertTimers.push(
          setTimeout(() => {
            // キャンペーン開始後に JS が明示的にスクロールしたら手を引く
            if (lastJsWrite > campaignStart) return;
            if ((getSl.call(el) as number) > -1) {
              restoring = true;
              setSl.call(el, target);
              restoring = false;
            }
          }, delay),
        );
      }
    };

    const onScroll = () => {
      const sl = getSl.call(el) as number;
      if (
        !restoring &&
        sl > -1 &&
        lastScrollLeft < -RESET_MIN_DISTANCE_PX &&
        !explainedByJsWrite()
      ) {
        // エンジンの vertical-rl scroll origin リセットと判定。
        // 先に armed 状態を解除してストームの続きを止め、直前値へ復元する。
        // lastScrollLeft は維持（復元で再度 scroll イベントが来ても同値）。
        perturbGeometry();
        restoreTo(lastScrollLeft);
        return;
      }
      lastScrollLeft = sl;
    };
    el.addEventListener("scroll", onScroll);
    // 有効化時にも一度 armed 状態を解除しておく（予防的治癒）
    perturbGeometry();

    return () => {
      clearReasserts();
      el.removeEventListener("scroll", onScroll);
      // インスタンス shadow を除去して prototype accessor に戻す
      delete (el as unknown as Record<string, unknown>).scrollLeft;
      delete (el as unknown as Record<string, unknown>).scrollTo;
      delete (el as unknown as Record<string, unknown>).scroll;
      delete (el as unknown as Record<string, unknown>).scrollBy;
    };
  }, [containerRef, vertical]);
}
