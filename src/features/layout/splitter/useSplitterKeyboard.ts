import { useCallback } from "react";

export interface SplitterKeyboardOptions {
  orientation: "horizontal" | "vertical";
  disabled?: boolean;
  /** 矢印キー1回あたりの delta px。 */
  step?: number;
  /** PageUp/PageDown 1回あたりの delta px。 */
  largeStep?: number;
  /** Home/End で送る delta px (consumer 側の clamp で min/max に張り付く)。 */
  jump?: number;
  onDrag: (deltaPx: number) => void;
  onDragEnd?: () => void;
}

const DEFAULT_STEP = 16;
const DEFAULT_LARGE_STEP = 64;
const DEFAULT_JUMP = 10000;

/**
 * レイアウト Splitter (role="separator") のキーボードリサイズ。
 *
 * SplitterHandle のポインタ delta 意味論に揃える: **正の delta は手前 (preceding)
 * のペインを拡大する**。
 * - orientation="horizontal" (縦バー / col-resize): ArrowLeft=-, ArrowRight=+
 * - orientation="vertical"   (横バー / row-resize): ArrowUp=-,   ArrowDown=+
 * - PageUp=-largeStep / PageDown=+largeStep, Home=-jump / End=+jump
 *
 * focusable な separator 要素に付与する onKeyDown ハンドラを返す。
 */
export function useSplitterKeyboard({
  orientation,
  disabled = false,
  step = DEFAULT_STEP,
  largeStep = DEFAULT_LARGE_STEP,
  jump = DEFAULT_JUMP,
  onDrag,
  onDragEnd,
}: SplitterKeyboardOptions) {
  return useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      // horizontal = 縦バー → 水平軸 (Left/Right)、vertical = 横バー → 垂直軸 (Up/Down)
      const horizontalAxis = orientation === "horizontal";

      let delta: number;
      switch (e.key) {
        case "ArrowLeft":
          if (!horizontalAxis) return;
          delta = -step;
          break;
        case "ArrowRight":
          if (!horizontalAxis) return;
          delta = step;
          break;
        case "ArrowUp":
          if (horizontalAxis) return;
          delta = -step;
          break;
        case "ArrowDown":
          if (horizontalAxis) return;
          delta = step;
          break;
        case "PageUp":
          delta = -largeStep;
          break;
        case "PageDown":
          delta = largeStep;
          break;
        case "Home":
          delta = -jump;
          break;
        case "End":
          delta = jump;
          break;
        default:
          return;
      }

      e.preventDefault();
      onDrag(delta);
      onDragEnd?.();
    },
    [disabled, orientation, step, largeStep, jump, onDrag, onDragEnd],
  );
}
