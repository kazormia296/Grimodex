import { memo } from "react";
import { STRIPE_SIZE } from "./layoutConstants";
import { RegionStripe } from "./RegionStripe";
import { RegionContent } from "./RegionContent";
import { useLayoutStore } from "./layoutStore";
import { useMochiLayout } from "./mochiLayout";
import type { RegionId } from "./layoutTypes";
import type { RegionSegment } from "./useRegionSegments";

interface SideRegionStripeColumnProps {
  region: "left" | "right";
  stripeOrientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
  /** stripe 下端に確保するコーナートグル用の余白(px)。 */
  reserveEndPx?: number;
}

/**
 * Side stripe column — fills its whole grid area. When the side region
 * owns the bottom corner, lstripe/rstripe spans the bottom row too, so
 * the stripe extends all the way down into the corner.
 */
export const SideRegionStripeColumn = memo(function SideRegionStripeColumn({
  region,
  stripeOrientation,
  segments,
  reserveEndPx = 0,
}: SideRegionStripeColumnProps) {
  return (
    <div
      data-region-stripe-column={region}
      className="flex h-full min-h-0 w-full flex-col"
    >
      <RegionStripe
        region={region}
        orientation={stripeOrientation}
        segments={segments}
        reserveEndPx={reserveEndPx}
      />
    </div>
  );
});

interface RegionDockProps {
  region: RegionId;
  stripeOrientation: "vertical" | "horizontal";
  contentOrientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
  /** bottom stripe の左右端に確保するコーナートグル用の余白(px)。 */
  stripeReserveStartPx?: number;
  stripeReserveEndPx?: number;
}

function BottomRegionDock({
  segments,
  stripeOrientation,
  contentOrientation,
  stripeReserveStartPx = 0,
  stripeReserveEndPx = 0,
}: Omit<RegionDockProps, "region">) {
  const regionSize = useLayoutStore((s) => s.layout.regions.bottom.size);
  const hasOpen = useLayoutStore((s) =>
    s.layout.regions.bottom.slots.some((slot) => slot.activePanel !== null),
  );
  const mochi = useMochiLayout();

  const contentSize = hasOpen ? regionSize : 0;

  return (
    <div
      data-region-dock="bottom"
      className="flex min-h-0 w-full flex-1 flex-col"
      // content と icon stripe の間の stripe-gap。bottomDockPx が同じ
      // 値をドック高さに加算しているので overflow しない。
      style={{ gap: mochi ? "var(--gx-stripe-gap)" : undefined }}
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
          reserveStartPx={stripeReserveStartPx}
          reserveEndPx={stripeReserveEndPx}
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
  stripeReserveStartPx = 0,
  stripeReserveEndPx = 0,
}: RegionDockProps) {
  const hasPanels = segments.some((s) => s.panels.length > 0);
  if (!hasPanels || region !== "bottom") return null;

  return (
    <BottomRegionDock
      stripeOrientation={stripeOrientation}
      contentOrientation={contentOrientation}
      segments={segments}
      stripeReserveStartPx={stripeReserveStartPx}
      stripeReserveEndPx={stripeReserveEndPx}
    />
  );
});
