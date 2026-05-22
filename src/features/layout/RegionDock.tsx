import { memo } from "react";
import { STRIPE_SIZE } from "./layoutConstants";
import { sideContentZoneHeight } from "./layoutMetrics";
import { RegionStripe } from "./RegionStripe";
import { RegionContent } from "./RegionContent";
import { useLayoutStore } from "./layoutStore";
import type { RegionId } from "./layoutTypes";
import type { RegionSegment } from "./useRegionSegments";

interface SideRegionStripeColumnProps {
  region: "left" | "right";
  stripeOrientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
  /** Bottom grid row height (stripe + optional content). */
  bottomRowInset: number;
}

/** Side stripe column spanning both grid rows (icons align with upper content zone). */
export const SideRegionStripeColumn = memo(function SideRegionStripeColumn({
  region,
  stripeOrientation,
  segments,
  bottomRowInset,
}: SideRegionStripeColumnProps) {
  const contentZoneHeight = sideContentZoneHeight(bottomRowInset);

  return (
    <div
      data-region-stripe-column={region}
      className="flex h-full min-h-0 w-full flex-col"
    >
      <div
        className="flex min-h-0 shrink-0 flex-col"
        style={{ height: contentZoneHeight }}
      >
        <RegionStripe
          region={region}
          orientation={stripeOrientation}
          segments={segments}
        />
      </div>
      {bottomRowInset > 0 && <div className="min-h-0 flex-1" aria-hidden />}
    </div>
  );
});

interface RegionDockProps {
  region: RegionId;
  stripeOrientation: "vertical" | "horizontal";
  contentOrientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
}

function BottomRegionDock({
  segments,
  stripeOrientation,
  contentOrientation,
}: Omit<RegionDockProps, "region">) {
  const regionSize = useLayoutStore((s) => s.layout.regions.bottom.size);
  const hasOpen = useLayoutStore((s) =>
    s.layout.regions.bottom.slots.some((slot) => slot.activePanel !== null),
  );

  const contentSize = hasOpen ? regionSize : 0;

  return (
    <div
      data-region-dock="bottom"
      className="flex min-h-0 w-full flex-1 flex-col"
    >
      {contentSize > 0 && (
        <div
          style={{ height: contentSize, flexShrink: 0 }}
          className="flex min-h-0 w-full min-w-0 flex-col"
        >
          <RegionContent region="bottom" orientation={contentOrientation} />
        </div>
      )}

      <div
        style={{ height: STRIPE_SIZE, flexShrink: 0 }}
        className="w-full min-h-0 shrink-0"
      >
        <RegionStripe
          region="bottom"
          orientation={stripeOrientation}
          segments={segments}
        />
      </div>
    </div>
  );
}

export const RegionDock = memo(function RegionDock({
  region,
  stripeOrientation,
  contentOrientation,
  segments,
}: RegionDockProps) {
  const hasPanels = segments.some((s) => s.panels.length > 0);
  if (!hasPanels || region !== "bottom") return null;

  return (
    <BottomRegionDock
      stripeOrientation={stripeOrientation}
      contentOrientation={contentOrientation}
      segments={segments}
    />
  );
});
