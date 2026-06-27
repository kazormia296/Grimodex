import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import {
  useAnchoredPopover,
  type PopoverPlacement,
} from "@/components/ui/useAnchoredPopover";

/**
 * children は通常の ReactNode に加え、anchored モード時に算出される可用高さ
 * (maxHeight) を受け取る関数も渡せる。内部スクロールを自前で持つメニュー
 * (ChatModelMenu 等) に maxHeight を流すために使う。
 */
type DropdownChildren =
  | React.ReactNode
  | ((maxHeight: number | null) => React.ReactNode);

interface AnimatedDropdownProps {
  open: boolean;
  onClose: () => void;
  /** ref wrapping trigger + menu; used for click-outside detection (inline mode). */
  containerRef?: React.RefObject<HTMLElement | null>;
  /**
   * トリガ要素の ref。指定すると `document.body` へ portal して `position: fixed` で
   * アンカー配置する。`backdrop-filter` を持つ祖先（`.glass-editor-body` /
   * `.glass-chat` 等）が作る stacking context / containing block に埋もれ、さらに
   * 祖先の `overflow` でクリップされる問題を回避する。
   * 指定時は外側クリック / Escape は `useAnchoredPopover` が担うため `containerRef` は不要。
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** anchorRef 指定時の展開方向（既定 bottom-start）。 */
  placement?: PopoverPlacement;
  className?: string;
  children: DropdownChildren;
}

export function AnimatedDropdown({
  open,
  onClose,
  containerRef,
  anchorRef,
  placement = "bottom-start",
  className,
  children,
}: AnimatedDropdownProps) {
  const reduced = useReducedMotion();
  const anchored = !!anchorRef;

  // hooks は無条件に呼ぶ。anchored でないときは open=false 相当で渡し、
  // 位置計算 / リスナ登録を一切走らせない（fallbackRef は使われない）。
  const fallbackRef = useRef<HTMLElement>(null);
  const { popoverRef, style, maxHeight } = useAnchoredPopover(
    anchorRef ?? fallbackRef,
    open && anchored,
    onClose,
    placement,
  );

  // Escape: inline モードのみここで処理（anchored は useAnchoredPopover が処理）。
  useEffect(() => {
    if (!open || anchored) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, anchored, onClose]);

  // 外側クリック: inline モードかつ containerRef 指定時のみ（anchored は hook が処理）。
  useEffect(() => {
    if (!open || anchored || !containerRef) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, anchored, onClose, containerRef]);

  const isFnChildren = typeof children === "function";
  const content = isFnChildren ? children(maxHeight) : children;

  const transition = {
    duration: reduced ? 0 : DURATIONS.fast,
    ease: EASINGS.easeOut,
  };

  if (anchored) {
    // 関数 children(ChatModelMenu 等)は自前で maxHeight を扱い内部スクロールを
    // 持つので outer には触れない。素の JSX children(タイプ/POV/ケバブ等)は内部
    // スクロールを持たないため、ビューポート可用高さ(maxHeight)でクランプし、
    // 溢れたら本体をスクロールさせる(背の高いメニューが画面外に出て押せなくなる
    // のを防ぐ)。
    const anchoredStyle =
      style && !isFnChildren && maxHeight != null
        ? { ...style, maxHeight: `${maxHeight}px` }
        : style;
    return createPortal(
      <AnimatePresence>
        {open && style && (
          <motion.div
            ref={popoverRef}
            style={anchoredStyle ?? undefined}
            className={cn(className, !isFnChildren && "overflow-y-auto")}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={transition}
          >
            {content}
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn(className)}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={transition}
        >
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
