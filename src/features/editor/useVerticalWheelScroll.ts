import { useEffect, type RefObject } from "react";
import {
  getLogicalScrollOffset,
  setLogicalScrollOffset,
} from "@/features/editor/editorLayout";

/**
 * ホイールイベント 1 回ぶんを縦書きの読み進みスクロールに変換する純ロジック。
 * 処理した (preventDefault すべき) 場合 true を返す。
 *
 * - 縦 delta が主成分のときだけ奪う。トラックパッドの横スワイプや
 *   Shift+wheel (ブラウザが deltaX に変換する) はネイティブに任せる。
 * - ctrlKey はピンチズーム/ブラウザズームなので触らない。
 * - deltaMode はピクセル以外 (行/ページ) を概算でピクセル換算する。
 */
export function applyVerticalWheel(
  el: {
    scrollLeft: number;
    scrollTop: number;
    clientWidth: number;
  },
  e: {
    deltaY: number;
    deltaX: number;
    deltaMode: number;
    ctrlKey: boolean;
  },
): boolean {
  if (e.ctrlKey) return false;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return false;
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
  // 論理オフセット (前方=増加) に deltaY を足す: ホイール下 = 読み進む =
  // vertical-rl では左へスクロール。符号規約は editorLayout に閉じ込め済み。
  setLogicalScrollOffset(
    el,
    getLogicalScrollOffset(el, true) + e.deltaY * unit,
    true,
  );
  return true;
}

/**
 * 縦書きモード時、マウスホイールの縦回転を読み進み方向 (横) のスクロールに
 * 変換する。preventDefault が必要なので React の onWheel (passive) ではなく
 * 非 passive リスナーを直接張る。
 */
export function useVerticalWheelScroll(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented) return;
      if (applyVerticalWheel(el, e)) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, enabled]);
}
