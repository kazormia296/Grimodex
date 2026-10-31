import {
  CSS_EASINGS,
  DURATIONS,
  EASINGS,
  OVERLAY_DURATIONS,
} from "@/lib/animation";

export const PRESET_ANIMATION_DEBOUNCE_MS = 300;

/**
 * `open` uses a generous negative inset during interpolation because Framer
 * Motion can't interpolate between `inset()` and the `none` keyword and
 * silently substitutes `inset(0 0 0 0)` — which clips inter-panel
 * `box-shadow` to the region border-box and reveals raw canvas in the gaps.
 * AnimatedRegionChrome clears the clip to `none` with transitionEnd once the
 * enter animation settles; a permanent clip-path would become a Backdrop Root
 * and isolate descendant Glass from the ambient shader behind the region.
 */
const REGION_OPEN_CLIP = "inset(-200px)";

export const REGION_CLIP_PATH = {
  left: { closed: "inset(0 100% 0 0)", open: REGION_OPEN_CLIP },
  right: { closed: "inset(0 0% 0 100%)", open: REGION_OPEN_CLIP },
  bottom: { closed: "inset(100% 0 0 0)", open: REGION_OPEN_CLIP },
  center: { closed: "inset(0 0 100% 0)", open: REGION_OPEN_CLIP },
} as const;

export type RegionChromeId = keyof typeof REGION_CLIP_PATH;

export const REGION_TRANSFORM_ORIGIN: Record<RegionChromeId, string> = {
  left: "left center",
  right: "right center",
  bottom: "bottom center",
  center: "top center",
};

export function chromeEnterTransition(reduced: boolean) {
  return reduced
    ? { duration: 0 }
    : { duration: DURATIONS.normal, ease: EASINGS.easeOut };
}

export function chromeExitTransition(reduced: boolean) {
  return reduced
    ? { duration: 0 }
    : { duration: DURATIONS.fast, ease: EASINGS.easeOut };
}

export function presetCrossfadeTransition(reduced: boolean) {
  return reduced
    ? { duration: 0 }
    : { duration: DURATIONS.fast, ease: EASINGS.easeOut };
}

/**
 * オーバーレイの開閉（平らなスライド）の CSS transition。開閉で時間は同じ。
 * Reduced Motion では transition 自体を外し、静的な最終状態に置き換える。
 * visibility は閉じるときだけスライドが終わるまで遅らせる（開くときは即座に見える）。
 */
export function overlaySlideTransitions(
  reduced: boolean,
  open: boolean,
): { panel: string; layer: string } {
  if (reduced) return { panel: "none", layer: "none" };
  const ms = `${OVERLAY_DURATIONS.slide * 1000}ms`;
  return {
    panel: `transform ${ms} ${CSS_EASINGS.easeOut}`,
    layer: `visibility 0ms linear ${open ? "0ms" : ms}`,
  };
}
