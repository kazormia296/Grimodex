export const ZEN_SHADER_IDS = [
  "mesh-gradient",
  "grain-gradient",
  "neuro-noise",
  "warp",
  "static-mesh-gradient",
] as const;

export type ZenShaderId = (typeof ZEN_SHADER_IDS)[number];
export type ZenPaletteMode = "theme" | "custom";
export type ZenGrainShape =
  | "wave"
  | "dots"
  | "truchet"
  | "corners"
  | "ripple"
  | "blob"
  | "sphere";
export type ZenWarpShape = "checks" | "stripes" | "edge";

export interface ZenResolvedPalette {
  background: string;
  colors: [string, string, string, string];
}

export interface ZenShaderConfig {
  shader: ZenShaderId;
  paletteMode: ZenPaletteMode;
  opacity: number;
  speed: number;
  scale: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
  customColors: [string, string, string, string];
  customColorBack: string;
  mesh: {
    distortion: number;
    swirl: number;
    grainMixer: number;
    grainOverlay: number;
  };
  grain: {
    softness: number;
    intensity: number;
    noise: number;
    shape: ZenGrainShape;
  };
  neuro: {
    brightness: number;
    contrast: number;
  };
  warp: {
    proportion: number;
    softness: number;
    distortion: number;
    swirl: number;
    swirlIterations: number;
    shape: ZenWarpShape;
    shapeScale: number;
  };
  staticMesh: {
    positions: number;
    waveX: number;
    waveXShift: number;
    waveY: number;
    waveYShift: number;
    mixing: number;
    grainMixer: number;
    grainOverlay: number;
  };
  dither: {
    enabled: boolean;
    strength: number;
    size: number;
    levels: number;
  };
  halftone: {
    enabled: boolean;
    strength: number;
    size: number;
    angle: number;
    softness: number;
  };
}

export const ZEN_SHADER_DEFAULTS: ZenShaderConfig = {
  shader: "mesh-gradient",
  paletteMode: "theme",
  opacity: 10,
  speed: 0.08,
  scale: 1.15,
  rotation: 0,
  offsetX: 0,
  offsetY: 0,
  customColors: ["#8fb4d6", "#d6b5a5", "#786fa6", "#d8c47c"],
  customColorBack: "#101318",
  mesh: {
    distortion: 0.7,
    swirl: 0.25,
    grainMixer: 0,
    grainOverlay: 0,
  },
  grain: {
    softness: 0.75,
    intensity: 0.35,
    noise: 0.12,
    shape: "corners",
  },
  neuro: { brightness: 0.1, contrast: 0.35 },
  warp: {
    proportion: 0.5,
    softness: 0.8,
    distortion: 0.2,
    swirl: 0.5,
    swirlIterations: 6,
    shape: "edge",
    shapeScale: 0.4,
  },
  staticMesh: {
    positions: 35,
    waveX: 0.5,
    waveXShift: 0.25,
    waveY: 0.55,
    waveYShift: 0.65,
    mixing: 0.65,
    grainMixer: 0,
    grainOverlay: 0,
  },
  dither: { enabled: false, strength: 0.35, size: 2, levels: 6 },
  halftone: {
    enabled: false,
    strength: 0.3,
    size: 8,
    angle: 15,
    softness: 0.15,
  },
};

const GRAIN_SHAPES: readonly ZenGrainShape[] = [
  "wave",
  "dots",
  "truchet",
  "corners",
  "ripple",
  "blob",
  "sphere",
];
const WARP_SHAPES: readonly ZenWarpShape[] = ["checks", "stripes", "edge"];

function finiteNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.min(max, Math.max(min, parsed));
  return integer ? Math.round(bounded) : bounded;
}

function enumValue<T extends string>(
  raw: string | undefined,
  values: readonly T[],
  fallback: T,
): T {
  return values.includes(raw as T) ? (raw as T) : fallback;
}

function booleanValue(raw: string | undefined, fallback: boolean): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function value(
  values: Record<string, string | undefined>,
  suffix: string,
): string | undefined {
  return values[`editor.zenBackground.${suffix}`];
}

