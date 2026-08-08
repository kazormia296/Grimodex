export const ZEN_BACKGROUND_DEFAULT_SHADER_PROPS: Record<
  string,
  Record<string, string | number | boolean>
> = {
  dithering: { size: 6.5 },
  "grain-gradient": { softness: 0.3 },
  "dot-orbit": {
    size: 0.29,
    stepsPerColor: 1,
    spreading: 0.73,
    sizeRange: 0.61,
  },
  "god-rays": { density: 0.51, spotty: 0.24, midSize: 0 },
  "halftone-cmyk": {
    size: 0.27,
    contrast: 1.48,
    softness: 0.59,
    grainMixer: 0.34,
    grainOverlay: 0.3,
    floodC: -0.24,
  },
  "simplex-noise": { stepsPerColor: 8, softness: 1 },
  "pulsing-border": { roundness: 0.62, thickness: 0.49, marginLeft: 0.46 },
  spiral: {
    density: 0.55,
    noise: 0.42,
    strokeCap: 0.57,
    strokeTaper: 0.35,
    distortion: 0.28,
  },
  "liquid-metal": {
    shiftRed: 0.79,
    repetition: 2,
    contour: 0.6,
    softness: 0,
    shape: "circle",
    shiftBlue: 0.52,
  },
  "fluted-glass": { shadows: 1 },
  "gem-smoke": {
    shape: "circle",
    innerDistortion: 0.5,
    outerDistortion: 0.41,
    innerGlow: 0.7,
  },
};

/**
 * Canonical first-run background. These values mirror the user's validated
 * local configuration; persistence, parser fallbacks, and controls all import
 * this object so a reset or fresh Web Editor workspace renders identically.
 */
export const ZEN_BACKGROUND_DEFAULTS = {
  enabled: true,
  shader: "liquid-metal",
  paletteMode: "theme",
  opacity: 100,
  legacySpeed: 0.42,
  speedPercent: 3,
  speedMode: "fast",
  scale: 1.7,
  rotation: 170,
  offsetX: 0.25,
  offsetY: 0.05,
  colors: ["#111827", "#111827", "#111827", "#111827"] as [
    string,
    string,
    string,
    string,
  ],
  colorBack: "#111827",
  grainShape: "wave",
  dither: { enabled: false, strength: 0, size: 3, levels: 4 },
  halftone: {
    enabled: false,
    strength: 0.1,
    size: 18,
    angle: 27,
    softness: 1,
  },
  contrastGuard: { mode: "auto", strength: 0.1, toolMix: 0.75 },
  glass: {
    enabled: true,
    blur: 22,
    refraction: 24,
    saturation: 1,
    shine: 1,
  },
} as const;
