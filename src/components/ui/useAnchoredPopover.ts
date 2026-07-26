import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";

/** トリガからポップオーバーを開く向き。 */
export type PopoverPlacement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "left-start";

interface PopoverLayout {
  /** createPortal する本体の style に展開する固定配置座標。 */
  style: CSSProperties;
  /** ビューポートに収まる本体の最大高さ(px)。 */
  maxHeight: number;
}

interface UseAnchoredPopoverResult {
  /** portal するポップオーバー本体に付ける ref（外側クリック判定に使う）。 */
  popoverRef: RefObject<HTMLDivElement | null>;
  /** open の間だけ非 null。createPortal する本体の style に展開する。 */
  style: CSSProperties | null;
  /**
   * open の間だけ非 null。ビューポートに収まる本体の最大高さ(px)。
   * 内部スクロールしたい本体(モデルピッカー等)に明示的に渡す。
   * `style` に混ぜないのは、呼び出し側が独自に持つ `max-h-*` クラスを
   * インライン style が上書きしてしまうのを避けるため。
   */
  maxHeight: number | null;
}

/**
 * トリガ基準で `document.body` に portal する固定配置ポップオーバーのための
 * 位置計算 + 外側クリック/Escape での閉じ処理をまとめる hook。
 *
 * `backdrop-filter` を持つ祖先は CSS 仕様上
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
  options?: {
    /**
     * 外側クリック判定を拡張する述語。true を返した target は「内側」扱いで
     * 閉じない。ポップオーバー内に Radix Popover 等の「body へ portal される
     * 子ポップオーバー」を持つ場合、その content は popoverRef の外にあるため
     * これで守る（例: `[data-radix-popper-content-wrapper]` 内のクリック）。
     */
    isInsideClick?: (target: Node) => boolean;
  },
): UseAnchoredPopoverResult {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<PopoverLayout | null>(null);

  // onClose は inline arrow で毎レンダー変わりがちなので ref 経由で読み、
  // リスナの再購読を open 遷移時だけに抑える。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const isInsideClickRef = useRef(options?.isInsideClick);
  isInsideClickRef.current = options?.isInsideClick;

  // トリガ矩形 + placement から fixed 座標 + 可用高さを計算する。
  const computeLayout = useCallback((): PopoverLayout | null => {
    const el = triggerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const margin = 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // maxHeight = ビューポートに収まる最大高さ。これを超えるとポップオーバー
    // 本体が画面外にはみ出す（特にモデル数の多いピッカー）。配置方向ごとに
    // 利用可能な空間へ clamp し、本体側で内部スクロールさせる。
    const style: CSSProperties = { position: "fixed" };
    let maxHeight: number;
    if (placement === "top-start") {
      // 上向き: ポップオーバー下端をトリガ上端に合わせる（高さ不要で配置可能）。
      style.bottom = vh - r.top + margin;
      style.left = Math.max(margin, r.left);
      maxHeight = Math.max(120, r.top - margin * 2);
    } else if (placement === "bottom-end") {
      // 右揃え: トリガ右端にポップオーバー右端を合わせる。
      style.top = r.bottom + margin;
      style.right = Math.max(margin, vw - r.right);
      maxHeight = Math.max(120, vh - r.bottom - margin * 2);
    } else if (placement === "left-start") {
      // 左向き: ポップオーバー右端をトリガ左端に合わせ、上端をトリガ上端へ揃える。
      // 縦書き(vertical-rl)の Beat ヘッダーでメニューを block-end(左)側へ開くのに使う。
      style.top = Math.max(margin, r.top);
      style.right = Math.max(margin, vw - r.left + margin);
      maxHeight = Math.max(120, vh - r.top - margin * 2);
    } else {
      style.top = r.bottom + margin;
      style.left = Math.max(margin, r.left);
      maxHeight = Math.max(120, vh - r.bottom - margin * 2);
    }
    return { style, maxHeight };
  }, [placement, triggerRef]);

  // 開いている間はトリガ矩形に追従して配置する。SessionsPanel の overflow-y-auto
  // 内メニューのようにトリガがスクロールで動くケースや window resize で fixed 座標
  // が陳腐化するため、scroll(capture)/resize で再計算する。座標が変わらないとき
  // （ポップオーバー自身の内部スクロール等）は再レンダーしない。rAF で間引く。
  useEffect(() => {
    if (!open) {
      setLayout(null);
      return;
    }
    let raf = 0;
    const apply = () => {
      const next = computeLayout();
      setLayout((prev) => {
        if (
          prev &&
          next &&
          prev.style.top === next.style.top &&
          prev.style.left === next.style.left &&
          prev.style.right === next.style.right &&
          prev.style.bottom === next.style.bottom &&
          prev.maxHeight === next.maxHeight
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
  }, [open, computeLayout]);

  // 外側クリック / Escape で閉じる。portal 先（popoverRef）も「内側」扱いする
  // dual-ref 判定にしないと、ポータル化したメニュー内クリックが外側と誤判定され
  // 即座に閉じてしまう。
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: globalThis.MouseEvent) {
      const target = e.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target) &&
        !isInsideClickRef.current?.(target)
      ) {
        onCloseRef.current();
      }
    }
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      // ネストした子ポップオーバー（Radix 等）にフォーカスがあるときの Esc は
      // 子レイヤーだけを閉じさせ、こちらは巻き込まれない。
      const target = e.target as Node | null;
      if (target && isInsideClickRef.current?.(target)) return;
      onCloseRef.current();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, triggerRef]);

  return {
    popoverRef,
    style: layout?.style ?? null,
    maxHeight: layout?.maxHeight ?? null,
  };
}
