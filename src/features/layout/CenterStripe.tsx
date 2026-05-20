import { RegionStripe } from "./RegionStripe";
import type { RegionSegment } from "./useRegionSegments";

interface CenterStripeProps {
  segments: ReadonlyArray<RegionSegment>;
}

/** Horizontal stripe above center tool columns (editor column has no icons). */
export function CenterStripe({ segments }: CenterStripeProps) {
  if (segments.length === 0) return null;

  return (
    <div
      data-center-stripe
      className="w-full shrink-0 overflow-hidden border-b border-border"
      style={{ height: 32 }}
    >
      <RegionStripe region="center" orientation="horizontal" segments={segments} />
    </div>
  );
}
