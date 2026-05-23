import { STRIPE_GAP_PX } from "./layoutConstants";
import { SplitterChrome } from "./splitter/SplitterChrome";
import { SplitterHandle } from "./splitter/SplitterHandle";

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
}: SplitterProps) {
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
      />
    </SplitterHandle>
  );
}
