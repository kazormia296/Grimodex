import { ZEN_BACKGROUND_DEFAULTS } from "./zenBackgroundDefaults";

export interface ZenGlassConfig {
  enabled: boolean;
  blur: number;
  refraction: number;
  saturation: number;
  shine: number;
}

export const ZEN_BACKGROUND_ENABLED_DEFAULT = ZEN_BACKGROUND_DEFAULTS.enabled;

export const ZEN_GLASS_DEFAULTS: ZenGlassConfig = {
  ...ZEN_BACKGROUND_DEFAULTS.glass,
};

type SettingsValues = Record<string, string | undefined>;

function value(values: SettingsValues, suffix: string) {
  return values[`editor.zenBackground.${suffix}`];
}

function booleanValue(raw: unknown, fallback: boolean) {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return fallback;
}

function finiteNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function parseZenBackgroundEnabled(values: SettingsValues) {
  return booleanValue(value(values, "enabled"), ZEN_BACKGROUND_ENABLED_DEFAULT);
}

export function parseZenGlassConfig(values: SettingsValues): ZenGlassConfig {
  return {
    enabled: booleanValue(
      value(values, "glass.enabled"),
      ZEN_GLASS_DEFAULTS.enabled,
    ),
    blur: finiteNumber(
      value(values, "glass.blur"),
      ZEN_GLASS_DEFAULTS.blur,
      0,
      40,
    ),
    refraction: finiteNumber(
      value(values, "glass.refraction"),
      ZEN_GLASS_DEFAULTS.refraction,
      0,
      24,
    ),
    saturation: finiteNumber(
      value(values, "glass.saturation"),
      ZEN_GLASS_DEFAULTS.saturation,
      0,
      2,
    ),
    shine: finiteNumber(
      value(values, "glass.shine"),
      ZEN_GLASS_DEFAULTS.shine,
      0,
      1,
    ),
  };
}
