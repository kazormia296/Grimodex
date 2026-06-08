import { cn } from "@/lib/utils";
import { LEGACY_SPLITTER_PX, STRIPE_GAP_PX } from "../layoutConstants";
import { useCardLayout } from "../cardLayout";

/**
 * keyboard-resizable な separator にするための任意プロパティ。
 * 指定すると separator が focusable になり、aria-value* と focus ring が付く。
 * (RegionResizeSplitter から Splitter 経由で渡される。slot splitter は未指定。)
 */
export interface SplitterInteractiveProps {
  tabIndex: number;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  ariaLabel?: string;
  valueNow?: number;
  valueMin?: number;
  valueMax?: number;
  valueText?: string;
}

export interface SplitterChromeProps {
  orientation: "horizontal" | "vertical";
  disabled?: boolean;
  className?: string;
  thickness?: number;
  style?: React.CSSProperties;
  interactive?: SplitterInteractiveProps;
}

/** Visual chrome for layout splitters (card gap band or legacy line). */
export function SplitterChrome({
  orientation,
  disabled = false,
  className,
  thickness = STRIPE_GAP_PX,
  style,
  interactive,
}: SplitterChromeProps) {
  const isColumnDivider = orientation === "horizontal";
  const cardLayout = useCardLayout();
  const effectiveThickness = cardLayout ? thickness : LEGACY_SPLITTER_PX;

  return (
    <div
      role="separator"
      aria-orientation={isColumnDivider ? "vertical" : "horizontal"}
      data-layout-splitter={orientation}
      tabIndex={interactive?.tabIndex}
      onKeyDown={interactive?.onKeyDown}
      aria-label={interactive?.ariaLabel}
      aria-valuenow={interactive?.valueNow}
      aria-valuemin={interactive?.valueMin}
      aria-valuemax={interactive?.valueMax}
      aria-valuetext={interactive?.valueText}
      style={{
        ...(isColumnDivider
          ? { width: effectiveThickness, height: "100%" }
          : { width: "100%", height: effectiveThickness }),
        ...style,
      }}
      className={cn(
        "relative z-20 shrink-0 touch-none select-none transition-colors",
        cardLayout
          ? "hover:bg-foreground/[0.06] active:bg-foreground/10"
          : "bg-border/80 hover:bg-primary/60 active:bg-primary/80",
        disabled && "pointer-events-none",
        !cardLayout && disabled && "opacity-30",
        isColumnDivider ? "cursor-col-resize" : "cursor-row-resize",
        interactive &&
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
    />
  );
}
