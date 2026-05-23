import type { CSSProperties } from "react";

interface StripeTrackInsetInput {
  orientation: "vertical" | "horizontal";
  insetStartPx?: number;
  insetEndPx?: number;
}

/**
 * stripe の reserveStart/End と同じ inset を content の flex トラックに適用し、
 * slot 比率配分の可用サイズを stripe と一致させる。
 */
export function stripeTrackInsetStyle({
  orientation,
  insetStartPx = 0,
  insetEndPx = 0,
}: StripeTrackInsetInput): CSSProperties | undefined {
  if (insetStartPx <= 0 && insetEndPx <= 0) return undefined;

  if (orientation === "vertical") {
    return {
      paddingTop: insetStartPx || undefined,
      paddingBottom: insetEndPx || undefined,
    };
  }

  return {
    paddingLeft: insetStartPx || undefined,
    paddingRight: insetEndPx || undefined,
  };
}