export function parseZenShaderConfig(
  values: Record<string, string | undefined>,
): ZenShaderConfig {
  const d = ZEN_SHADER_DEFAULTS;
  const unit = (suffix: string, fallback: number) =>
    finiteNumber(value(values, suffix), fallback, 0, 1);

  return {
    shader: enumValue(value(values, "shader"), ZEN_SHADER_IDS, d.shader),
    paletteMode: enumValue(
      value(values, "paletteMode"),
      ["theme", "custom"],
      d.paletteMode,
    ),
    opacity: finiteNumber(value(values, "opacity"), d.opacity, 0, 40),
    speed: finiteNumber(value(values, "speed"), d.speed, 0, 1),
    scale: finiteNumber(value(values, "scale"), d.scale, 0.25, 4),
    rotation: finiteNumber(value(values, "rotation"), d.rotation, 0, 360),
    offsetX: finiteNumber(value(values, "offsetX"), d.offsetX, -1, 1),
    offsetY: finiteNumber(value(values, "offsetY"), d.offsetY, -1, 1),
    customColors: [
      value(values, "color1") ?? d.customColors[0],
      value(values, "color2") ?? d.customColors[1],
      value(values, "color3") ?? d.customColors[2],
      value(values, "color4") ?? d.customColors[3],
    ],
    customColorBack:
      value(values, "colorBack") ?? ZEN_SHADER_DEFAULTS.customColorBack,
    mesh: {
      distortion: unit("mesh.distortion", d.mesh.distortion),
      swirl: unit("mesh.swirl", d.mesh.swirl),
      grainMixer: unit("mesh.grainMixer", d.mesh.grainMixer),
      grainOverlay: unit("mesh.grainOverlay", d.mesh.grainOverlay),
    },
    grain: {
      softness: unit("grain.softness", d.grain.softness),
      intensity: unit("grain.intensity", d.grain.intensity),
      noise: unit("grain.noise", d.grain.noise),
      shape: enumValue(
        value(values, "grain.shape"),
        GRAIN_SHAPES,
        d.grain.shape,
      ),
    },
    neuro: {
      brightness: unit("neuro.brightness", d.neuro.brightness),
      contrast: unit("neuro.contrast", d.neuro.contrast),
    },
    warp: {
      proportion: unit("warp.proportion", d.warp.proportion),
      softness: unit("warp.softness", d.warp.softness),
      distortion: unit("warp.distortion", d.warp.distortion),
      swirl: unit("warp.swirl", d.warp.swirl),
      swirlIterations: finiteNumber(
        value(values, "warp.swirlIterations"),
        d.warp.swirlIterations,
        0,
        20,
        true,
      ),
      shape: enumValue(value(values, "warp.shape"), WARP_SHAPES, d.warp.shape),
      shapeScale: unit("warp.shapeScale", d.warp.shapeScale),
    },
    staticMesh: {
      positions: finiteNumber(
        value(values, "staticMesh.positions"),
        d.staticMesh.positions,
        0,
        100,
        true,
      ),
      waveX: unit("staticMesh.waveX", d.staticMesh.waveX),
      waveXShift: unit("staticMesh.waveXShift", d.staticMesh.waveXShift),
      waveY: unit("staticMesh.waveY", d.staticMesh.waveY),
      waveYShift: unit("staticMesh.waveYShift", d.staticMesh.waveYShift),
      mixing: unit("staticMesh.mixing", d.staticMesh.mixing),
      grainMixer: unit("staticMesh.grainMixer", d.staticMesh.grainMixer),
      grainOverlay: unit("staticMesh.grainOverlay", d.staticMesh.grainOverlay),
    },
    dither: {
      enabled: booleanValue(value(values, "dither.enabled"), d.dither.enabled),
      strength: unit("dither.strength", d.dither.strength),
      size: finiteNumber(
        value(values, "dither.size"),
        d.dither.size,
        1,
        8,
        true,
      ),
      levels: finiteNumber(
        value(values, "dither.levels"),
        d.dither.levels,
        2,
        12,
        true,
      ),
    },
    halftone: {
      enabled: booleanValue(
        value(values, "halftone.enabled"),
        d.halftone.enabled,
      ),
      strength: unit("halftone.strength", d.halftone.strength),
      size: finiteNumber(
        value(values, "halftone.size"),
        d.halftone.size,
        3,
        24,
      ),
      angle: finiteNumber(
        value(values, "halftone.angle"),
        d.halftone.angle,
        0,
        90,
      ),
      softness: unit("halftone.softness", d.halftone.softness),
    },
  };
}

function supportedColor(color: string, fallback: string): string {
  const trimmed = color.trim();
  if (
    /^#[\da-f]{3,8}$/i.test(trimmed) ||
    /^rgba?\(/i.test(trimmed) ||
    /^hsla?\(/i.test(trimmed)
  ) {
    return trimmed;
  }
  return fallback;
}

/** Maps the persisted controls to the public Paper component prop names. */
export function buildZenShaderProps(
  config: ZenShaderConfig,
  themePalette: ZenResolvedPalette,
): Record<string, unknown> {
  const colors =
    config.paletteMode === "custom"
      ? config.customColors.map((color, index) =>
          supportedColor(color, themePalette.colors[index]!),
        )
      : [...themePalette.colors];
  const colorBack =
    config.paletteMode === "custom"
      ? supportedColor(config.customColorBack, themePalette.background)
      : themePalette.background;
  const common: Record<string, unknown> = {
    width: "100%",
    height: "100%",
    fit: "cover",
    scale: config.scale,
    rotation: config.rotation,
    offsetX: config.offsetX,
    offsetY: config.offsetY,
    minPixelRatio: 1,
    maxPixelCount: 1_500_000,
  };
  const motion = { speed: config.speed, frame: 0 };

  switch (config.shader) {
    case "grain-gradient":
      return {
        ...common,
        ...motion,
        colors,
        colorBack,
        ...config.grain,
      };
    case "neuro-noise":
      return {
        ...common,
        ...motion,
        colorBack,
        colorMid: colors[0],
        colorFront: colors[1],
        ...config.neuro,
      };
    case "warp":
      return { ...common, ...motion, colors, ...config.warp };
    case "static-mesh-gradient":
      return { ...common, colors, ...config.staticMesh };
    case "mesh-gradient":
    default:
      return { ...common, ...motion, colors, ...config.mesh };
  }
}
