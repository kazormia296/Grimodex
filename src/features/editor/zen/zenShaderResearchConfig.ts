import { PAPER_SHADER_IDS, type PaperShaderId } from "./paperShaderCatalog";
import {
  ZEN_SHADER_DEFAULTS,
  type ZenResolvedPalette,
  type ZenShaderConfig,
} from "./zenShaderConfig";

export const ZEN_SHADER_RESEARCH_PALETTE: ZenResolvedPalette = {
  background: "#101318",
  colors: ["#8fb4d6", "#d6b5a5", "#786fa6", "#d8c47c"],
};

export interface ZenShaderResearchConfigInput {
  dither: boolean;
  ditherStrength: number;
  halftone: boolean;
  halftoneStrength: number;
  contrast: boolean;
  glass: boolean;
  blur: number;
  frame: number;
}

export function assertZenShaderResearchRenderSize(
  actual: Readonly<{ renderWidth: number; renderHeight: number }>,
  expected: Readonly<{ width: number; height: number }>,
) {
  if (
    actual.renderWidth !== expected.width ||
    actual.renderHeight !== expected.height
  ) {
    throw new Error(
      `Rendered at ${actual.renderWidth}x${actual.renderHeight}, expected ${expected.width}x${expected.height}`,
    );
  }
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export function resolveZenShaderResearchShaderIds(
  requested: string,
  orderSeed: number,
): PaperShaderId[] {
  if (requested !== "all") {
    if (!PAPER_SHADER_IDS.includes(requested as PaperShaderId)) {
      throw new TypeError(`Unknown Paper shader: ${requested}`);
    }
    return [requested as PaperShaderId];
  }

  const result = [...PAPER_SHADER_IDS];
  const random = seededRandom(orderSeed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

export function buildZenShaderResearchConfig(
  shader: PaperShaderId,
  input: Readonly<ZenShaderResearchConfigInput>,
): ZenShaderConfig {
  return {
    ...ZEN_SHADER_DEFAULTS,
    shader,
    opacity: 100,
    speed: 0,
    dither: {
      ...ZEN_SHADER_DEFAULTS.dither,
      enabled: input.dither,
      strength: input.ditherStrength,
    },
    halftone: {
      ...ZEN_SHADER_DEFAULTS.halftone,
      enabled: input.halftone,
      strength: input.halftoneStrength,
    },
    contrastGuard: {
      ...ZEN_SHADER_DEFAULTS.contrastGuard,
      mode: input.contrast ? "auto" : "none",
    },
    glass: {
      ...ZEN_SHADER_DEFAULTS.glass,
      enabled: input.glass,
      blur: input.blur,
    },
  };
}
