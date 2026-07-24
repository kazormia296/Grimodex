import {
  PAPER_SHADER_DEFINITIONS,
  PAPER_SHADER_IDS,
  getPaperShaderDefinition,
  type PaperShaderId,
  type PaperShaderProperty,
} from "./paperShaderCatalog";
import {
  parseZenBackgroundEnabled,
  parseZenGlassConfig,
  ZEN_GLASS_DEFAULTS,
} from "./zenBackgroundAppearanceConfig";
import {
  ZEN_BACKGROUND_DEFAULTS,
  ZEN_BACKGROUND_DEFAULT_SHADER_PROPS,
} from "./zenBackgroundDefaults";

export const ZEN_SHADER_IDS = PAPER_SHADER_IDS;
export type ZenShaderId = PaperShaderId;
export type ZenPaletteMode = "theme" | "custom";
export type ZenContrastGuardMode = "none" | "auto";

export interface ZenResolvedPalette {
  background: string;
  colors: [string, string, string, string];
}

export interface ZenShaderConfig {
  enabled: boolean;
  shader: ZenShaderId;
  paletteMode: ZenPaletteMode;
  opacity: number;
  /** Normalized user-facing percentage. Paper receives speed / 100. */
  speed: number;
  scale: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
  customColors: [string, string, string, string];
  customColorBack: string;
  shaderProps: Partial<
    Record<ZenShaderId, Record<string, PaperShaderProperty>>
  >;
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
  contrastGuard: {
    mode: ZenContrastGuardMode;
    strength: number;
    toolMix: number;
  };
  glass: {
    enabled: boolean;
    blur: number;
    refraction: number;
    saturation: number;
    shine: number;
  };
}

export const ZEN_SHADER_DEFAULTS: ZenShaderConfig = {
  enabled: ZEN_BACKGROUND_DEFAULTS.enabled,
  shader: ZEN_BACKGROUND_DEFAULTS.shader,
  paletteMode: ZEN_BACKGROUND_DEFAULTS.paletteMode,
  opacity: ZEN_BACKGROUND_DEFAULTS.opacity,
  speed: ZEN_BACKGROUND_DEFAULTS.speedPercent,
  scale: ZEN_BACKGROUND_DEFAULTS.scale,
  rotation: ZEN_BACKGROUND_DEFAULTS.rotation,
  offsetX: ZEN_BACKGROUND_DEFAULTS.offsetX,
  offsetY: ZEN_BACKGROUND_DEFAULTS.offsetY,
  customColors: [...ZEN_BACKGROUND_DEFAULTS.colors],
  customColorBack: ZEN_BACKGROUND_DEFAULTS.colorBack,
  shaderProps: ZEN_BACKGROUND_DEFAULT_SHADER_PROPS,
  dither: { ...ZEN_BACKGROUND_DEFAULTS.dither },
  halftone: { ...ZEN_BACKGROUND_DEFAULTS.halftone },
  contrastGuard: { ...ZEN_BACKGROUND_DEFAULTS.contrastGuard },
  glass: { ...ZEN_GLASS_DEFAULTS },
};

function finiteNumber(
  raw: unknown,
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
  raw: unknown,
  values: readonly T[],
  fallback: T,
): T {
  return values.includes(raw as T) ? (raw as T) : fallback;
}

function booleanValue(raw: unknown, fallback: boolean): boolean {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return fallback;
}

function value(
  values: Record<string, string | undefined>,
  suffix: string,
): string | undefined {
  return values[`editor.zenBackground.${suffix}`];
}

