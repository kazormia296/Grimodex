import { memo } from "react";
import { HORIZONTAL_STRIPE_SIZE } from "./layoutConstants";
import { AnimatedRegionChrome } from "./AnimatedRegionChrome";
import { RegionStripe } from "./RegionStripe";
import { RegionContent } from "./RegionContent";
import { useLayoutStore } from "./layoutStore";
import type { RegionId } from "./layoutTypes";
import type { RegionSegment } from "./useRegionSegments";

interface SideRegionStripeColumnProps {
  region: "left" | "right";
  stripeOrientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
  /** stripe 下端に確保するコーナートグル余白(px)。side stripe が bottom
   *  角を取るときだけ使う（trailing CollapsedCluster のアイコンが
   *  BottomCornerToggle と重ならないように）。 */
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
  dormant?: boolean;
  /** bottom stripe の左右端に確保するコーナートグル用の余白(px)。
   *  content には適用しない（alignment 維持のため）。 */
  stripeReserveStartPx?: number;
  stripeReserveEndPx?: number;
}

function BottomRegionDock({
  segments,
  stripeOrientation,
  contentOrientation,
  dormant = false,
  stripeReserveStartPx = 0,
  stripeReserveEndPx = 0,
}: Omit<RegionDockProps, "region">) {
  const regionSize = useLayoutStore((s) => s.layout.regions.bottom.size);
  const hasOpen = useLayoutStore((s) =>
    s.layout.regions.bottom.slots.some((slot) => slot.activePanel !== null),
  );
  // 視覚 zoom の対象が bottom region 内パネルのとき、content の固定高さを
  // 解いて grid cell（1fr 化された bottom 行）全体まで伸ばし、icon stripe を
  // 0 高さ + 不可視にする（unmount はしない）。bottom は stripe が grid
  // セル内側に同居する唯一の region なのでここで処理する。
  const bottomZoomed = useLayoutStore((s) => {
    const id = s.maximizedPanelId;
    if (id === null || id === "editor") return false;
    return s.layout.regions.bottom.slots.some(
      (slot) => slot.activePanel === id,
    );
  });
  return (
    <div
      data-region-dock="bottom"
      className="flex min-h-0 w-full flex-1 flex-col"
      // content と icon stripe の間の stripe-gap。bottomDockPx が同じ
      // 値をドック高さに加算しているので overflow しない。
      style={{
        gap: !bottomZoomed ? "var(--gx-stripe-gap)" : undefined,
      }}
    >
      <AnimatedRegionChrome
        region="bottom"
        open={hasOpen}
        style={
          bottomZoomed
            ? { flexGrow: 1, minHeight: 0 }
            : { height: regionSize, flexShrink: 0 }
        }
        className="flex min-h-0 w-full min-w-0 flex-col"
      >
        <RegionContent
          region="bottom"
          orientation={contentOrientation}
          dormant={dormant}
        />
      </AnimatedRegionChrome>

      <div
        style={
          bottomZoomed
            ? { height: 0, flexShrink: 0, visibility: "hidden" }
            : { height: HORIZONTAL_STRIPE_SIZE, flexShrink: 0 }
        }
        aria-hidden={bottomZoomed || undefined}
        inert={bottomZoomed || undefined}
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
  dormant = false,
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
      dormant={dormant}
      stripeReserveStartPx={stripeReserveStartPx}
      stripeReserveEndPx={stripeReserveEndPx}
    />
  );
});
