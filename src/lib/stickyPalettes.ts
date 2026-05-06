/**
 * Sticky color palettes — code-defined sets of paper colors that a Sticky
 * can pick from. Sticky stores `paletteId` + `colorSlot`, the resolver here
 * converts that to a hex.
 *
 * Phase 1: only one palette ("post-it-playful"), all stickies use it. Future
 * phases can add user-defined palettes without touching this file's shape.
 */

export interface StickyPaletteColor {
  /** Hex (#RRGGBB). Used as the bg-color of `.sticky-paper` in light mode. */
  hex: string;
  /** Display name shown in the color submenu. */
  label: string;
}

export interface StickyPalette {
  id: string;
  label: string;
  colors: StickyPaletteColor[];
}

/**
 * Post-It marketing palette: 6 Playful Primaries + 4 Supernova Neons (the
 * Iris Infusion duplicate across the two source sets is intentionally
 * collapsed to a single slot).
 */
export const POST_IT_PLAYFUL: StickyPalette = {
  id: "post-it-playful",
  label: "Post-It Playful",
  colors: [
    { hex: "#FFD93D", label: "Sunnyside" }, // 0
    { hex: "#F58220", label: "Vital Orange" }, // 1
    { hex: "#EE3D8B", label: "Tropical Pink" }, // 2
    { hex: "#6FBE44", label: "Lucky Green" }, // 3
    { hex: "#2A8FBD", label: "Blue Paradise" }, // 4
    { hex: "#7B5FA8", label: "Iris Infusion" }, // 5
    { hex: "#DC3545", label: "Candy Apple Red" }, // 6
    { hex: "#C8E33C", label: "Acid Lime" }, // 7
    { hex: "#2DC9CC", label: "Aqua Splash" }, // 8
    { hex: "#FF6B5B", label: "Guava" }, // 9
  ],
};

export const PALETTES: Record<string, StickyPalette> = {
  [POST_IT_PLAYFUL.id]: POST_IT_PLAYFUL,
};

export const DEFAULT_PALETTE_ID = POST_IT_PLAYFUL.id;
export const DEFAULT_COLOR_SLOT = 0;

/** Returns the palette for an id, falling back to the default. */
export function getPalette(paletteId: string): StickyPalette {
  return PALETTES[paletteId] ?? PALETTES[DEFAULT_PALETTE_ID];
}

/**
 * Resolve a (paletteId, slot) pair to a hex. Falls back to slot 0 of the
 * default palette when either is invalid; never throws.
 */
export function resolveStickyHex(paletteId: string, slot: number): string {
  const palette = getPalette(paletteId);
  return palette.colors[slot]?.hex ?? palette.colors[0].hex;
}
