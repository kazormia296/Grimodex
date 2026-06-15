import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";

/** トリガからポップオーバーを開く向き。 */
export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start";

interface UseAnchoredPopoverResult {
  /** portal するポップオーバー本体に付ける ref（外側クリック判定に使う）。 */
  popoverRef: RefObject<HTMLDivElement | null>;
  /** open の間だけ非 null。createPortal する本体の style に展開する。 */
  style: CSSProperties | null;
}

/**
 * トリガ基準で `document.body` に portal する固定配置ポップオーバーのための
 * 位置計算 + 外側クリック/Escape での閉じ処理をまとめる hook。
 *
 * `.glass-chat`（チャットパネル）など `backdrop-filter` を持つ祖先は CSS 仕様上
 * stacking context と containing block を作るため、その内側の inline
 * `position: absolute` ポップオーバーは z-index をいくら上げても兄弟パネルの
 * 下に埋もれ、さらに祖先の `overflow: hidden` でクリップされる。対策は
 * `document.body` へ portal して祖先 stacking context を脱出し、`position: fixed`
 * でトリガ矩形基準に配置すること（既存の ContextPillGroup と同じ方針）。
 *
 * トリガ ref は呼び出し側が所有して渡す。これにより 1 つのトリガに複数の
 * ポップオーバー（例: スコープピッカー本体と時限ヒント）を別インスタンスで
 * ぶら下げられる。
 */
export function useAnchoredPopover(
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  placement: PopoverPlacement = "bottom-start",
): UseAnchoredPopoverResult {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  // onClose は inline arrow で毎レンダー変わりがちなので ref 経由で読み、
  // リスナの再購読を open 遷移時だけに抑える。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // トリガ矩形 + placement から fixed 座標を計算する。
  const computeStyle = useCallback((): CSSProperties | null => {
    const el = triggerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const margin = 4;
    const vw = window.innerWidth;
    const next: CSSProperties = { position: "fixed" };
    if (placement === "top-start") {
      // 上向き: ポップオーバー下端をトリガ上端に合わせる（高さ不要で配置可能）。
      next.bottom = window.innerHeight - r.top + margin;
      next.left = Math.max(margin, r.left);
    } else if (placement === "bottom-end") {
      // 右揃え: トリガ右端にポップオーバー右端を合わせる。
      next.top = r.bottom + margin;
      next.right = Math.max(margin, vw - r.right);
    } else {
      next.top = r.bottom + margin;
      next.left = Math.max(margin, r.left);
    }
    return next;
  }, [placement, triggerRef]);

  // 開いている間はトリガ矩形に追従して配置する。SessionsPanel の overflow-y-auto
  // 内メニューのようにトリガがスクロールで動くケースや window resize で fixed 座標
  // が陳腐化するため、scroll(capture)/resize で再計算する。座標が変わらないとき
  // （ポップオーバー自身の内部スクロール等）は再レンダーしない。rAF で間引く。
  useEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    let raf = 0;
    const apply = () => {
      const next = computeStyle();
      setStyle((prev) => {
        if (
          prev &&
          next &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.right === next.right &&
          prev.bottom === next.bottom
        ) {
          return prev;
        }
        return next;
      });
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply();
      });
    };
    apply();
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [open, computeStyle]);

  // 外側クリック / Escape で閉じる。portal 先（popoverRef）も「内側」扱いする
  // dual-ref 判定にしないと、ポータル化したメニュー内クリックが外側と誤判定され
  // 即座に閉じてしまう。
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: globalThis.MouseEvent) {
      const target = e.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        onCloseRef.current();
      }
    }
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, triggerRef]);

  return { popoverRef, style };
}
