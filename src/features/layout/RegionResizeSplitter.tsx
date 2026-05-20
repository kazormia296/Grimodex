import { useCallback } from "react";
import { Splitter } from "./Splitter";
import { useLayoutStore } from "./layoutStore";
import type { RegionId } from "./layoutTypes";

interface RegionResizeSplitterProps {
  region: RegionId;
}

export function RegionResizeSplitter({ region }: RegionResizeSplitterProps) {
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const nudgeRegionSize = useLayoutStore((s) => s.nudgeRegionSize);
  const finalizeLayoutResize = useLayoutStore((s) => s.finalizeLayoutResize);

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

  return (
    <Splitter
      orientation={orientation}
      disabled={layoutLocked}
      onDrag={handleDrag}
      onDragEnd={finalizeLayoutResize}
    />
  );
}
