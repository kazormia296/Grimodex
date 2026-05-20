import { STRIPE_SIZE } from "./layoutConstants";
import { RegionStripe } from "./RegionStripe";
import { RegionContent } from "./RegionContent";
import { Splitter } from "./Splitter";
import { useLayoutStore } from "./layoutStore";
import type { RegionId } from "./layoutTypes";
import type { RegionSegment } from "./useRegionSegments";
import { getRegionContentSize } from "./useRegionSegments";
import { cn } from "@/lib/utils";

interface RegionDockProps {
  region: RegionId;
  stripeOrientation: "vertical" | "horizontal";
  contentOrientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
  /** Which side of the editor this region sits on (for splitter placement) */
  edge: "before-editor" | "after-editor";
}

export function RegionDock({
  region,
  stripeOrientation,
  contentOrientation,
  segments,
  edge,
}: RegionDockProps) {
  const layout = useLayoutStore((s) => s.layout);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const setRegionSize = useLayoutStore((s) => s.setRegionSize);

  const hasPanels = segments.some((s) => s.panels.length > 0);
  if (!hasPanels) return null;

  const contentSize = getRegionContentSize(region, layout);
  const stripeAxis = stripeOrientation === "vertical" ? "width" : "height";
  const totalSize = STRIPE_SIZE + contentSize;

  const handleRegionResize = (delta: number) => {
    const sign = edge === "before-editor" ? 1 : -1;
    const adjusted =
      region === "bottom" ? delta : region === "left" ? delta : -delta;
    setRegionSize(region, layout.regions[region].size + adjusted * sign);
  };

  return (
    <>
      {edge === "after-editor" && contentSize > 0 && (
        <Splitter
          orientation={
            region === "bottom" ? "horizontal" : "vertical"
          }
          disabled={layoutLocked}
          onDrag={handleRegionResize}
        />
      )}

      <div
        data-region-dock={region}
        style={{
          [stripeAxis === "width" ? "width" : "height"]: totalSize,
          flexShrink: 0,
        }}
        className={cn(
          "flex min-h-0 min-w-0 overflow-hidden",
          region === "bottom" ? "flex-col" : "flex-row",
        )}
      >
        {(region === "left" || region === "bottom") && (
          <div
            style={{
              [stripeAxis === "width" ? "width" : "height"]: STRIPE_SIZE,
              flexShrink: 0,
            }}
          >
            <RegionStripe
              region={region}
              orientation={stripeOrientation}
              segments={segments}
            />
          </div>
        )}

        {contentSize > 0 && (
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <RegionContent
              region={region}
              orientation={contentOrientation}
            />
          </div>
        )}

        {region === "right" && (
          <div
            style={{
              width: STRIPE_SIZE,
              flexShrink: 0,
            }}
          >
            <RegionStripe
              region={region}
              orientation={stripeOrientation}
              segments={segments}
            />
          </div>
        )}
      </div>

      {edge === "before-editor" && contentSize > 0 && (
        <Splitter
          orientation={
            region === "bottom" ? "horizontal" : "vertical"
          }
          disabled={layoutLocked}
          onDrag={handleRegionResize}
        />
      )}
    </>
  );
}
