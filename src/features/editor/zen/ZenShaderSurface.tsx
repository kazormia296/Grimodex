import { useMemo } from "react";
import { ShaderMount } from "@paper-design/shaders-react";
import {
  GrainGradientShapes,
  ShaderFitOptions,
  WarpPatterns,
  getShaderColorFromString,
  getShaderNoiseTexture,
  grainGradientFragmentShader,
  meshGradientFragmentShader,
  neuroNoiseFragmentShader,
  staticMeshGradientFragmentShader,
  warpFragmentShader,
} from "@paper-design/shaders";
import {
  buildZenShaderProps,
  type ZenShaderConfig,
  type ZenResolvedPalette,
} from "./zenShaderConfig";
import {
  buildZenPostProcessUniforms,
  buildZenPostProcessedFragment,
} from "./zenPostProcessing";
import { useZenThemePalette } from "./zenThemePalette";

interface ZenShaderSurfaceProps {
  config: ZenShaderConfig;
  playing: boolean;
  preview?: boolean;
}

const FRAGMENTS = {
  "mesh-gradient": meshGradientFragmentShader,
  "grain-gradient": grainGradientFragmentShader,
  "neuro-noise": neuroNoiseFragmentShader,
  warp: warpFragmentShader,
  "static-mesh-gradient": staticMeshGradientFragmentShader,
} as const;

type UniformValue =
  | boolean
  | number
  | number[]
  | number[][]
  | HTMLImageElement
  | undefined;

function buildSizingUniforms(props: Record<string, unknown>) {
  return {
    u_fit: ShaderFitOptions.cover,
    u_scale: props.scale as number,
    u_rotation: props.rotation as number,
    u_offsetX: props.offsetX as number,
    u_offsetY: props.offsetY as number,
    u_originX: 0.5,
    u_originY: 0.5,
    u_worldWidth: 0,
    u_worldHeight: 0,
  };
}

function shaderColors(props: Record<string, unknown>) {
  return (props.colors as string[]).map(getShaderColorFromString);
}

function buildPaperUniforms(
  config: ZenShaderConfig,
  palette: ZenResolvedPalette,
): Record<string, UniformValue> {
  const props = buildZenShaderProps(config, palette);
  const sizing = buildSizingUniforms(props);
  let own: Record<string, UniformValue>;

  switch (config.shader) {
    case "grain-gradient":
      own = {
        u_colorBack: getShaderColorFromString(props.colorBack as string),
        u_colors: shaderColors(props),
        u_colorsCount: (props.colors as string[]).length,
        u_softness: props.softness as number,
        u_intensity: props.intensity as number,
        u_noise: props.noise as number,
        u_shape:
          GrainGradientShapes[props.shape as keyof typeof GrainGradientShapes],
        u_noiseTexture: getShaderNoiseTexture(),
      };
      break;
    case "neuro-noise":
      own = {
        u_colorFront: getShaderColorFromString(props.colorFront as string),
        u_colorMid: getShaderColorFromString(props.colorMid as string),
        u_colorBack: getShaderColorFromString(props.colorBack as string),
        u_brightness: props.brightness as number,
        u_contrast: props.contrast as number,
      };
      break;
    case "warp":
      own = {
        u_colors: shaderColors(props),
        u_colorsCount: (props.colors as string[]).length,
        u_proportion: props.proportion as number,
        u_softness: props.softness as number,
        u_distortion: props.distortion as number,
        u_swirl: props.swirl as number,
        u_swirlIterations: props.swirlIterations as number,
        u_shapeScale: props.shapeScale as number,
        u_shape: WarpPatterns[props.shape as keyof typeof WarpPatterns],
        u_noiseTexture: getShaderNoiseTexture(),
      };
      break;
    case "static-mesh-gradient":
      own = {
        u_colors: shaderColors(props),
        u_colorsCount: (props.colors as string[]).length,
        u_positions: props.positions as number,
        u_waveX: props.waveX as number,
        u_waveXShift: props.waveXShift as number,
        u_waveY: props.waveY as number,
        u_waveYShift: props.waveYShift as number,
        u_mixing: props.mixing as number,
        u_grainMixer: props.grainMixer as number,
        u_grainOverlay: props.grainOverlay as number,
      };
      break;
    case "mesh-gradient":
    default:
      own = {
        u_colors: shaderColors(props),
        u_colorsCount: (props.colors as string[]).length,
        u_distortion: props.distortion as number,
        u_swirl: props.swirl as number,
        u_grainMixer: props.grainMixer as number,
        u_grainOverlay: props.grainOverlay as number,
      };
      break;
  }

  return { ...sizing, ...own, ...buildZenPostProcessUniforms(config) };
}

export function ZenShaderSurface({
  config,
  playing,
  preview = false,
}: ZenShaderSurfaceProps) {
  const palette = useZenThemePalette();
  const fragment = useMemo(
    () => buildZenPostProcessedFragment(FRAGMENTS[config.shader]),
    [config.shader],
  );
  const uniforms = useMemo(
    () => buildPaperUniforms(config, palette),
    [config, palette],
  );
  const speed =
    playing && config.shader !== "static-mesh-gradient" ? config.speed : 0;

  return (
    <div
      data-zen-shader-surface
      data-zen-shader-preview={preview ? "true" : "false"}
      className="zen-shader-surface absolute inset-0 overflow-hidden"
      style={{
        opacity: config.opacity / 100,
        background: `linear-gradient(135deg, ${palette.colors[0]}, ${palette.colors[1]})`,
      }}
    >
      <ShaderMount
        data-paper-shader={config.shader}
        fragmentShader={fragment}
        uniforms={uniforms}
        speed={speed}
        frame={0}
        width="100%"
        height="100%"
        minPixelRatio={1}
        maxPixelCount={preview ? 300_000 : 1_500_000}
        webGlContextAttributes={{
          alpha: true,
          antialias: false,
          powerPreference: "low-power",
          premultipliedAlpha: true,
        }}
      />
    </div>
  );
}
