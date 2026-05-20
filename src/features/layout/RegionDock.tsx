import { memo } from "react";
import { STRIPE_SIZE } from "./layoutConstants";
import { RegionStripe } from "./RegionStripe";
import { RegionContent } from "./RegionContent";
import { useLayoutStore } from "./layoutStore";
import type { RegionId } from "./layoutTypes";
import type { RegionSegment } from "./useRegionSegments";
import { cn } from "@/lib/utils";

interface RegionDockProps {
  region: RegionId;
  stripeOrientation: "vertical" | "horizontal";
  contentOrientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
}

function StripeSlot({
  region,
  stripeOrientation,
  segments,
}: {
  region: RegionId;
  stripeOrientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
}) {
  const stripeAxis = stripeOrientation === "vertical" ? "width" : "height";

  return (
    <div
      style={{
        [stripeAxis === "width" ? "width" : "height"]: STRIPE_SIZE,
        flexShrink: 0,
      }}
      className="h-full min-h-0 shrink-0"
    >
      <RegionStripe
        region={region}
        orientation={stripeOrientation}
        segments={segments}
      />
    </div>
  );
}

export const RegionDock = memo(function RegionDock({
  region,
  stripeOrientation,
  contentOrientation,
  segments,
}: RegionDockProps) {
  const regionSize = useLayoutStore((s) => s.layout.regions[region].size);
  const hasOpen = useLayoutStore((s) =>
    s.layout.regions[region].slots.some((slot) => slot.activePanel !== null),
  );

  const hasPanels = segments.some((s) => s.panels.length > 0);
  if (!hasPanels) return null;

  const contentSize = hasOpen ? regionSize : 0;
  const stripeAxis = stripeOrientation === "vertical" ? "width" : "height";
  const totalSize = STRIPE_SIZE + contentSize;

  if (region === "bottom") {
    return (
      <div
        data-region-dock={region}
        style={{ height: totalSize, flexShrink: 0 }}
        className="flex w-full min-h-0 min-w-0 flex-col overflow-hidden"
      >
        {contentSize > 0 && (
          <div
            style={{ height: contentSize, flexShrink: 0 }}
            className="flex min-h-0 w-full min-w-0 flex-col overflow-hidden"
          >
            <RegionContent region={region} orientation={contentOrientation} />
          </div>
        )}

        <StripeSlot
          region={region}
          stripeOrientation={stripeOrientation}
          segments={segments}
        />
      </div>
    );
  }

  return (
    <div
      data-region-dock={region}
      style={{
        [stripeAxis === "width" ? "width" : "height"]: totalSize,
        flexShrink: 0,
      }}
      className="flex h-full min-h-0 min-w-0 flex-row overflow-hidden"
    >
      {region === "left" && (
        <StripeSlot
          region={region}
          stripeOrientation={stripeOrientation}
          segments={segments}
        />
      )}

      {contentSize > 0 && (
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <RegionContent region={region} orientation={contentOrientation} />
        </div>
      )}

      {region === "right" && (
        <StripeSlot
          region={region}
          stripeOrientation={stripeOrientation}
          segments={segments}
        />
      )}
    </div>
  );
});
