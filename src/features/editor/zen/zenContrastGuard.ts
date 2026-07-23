export type ZenContrastGuardRect = [number, number, number, number];
export type ZenContrastGuardFeather = [number, number, number, number];

export interface ZenContrastGuardLayout {
  /** left, bottom, right, top in normalized WebGL coordinates. */
  rect: ZenContrastGuardRect;
  /** Per-edge outer fade widths in the same left, bottom, right, top order. */
  feather: ZenContrastGuardFeather;
}

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export const EMPTY_ZEN_CONTRAST_GUARD_LAYOUT: ZenContrastGuardLayout = {
  rect: [0, 0, 0, 0],
  feather: [0, 0, 0, 0],
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Strength 0 keeps WCAG AA; strength 1 raises the target to enhanced 7:1. */
export function contrastTargetRatio(strength: number) {
  return 4.5 + clamp(strength, 0, 1) * 2.5;
}

/**
 * Convert a visible target's bounds to the shader's bottom-left UV space.
 * Only geometry crosses the CPU/GPU boundary; background pixels never do.
 */
export function calculateZenContrastGuardLayout(
  surface: RectLike,
  target: RectLike,
  featherPx = 48,
): ZenContrastGuardLayout {
  if (surface.width <= 0 || surface.height <= 0) {
    return EMPTY_ZEN_CONTRAST_GUARD_LAYOUT;
  }

  const visibleLeft = Math.max(surface.left, target.left);
  const visibleRight = Math.min(surface.right, target.right);
  const visibleTop = Math.max(surface.top, target.top);
  const visibleBottom = Math.min(surface.bottom, target.bottom);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
    return EMPTY_ZEN_CONTRAST_GUARD_LAYOUT;
  }

  const left = clamp((visibleLeft - surface.left) / surface.width, 0, 1);
  const right = clamp((visibleRight - surface.left) / surface.width, 0, 1);
  const bottom = clamp(
    1 - (visibleBottom - surface.top) / surface.height,
    0,
    1,
  );
  const top = clamp(1 - (visibleTop - surface.top) / surface.height, 0, 1);
  const horizontalFade = featherPx / surface.width;
  const verticalFade = featherPx / surface.height;

  return {
    rect: [left, bottom, right, top],
    feather: [
      target.left > surface.left ? Math.min(horizontalFade, left) : 0,
      target.bottom < surface.bottom ? Math.min(verticalFade, bottom) : 0,
      target.right < surface.right ? Math.min(horizontalFade, 1 - right) : 0,
      target.top > surface.top ? Math.min(verticalFade, 1 - top) : 0,
    ],
  };
}