function parseJsonRecord(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const LEGACY_PROPS: Partial<Record<ZenShaderId, Record<string, string>>> = {
  "mesh-gradient": {
    distortion: "mesh.distortion",
    swirl: "mesh.swirl",
    grainMixer: "mesh.grainMixer",
    grainOverlay: "mesh.grainOverlay",
  },
  "grain-gradient": {
    softness: "grain.softness",
    intensity: "grain.intensity",
    noise: "grain.noise",
    shape: "grain.shape",
  },
  "neuro-noise": {
    brightness: "neuro.brightness",
    contrast: "neuro.contrast",
  },
  warp: {
    proportion: "warp.proportion",
    softness: "warp.softness",
    distortion: "warp.distortion",
    swirl: "warp.swirl",
    swirlIterations: "warp.swirlIterations",
    shape: "warp.shape",
    shapeScale: "warp.shapeScale",
  },
  "static-mesh-gradient": {
    positions: "staticMesh.positions",
    waveX: "staticMesh.waveX",
    waveXShift: "staticMesh.waveXShift",
    waveY: "staticMesh.waveY",
    waveYShift: "staticMesh.waveYShift",
    mixing: "staticMesh.mixing",
    grainMixer: "staticMesh.grainMixer",
    grainOverlay: "staticMesh.grainOverlay",
  },
};

function legacyShaderProps(
  values: Record<string, string | undefined>,
  id: ZenShaderId,
): Record<string, unknown> {
  const mapping = LEGACY_PROPS[id];
  if (!mapping) return {};
  return Object.fromEntries(
    Object.entries(mapping).flatMap(([key, suffix]) => {
      const raw = value(values, suffix);
      return raw === undefined ? [] : [[key, raw]];
    }),
  );
}

function sanitizeShaderProps(
  values: Record<string, string | undefined>,
): ZenShaderConfig["shaderProps"] {
  const persisted = parseJsonRecord(value(values, "shaderProps"));
  const result: ZenShaderConfig["shaderProps"] = {};

  for (const definition of PAPER_SHADER_DEFINITIONS) {
    const fromJson = persisted[definition.id];
    const raw = {
      ...legacyShaderProps(values, definition.id),
      ...(fromJson && typeof fromJson === "object" && !Array.isArray(fromJson)
        ? (fromJson as Record<string, unknown>)
        : {}),
    };
    const sanitized: Record<string, PaperShaderProperty> = {};

    for (const control of definition.controls) {
      if (!(control.key in raw)) continue;
      const fallback = definition.defaults[control.key];
      if (control.type === "slider") {
        sanitized[control.key] = finiteNumber(
          raw[control.key],
          typeof fallback === "number" ? fallback : control.min,
          control.min,
          control.max,
          Number.isInteger(control.step),
        );
      } else if (control.type === "toggle") {
        sanitized[control.key] = booleanValue(
          raw[control.key],
          typeof fallback === "boolean" ? fallback : false,
        );
      } else {
        sanitized[control.key] = enumValue(
          raw[control.key],
          control.options,
          typeof fallback === "string" ? fallback : control.options[0]!,
        );
      }
    }

    if (Object.keys(sanitized).length > 0) result[definition.id] = sanitized;
  }
  return result;
}

function parseSpeedPercent(values: Record<string, string | undefined>): number {
  const current = value(values, "speedPercent");
  if (current !== undefined) {
    return finiteNumber(current, ZEN_SHADER_DEFAULTS.speed, 0, 100);
  }
  const legacy = value(values, "speed");
  if (legacy === undefined) return ZEN_SHADER_DEFAULTS.speed;
  return finiteNumber(Number(legacy) * 100, ZEN_SHADER_DEFAULTS.speed, 0, 100);
}

export function parseZenShaderConfig(
  values: Record<string, string | undefined>,
): ZenShaderConfig {
  const d = ZEN_SHADER_DEFAULTS;
  const unit = (suffix: string, fallback: number) =>
    finiteNumber(value(values, suffix), fallback, 0, 1);

  return {
    enabled: parseZenBackgroundEnabled(values),
    shader: enumValue(value(values, "shader"), ZEN_SHADER_IDS, d.shader),
    paletteMode: enumValue(
      value(values, "paletteMode"),
      ["theme", "custom"],
      d.paletteMode,
    ),
    opacity: finiteNumber(value(values, "opacity"), d.opacity, 0, 100),
    speed: parseSpeedPercent(values),
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
    customColorBack: value(values, "colorBack") ?? d.customColorBack,
    shaderProps: sanitizeShaderProps(values),
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
    contrastGuard: {
      mode: enumValue(
        value(values, "contrastGuard.mode"),
        ["none", "auto"],
        d.contrastGuard.mode,
      ),
      strength: unit("contrastGuard.strength", d.contrastGuard.strength),
      toolMix: finiteNumber(
        value(values, "contrastGuard.toolMix"),
        d.contrastGuard.toolMix,
        0,
        0.75,
      ),
    },
    glass: parseZenGlassConfig(values),
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

function paletteImageDataUrl(palette: ZenResolvedPalette): string {
  const colors = [palette.background, ...palette.colors].map((color) =>
    color.replaceAll("&", "&amp;").replaceAll('"', "&quot;"),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><radialGradient id="a" cx="20%" cy="15%" r="90%"><stop stop-color="${colors[1]}"/><stop offset="1" stop-color="${colors[0]}"/></radialGradient><radialGradient id="b" cx="80%" cy="85%" r="75%"><stop stop-color="${colors[2]}"/><stop offset="1" stop-color="${colors[3]}" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" fill="url(#a)"/><rect width="512" height="512" fill="url(#b)"/><circle cx="256" cy="256" r="132" fill="${colors[4]}" fill-opacity=".55"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function colorProps(
  defaults: Record<string, unknown>,
  palette: ZenResolvedPalette,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const colors = palette.colors;
  const assignments: Record<string, string> = {
    colorBack: palette.background,
    colorFront: colors[0],
    colorFill: colors[0],
    colorStroke: colors[1],
    colorMid: colors[1],
    colorHighlight: colors[1],
    colorShadow: colors[2],
    colorBloom: colors[1],
    colorInner: colors[0],
    colorTint: colors[0],
    colorGlow: colors[0],
    colorGap: palette.background,
    colorC: colors[0],
    colorM: colors[1],
    colorY: colors[2],
    colorK: colors[3],
  };
  if ("colors" in defaults) result.colors = [...colors];
  for (const [key, color] of Object.entries(assignments)) {
    if (key in defaults) result[key] = color;
  }
  return result;
}

/** Maps persisted controls to the complete public Paper component prop set. */
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
  const background =
    config.paletteMode === "custom"
      ? supportedColor(config.customColorBack, themePalette.background)
      : themePalette.background;
  const palette = {
    background,
    colors: colors as ZenResolvedPalette["colors"],
  };
  const definition = getPaperShaderDefinition(config.shader);

  return {
    ...definition.defaults,
    ...colorProps(definition.defaults, palette),
    ...(definition.imageSource ? { image: paletteImageDataUrl(palette) } : {}),
    ...config.shaderProps[config.shader],
    width: "100%",
    height: "100%",
    fit: "cover",
    speed: config.speed / 100,
    frame: 0,
    scale: config.scale,
    rotation: config.rotation,
    offsetX: config.offsetX,
    offsetY: config.offsetY,
    minPixelRatio: 1,
    maxPixelCount: 1_500_000,
  };
}
