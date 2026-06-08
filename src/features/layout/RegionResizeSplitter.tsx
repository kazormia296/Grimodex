import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Splitter } from "./Splitter";
import { useLayoutStore } from "./layoutStore";
import { MIN_REGION_SIZE } from "./layoutConstants";
import type { RegionId } from "./layoutTypes";

interface RegionResizeSplitterProps {
  region: RegionId;
}

export function RegionResizeSplitter({ region }: RegionResizeSplitterProps) {
  const { t } = useTranslation();
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const nudgeRegionSize = useLayoutStore((s) => s.nudgeRegionSize);
  const finalizeLayoutResize = useLayoutStore((s) => s.finalizeLayoutResize);
  const regionSize = useLayoutStore((s) => s.layout.regions[region]?.size ?? 0);

  const handleDrag = useCallback(
    (delta: number) => {
      switch (region) {
        case "left":
          nudgeRegionSize(region, delta);
          break;
        case "right":
          // Splitter sits on the editor side; drag right shrinks the right panel.
          nudgeRegionSize(region, -delta);
          break;
        case "bottom":
          // Bottom-anchored like VS Code: drag up expands, drag down shrinks.
          // Splitter sits on the editor side (same sign convention as right).
          nudgeRegionSize(region, -delta);
          break;
      }
    },
    [nudgeRegionSize, region],
  );

  const orientation = region === "bottom" ? "vertical" : "horizontal";

  // aria-value*: valuenow = 現在の region サイズ (px)、min = 構造上の最小、
  // max = ビューポート軸長 (実際の clamp 上限はこれより小さいが、ARIA 的には
  // valuenow ≤ valuemax を満たす緩い上限で十分。正確な値は valuetext で読み上げ)。
  const roundedSize = Math.round(regionSize);
  const viewportAxis =
    typeof window === "undefined"
      ? roundedSize
      : region === "bottom"
        ? window.innerHeight
        : window.innerWidth;
  const ariaLabel = t(
    region === "left"
      ? "a11y.resizeRegionLeft"
      : region === "right"
        ? "a11y.resizeRegionRight"
        : "a11y.resizeRegionBottom",
  );

  return (
    <Splitter
      orientation={orientation}
      disabled={layoutLocked}
      onDrag={handleDrag}
      onDragEnd={finalizeLayoutResize}
      keyboardResize
      ariaLabel={ariaLabel}
      ariaValueNow={roundedSize}
      ariaValueMin={MIN_REGION_SIZE}
      ariaValueMax={Math.max(MIN_REGION_SIZE, Math.round(viewportAxis))}
      ariaValueText={`${roundedSize}px`}
    />
  );
}
