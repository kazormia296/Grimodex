import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * ポップオーバー / ドロップダウンを閉じたとき、開いた時点でフォーカスを持って
 * いた要素（通常はトリガ）へフォーカスを戻す a11y ヘルパー。
 *
 * 復元しないケース:
 * - 外側クリックで閉じたとき（クリック先のフォーカスを奪わない）。直近の入力が
 *   contentRef / ownerRef の外側での mousedown だったかを capture で追跡し、
 *   キー入力が来たら解除する（Escape close は復元対象のため、最後の入力手段で
 *   判定する）。
 * - close 時点でフォーカスが既に別の生きた要素へ移っているとき（呼び出し側が
 *   close と同時にエディタ等へフォーカスを移すケースを尊重する）。
 *
 * AnimatePresence の exit アニメ中もコンテンツは DOM に残るため、open=false へ
 * 遷移した commit の effect（= unmount 前）で復元する。
 */
export function useFocusRestoreOnClose(
  open: boolean,
  contentRef: RefObject<HTMLElement | null>,
  ownerRef?: RefObject<HTMLElement | null>,
  enabled = true,
) {
  const savedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const outsidePressRef = useRef(false);

  useEffect(() => {
    if (!open || !enabled) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      outsidePressRef.current =
        !contentRef.current?.contains(target) &&
        !ownerRef?.current?.contains(target);
    };
    const onKeyDown = () => {
      outsidePressRef.current = false;
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, enabled, contentRef, ownerRef]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      // open 遷移: 現在のフォーカス（通常トリガ）を保存する。コンテンツ内の
      // autoFocus 等で既にフォーカスが内側にある場合は復元先が無いので保存しない。
      const active = document.activeElement;
      savedRef.current =
        enabled &&
        active instanceof HTMLElement &&
        active !== document.body &&
        !contentRef.current?.contains(active)
          ? active
          : null;
      outsidePressRef.current = false;
    } else if (!open && wasOpenRef.current) {
      // close 遷移: Escape / 選択で閉じたときのみ復元する。
      const saved = savedRef.current;
      savedRef.current = null;
      const shouldRestore =
        enabled &&
        !outsidePressRef.current &&
        saved !== null &&
        saved.isConnected &&
        !(contentRef.current?.contains(saved) ?? false);
      if (shouldRestore) {
        const active = document.activeElement;
        // フォーカスが既に生きた別要素へ移っているなら奪わない。
        const focusIsLoose =
          !active ||
          active === document.body ||
          active === saved ||
          !active.isConnected ||
          (contentRef.current?.contains(active) ?? false);
        if (focusIsLoose) saved.focus();
      }
      outsidePressRef.current = false;
    }
    wasOpenRef.current = open;
  }, [open, enabled, contentRef]);
}
