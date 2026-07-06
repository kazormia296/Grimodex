import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";
import {
  DURATIONS,
  EASINGS,
  VARIANTS,
  useReducedMotion,
} from "@/lib/animation";
import {
  useAnchoredPopover,
  type PopoverPlacement,
} from "@/components/ui/useAnchoredPopover";

interface AnchoredPopoverShellProps {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  placement?: PopoverPlacement;
  className?: string;
  children: ReactNode;
  /** useAnchoredPopover の isInsideClick 拡張（ネストした Radix Popover 用）。 */
  isInsideClick?: (target: Node) => boolean;
  testId?: string;
}

/**
 * シーンメタ編集ポップオーバーの共通シェル。
 * body へ portal + fixed 配置（glass/stacking context 罠回避）+
 * VARIANTS.popover の開きアニメ。チップ行(1h)とシーン詳細パネル(1f)の
 * 両方から同じピッカーを開くための土台。
 */
export function AnchoredPopoverShell({
  open,
  onClose,
  triggerRef,
  ariaLabel,
  placement = "bottom-start",
  className,
  children,
  isInsideClick,
  testId,
}: AnchoredPopoverShellProps) {
  const reducedMotion = useReducedMotion();
  const { popoverRef, style } = useAnchoredPopover(
    triggerRef,
    open,
    onClose,
    placement,
    { isInsideClick },
  );
  if (!open || !style) return null;
  return createPortal(
    <motion.div
      ref={popoverRef}
      role="dialog"
      aria-label={ariaLabel}
      initial={reducedMotion ? false : VARIANTS.popover.initial}
      animate={VARIANTS.popover.animate}
      transition={{ duration: DURATIONS.fast, ease: EASINGS.easeOut }}
      style={style}
      className={cn(
        "z-50 overflow-hidden rounded-lg border border-border bg-popover shadow-lg",
        className,
      )}
      data-testid={testId}
    >
      {children}
    </motion.div>,
    document.body,
  );
}
