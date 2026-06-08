import { STRIPE_GAP_PX } from "./layoutConstants";
import { SplitterChrome } from "./splitter/SplitterChrome";
import { SplitterHandle } from "./splitter/SplitterHandle";
import { useSplitterKeyboard } from "./splitter/useSplitterKeyboard";

interface SplitterProps {
  /**
   * Drag axis: `horizontal` = vertical bar (col-resize, delta from clientX),
   * `vertical` = horizontal bar (row-resize, delta from clientY).
   */
  orientation: "horizontal" | "vertical";
  disabled?: boolean;
  onDrag: (deltaPx: number) => void;
  onDragEnd?: () => void;
  className?: string;
  /**
   * Cross-axis thickness in px. In the card layout (D案) this band IS the
   * inter-panel gap — it draws no line, only carries the resize cursor.
   */
  thickness?: number;
  /**
   * keyboard リサイズを有効化する (focusable separator + 矢印キー + aria-value*)。
   * 有効時は aria-value* / ariaLabel を渡すこと (focusable separator は
   * aria-valuenow が必須)。region splitter で使用。slot splitter は未指定。
   */
  keyboardResize?: boolean;
  ariaLabel?: string;
  ariaValueNow?: number;
  ariaValueMin?: number;
  ariaValueMax?: number;
  ariaValueText?: string;
  /** 矢印キー1回あたりの delta px (既定 16)。 */
  keyboardStep?: number;
}

/**
 * Draggable divider between regions or slots.
 * deltaPx is positive when dragging toward increasing the preceding pane size.
 */
export function Splitter({
  orientation,
  disabled = false,
  onDrag,
  onDragEnd,
  className,
  thickness = STRIPE_GAP_PX,
  keyboardResize = false,
  ariaLabel,
  ariaValueNow,
  ariaValueMin,
  ariaValueMax,
  ariaValueText,
  keyboardStep,
}: SplitterProps) {
  const handleKeyDown = useSplitterKeyboard({
    orientation,
    disabled,
    step: keyboardStep,
    onDrag,
    onDragEnd,
  });

  const interactive = keyboardResize
    ? {
        // layoutLocked 時は tab 到達不可にする。
        tabIndex: disabled ? -1 : 0,
        onKeyDown: handleKeyDown,
        ariaLabel,
        valueNow: ariaValueNow,
        valueMin: ariaValueMin,
        valueMax: ariaValueMax,
        valueText: ariaValueText,
      }
    : undefined;

  return (
    <SplitterHandle
      orientation={orientation}
      disabled={disabled}
      onDrag={onDrag}
      onDragEnd={onDragEnd}
    >
      <SplitterChrome
        orientation={orientation}
        disabled={disabled}
        className={className}
        thickness={thickness}
        interactive={interactive}
      />
    </SplitterHandle>
  );
}
