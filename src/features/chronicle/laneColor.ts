/**
 * Deterministic per-entity lane color helpers.
 *
 * The app has no per-codex-entry color, so we derive a stable hue from the id
 * via FNV-1a hashing. Pure functions only — deterministic, no Date/Math.random/IO.
 */

const NEUTRAL_COLOR = "oklch(0.62 0 0)";

/** Deterministic FNV-1a hash (32-bit, unsigned). */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h = h ^ c;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Stable lane color for an entity id (neutral gray when absent). */
export function laneColorFor(id: string | null | undefined): string {
  if (!id) return NEUTRAL_COLOR;
  const hue = hash(id) % 360;
  return `oklch(0.58 0.13 ${hue})`;
}

/** color-mix tint toward white by `pct` percent of the base color. */
export function tintColor(color: string, pct: number): string {
  return `color-mix(in oklch, ${color} ${pct}%, #ffffff)`;
}

/** color-mix ring toward transparent by `pct` percent of the base color. */
export function ringColor(color: string, pct: number): string {
  return `color-mix(in oklch, ${color} ${pct}%, transparent)`;
}
