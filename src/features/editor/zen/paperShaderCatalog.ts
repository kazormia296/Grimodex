import type { ReactElement } from "react";
import type { ShaderMountProps } from "@paper-design/shaders-react";
import {
  GemSmokeShapes,
  LiquidMetalShapes,
  ShaderFitOptions,
  gemSmokeFragmentShader,
  getShaderColorFromString,
  heatmapFragmentShader,
  liquidMetalFragmentShader,
} from "@paper-design/shaders";
import {
  ColorPanels,
  Dithering,
  DotGrid,
  DotOrbit,
  FlutedGlass,
  GemSmoke,
  GodRays,
  GrainGradient,
  HalftoneCmyk,
  HalftoneDots,
  Heatmap,
  ImageDithering,
  LiquidMetal,
  MeshGradient,
  Metaballs,
  NeuroNoise,
  PaperTexture,
  PerlinNoise,
  PulsingBorder,
  SimplexNoise,
  SmokeRing,
  Spiral,
  StaticMeshGradient,
  StaticRadialGradient,
  Swirl,
  Voronoi,
  Warp,
  Water,
  Waves,
  colorPanelsPresets,
  ditheringPresets,
  dotGridPresets,
  dotOrbitPresets,
  flutedGlassPresets,
  gemSmokePresets,
  godRaysPresets,
  grainGradientPresets,
  halftoneCmykPresets,
  halftoneDotsPresets,
  heatmapPresets,
  imageDitheringPresets,
  liquidMetalPresets,
  meshGradientPresets,
  metaballsPresets,
  neuroNoisePresets,
  paperTexturePresets,
  perlinNoisePresets,
  pulsingBorderPresets,
  simplexNoisePresets,
  smokeRingPresets,
  spiralPresets,
  staticMeshGradientPresets,
  staticRadialGradientPresets,
  swirlPresets,
  voronoiPresets,
  warpPresets,
  waterPresets,
  wavesPresets,
} from "@paper-design/shaders-react";

export const PAPER_SHADER_IDS = [
  "color-panels",
  "dithering",
  "dot-grid",
  "dot-orbit",
  "fluted-glass",
  "gem-smoke",
  "god-rays",
  "grain-gradient",
  "halftone-cmyk",
  "halftone-dots",
  "heatmap",
  "image-dithering",
  "liquid-metal",
  "mesh-gradient",
  "metaballs",
  "neuro-noise",
  "paper-texture",
  "perlin-noise",
  "pulsing-border",
  "simplex-noise",
  "smoke-ring",
  "spiral",
  "static-mesh-gradient",
  "static-radial-gradient",
  "swirl",
  "voronoi",
  "warp",
  "water",
  "waves",
] as const;

export type PaperShaderId = (typeof PAPER_SHADER_IDS)[number];
export type PaperShaderProperty = number | string | boolean;

export interface PaperSliderControl {
  type: "slider";
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

export interface PaperSelectControl {
  type: "select";
  key: string;
  label: string;
  options: readonly string[];
}

export interface PaperToggleControl {
  type: "toggle";
  key: string;
  label: string;
}

export type PaperShaderControl =
  | PaperSliderControl
  | PaperSelectControl
  | PaperToggleControl;

interface PaperPreset {
  params: Record<string, unknown>;
}

type ResolvablePaperComponent = {
  type: (props: Record<string, unknown>) => ReactElement<ShaderMountProps>;
};

export interface PaperShaderDefinition {
  id: PaperShaderId;
  name: string;
  component: ResolvablePaperComponent;
  defaults: Record<string, unknown>;
  controls: readonly PaperShaderControl[];
  animated: boolean;
  imageSource?: boolean;
}

const unit = (key: string, label: string): PaperSliderControl => ({
  type: "slider",
  key,
  label,
  min: 0,
  max: 1,
  step: 0.01,
});
const bipolar = (key: string, label: string): PaperSliderControl => ({
  type: "slider",
  key,
  label,
  min: -1,
  max: 1,
  step: 0.01,
});
const angle = (key: string, label: string, max = 360): PaperSliderControl => ({
  type: "slider",
  key,
  label,
  min: 0,
  max,
  step: 1,
});
const range = (
  key: string,
  label: string,
  min: number,
  max: number,
  step = 0.01,
): PaperSliderControl => ({ type: "slider", key, label, min, max, step });
const select = (
  key: string,
  label: string,
  options: readonly string[],
): PaperSelectControl => ({ type: "select", key, label, options });
const toggle = (key: string, label: string): PaperToggleControl => ({
  type: "toggle",
  key,
  label,
});

const grain = [
  unit("grainMixer", "Grain mixer"),
  unit("grainOverlay", "Grain overlay"),
];
const margins = [
  unit("marginLeft", "Margin left"),
  unit("marginRight", "Margin right"),
  unit("marginTop", "Margin top"),
  unit("marginBottom", "Margin bottom"),
];

function definition(
  id: PaperShaderId,
  name: string,
  component: unknown,
  presets: readonly PaperPreset[],
  controls: readonly PaperShaderControl[],
  animated: boolean,
  imageSource = false,
): PaperShaderDefinition {
  return {
    id,
    name,
    component: component as ResolvablePaperComponent,
    defaults: { ...presets[0]!.params },
    controls,
    animated,
    imageSource,
  };
}

export const PAPER_SHADER_DEFINITIONS: readonly PaperShaderDefinition[] = [
  definition(
    "color-panels",
    "Color Panels",
    ColorPanels,
    colorPanelsPresets,
    [
      range("density", "Density", 0.25, 7, 0.05),
      bipolar("angle1", "Skew 1"),
      bipolar("angle2", "Skew 2"),
      range("length", "Length", 0, 3, 0.05),
      toggle("edges", "Edge highlights"),
      range("blur", "Blur", 0, 0.5),
      unit("fadeIn", "Fade in"),
      unit("fadeOut", "Fade out"),
      unit("gradient", "Gradient"),
    ],
    true,
  ),
  definition(
    "dithering",
    "Dithering",
    Dithering,
    ditheringPresets,
    [
      select("shape", "Pattern", [
        "simplex",
        "warp",
        "dots",
        "wave",
        "ripple",
        "swirl",
        "sphere",
      ]),
      select("type", "Matrix", ["random", "2x2", "4x4", "8x8"]),
      range("size", "Pixel size", 0.5, 20, 0.5),
    ],
    true,
  ),
  definition(
    "dot-grid",
    "Dot Grid",
    DotGrid,
    dotGridPresets,
    [
      range("size", "Dot size", 1, 100, 1),
      range("gapX", "Horizontal gap", 2, 500, 1),
      range("gapY", "Vertical gap", 2, 500, 1),
      range("strokeWidth", "Stroke width", 0, 50, 1),
      unit("sizeRange", "Size variation"),
      unit("opacityRange", "Opacity variation"),
      select("shape", "Shape", ["circle", "diamond", "square", "triangle"]),
    ],
    false,
  ),
  definition(
    "dot-orbit",
    "Dot Orbit",
    DotOrbit,
    dotOrbitPresets,
    [
      unit("size", "Dot size"),
      unit("sizeRange", "Size variation"),
      unit("spreading", "Orbit spread"),
      range("stepsPerColor", "Color steps", 1, 4, 1),
    ],
    true,
  ),
  definition(
    "fluted-glass",
    "Fluted Glass",
    FlutedGlass,
    flutedGlassPresets,
    [
      unit("shadows", "Shadows"),
      unit("highlights", "Highlights"),
      unit("size", "Grid size"),
      angle("angle", "Grid angle", 180),
      unit("distortion", "Distortion"),
      bipolar("shift", "Texture shift"),
      unit("stretch", "Stretch"),
      unit("blur", "Blur"),
      unit("edges", "Edges"),
      select("shape", "Grid shape", [
        "lines",
        "linesIrregular",
        "wave",
        "zigzag",
        "pattern",
      ]),
      select("distortionShape", "Distortion shape", [
        "prism",
        "lens",
        "contour",
        "cascade",
        "flat",
      ]),
      ...margins,
      ...grain,
    ],
    false,
    true,
  ),
  definition(
    "gem-smoke",
    "Gem Smoke",
    GemSmoke,
    gemSmokePresets,
    [
      unit("innerDistortion", "Inner distortion"),
      unit("outerDistortion", "Outer distortion"),
      unit("innerGlow", "Inner glow"),
      unit("outerGlow", "Outer glow"),
      bipolar("offset", "Smoke offset"),
      angle("angle", "Direction"),
      unit("size", "Shape size"),
      select("shape", "Shape", [
        "none",
        "circle",
        "daisy",
        "diamond",
        "metaballs",
      ]),
    ],
    true,
  ),
  definition(
    "god-rays",
    "God Rays",
    GodRays,
    godRaysPresets,
    [
      unit("density", "Density"),
      unit("spotty", "Spotty"),
      unit("midSize", "Center size"),
      unit("midIntensity", "Center intensity"),
      unit("intensity", "Intensity"),
      unit("bloom", "Bloom"),
    ],
    true,
  ),
  definition(
    "grain-gradient",
    "Grain Gradient",
    GrainGradient,
    grainGradientPresets,
    [
      unit("softness", "Softness"),
      unit("intensity", "Distortion"),
      unit("noise", "Noise"),
      select("shape", "Shape", [
        "wave",
        "dots",
        "truchet",
        "corners",
        "ripple",
        "blob",
        "sphere",
      ]),
    ],
    true,
  ),
  definition(
    "halftone-cmyk",
    "Halftone CMYK",
    HalftoneCmyk,
    halftoneCmykPresets,
    [
      unit("size", "Cell size"),
      range("contrast", "Contrast", 0, 2),
      unit("softness", "Softness"),
      unit("grainSize", "Grain size"),
      ...grain,
      unit("gridNoise", "Grid noise"),
      bipolar("floodC", "Cyan flood"),
      bipolar("floodM", "Magenta flood"),
      bipolar("floodY", "Yellow flood"),
      bipolar("floodK", "Black flood"),
      bipolar("gainC", "Cyan gain"),
      bipolar("gainM", "Magenta gain"),
      bipolar("gainY", "Yellow gain"),
      bipolar("gainK", "Black gain"),
      select("type", "Dot style", ["dots", "ink", "sharp"]),
    ],
    false,
    true,
  ),
  definition(
    "halftone-dots",
    "Halftone Dots",
    HalftoneDots,
    halftoneDotsPresets,
    [
      unit("size", "Grid size"),
      range("radius", "Dot radius", 0, 2),
      unit("contrast", "Contrast"),
      toggle("originalColors", "Original colors"),
      toggle("inverted", "Invert luminance"),
      ...grain,
      unit("grainSize", "Grain size"),
      select("grid", "Grid", ["square", "hex"]),
      select("type", "Dot style", ["classic", "gooey", "holes", "soft"]),
    ],
    false,
    true,
  ),
  definition(
    "heatmap",
    "Heatmap",
    Heatmap,
    heatmapPresets,
    [
      unit("contour", "Contour"),
      angle("angle", "Direction"),
      unit("noise", "Noise"),
      unit("innerGlow", "Inner glow"),
      unit("outerGlow", "Outer glow"),
    ],
    true,
    true,
  ),
  definition(
    "image-dithering",
    "Image Dithering",
    ImageDithering,
    imageDitheringPresets,
    [
      select("type", "Matrix", ["random", "2x2", "4x4", "8x8"]),
      range("size", "Pixel size", 0.5, 20, 0.5),
      range("colorSteps", "Color steps", 1, 7, 1),
      toggle("originalColors", "Original colors"),
      toggle("inverted", "Invert luminance"),
    ],
    false,
    true,
  ),
  definition(
    "liquid-metal",
    "Liquid Metal",
    LiquidMetal,
    liquidMetalPresets,
    [
      range("repetition", "Repetition", 1, 10, 1),
      bipolar("shiftRed", "Red shift"),
      bipolar("shiftBlue", "Blue shift"),
      unit("contour", "Contour"),
      unit("softness", "Softness"),
      unit("distortion", "Distortion"),
      angle("angle", "Direction"),
      select("shape", "Shape", [
        "none",
        "circle",
        "daisy",
        "diamond",
        "metaballs",
      ]),
    ],
    true,
  ),
  definition(
    "mesh-gradient",
    "Mesh Gradient",
    MeshGradient,
    meshGradientPresets,
    [unit("distortion", "Distortion"), unit("swirl", "Swirl"), ...grain],
    true,
  ),
  definition(
    "metaballs",
    "Metaballs",
    Metaballs,
    metaballsPresets,
    [range("count", "Ball count", 1, 20, 1), unit("size", "Ball size")],
    true,
  ),
  definition(
    "neuro-noise",
    "Neuro Noise",
    NeuroNoise,
    neuroNoisePresets,
    [unit("brightness", "Brightness"), unit("contrast", "Contrast")],
    true,
  ),
  definition(
    "paper-texture",
    "Paper Texture",
    PaperTexture,
    paperTexturePresets,
    [
      unit("contrast", "Contrast"),
      unit("roughness", "Roughness"),
      unit("fiber", "Fiber"),
      unit("fiberSize", "Fiber size"),
      unit("crumples", "Crumples"),
      unit("crumpleSize", "Crumple size"),
      unit("folds", "Folds"),
      range("foldCount", "Fold count", 1, 15, 1),
      unit("fade", "Fade"),
      unit("drops", "Drops"),
      range("seed", "Seed", 0, 1000, 1),
    ],
    false,
    true,
  ),
  definition(
    "perlin-noise",
    "Perlin Noise",
    PerlinNoise,
    perlinNoisePresets,
    [
      unit("proportion", "Proportion"),
      unit("softness", "Softness"),
      range("octaveCount", "Octaves", 1, 8, 1),
      range("persistence", "Persistence", 0.3, 1),
      range("lacunarity", "Lacunarity", 1.5, 10, 0.1),
    ],
    true,
  ),
  definition(
    "pulsing-border",
    "Pulsing Border",
    PulsingBorder,
    pulsingBorderPresets,
    [
      unit("roundness", "Roundness"),
      unit("thickness", "Thickness"),
      ...margins,
      select("aspectRatio", "Aspect ratio", ["auto", "square"]),
      unit("softness", "Softness"),
      unit("intensity", "Intensity"),
      unit("bloom", "Bloom"),
      range("spots", "Spots", 1, 20, 1),
      unit("spotSize", "Spot size"),
      unit("pulse", "Pulse"),
      unit("smoke", "Smoke"),
      unit("smokeSize", "Smoke size"),
    ],
    true,
  ),
  definition(
    "simplex-noise",
    "Simplex Noise",
    SimplexNoise,
    simplexNoisePresets,
    [
      range("stepsPerColor", "Color steps", 1, 10, 1),
      unit("softness", "Softness"),
    ],
    true,
  ),
  definition(
    "smoke-ring",
    "Smoke Ring",
    SmokeRing,
    smokeRingPresets,
    [
      range("noiseScale", "Noise scale", 0.01, 5),
      range("noiseIterations", "Noise layers", 1, 8, 1),
      range("thickness", "Thickness", 0.01, 1),
      unit("radius", "Radius"),
      range("innerShape", "Inner fill", 0, 4),
    ],
    true,
  ),
  definition(
    "spiral",
    "Spiral",
    Spiral,
    spiralPresets,
    [
      unit("density", "Density"),
      unit("distortion", "Distortion"),
      unit("strokeWidth", "Stroke width"),
      unit("strokeTaper", "Stroke taper"),
      unit("strokeCap", "Center cap"),
      unit("noise", "Noise"),
      unit("noiseFrequency", "Noise frequency"),
      unit("softness", "Softness"),
    ],
    true,
  ),
  definition(
    "static-mesh-gradient",
    "Static Mesh Gradient",
    StaticMeshGradient,
    staticMeshGradientPresets,
    [
      range("positions", "Position seed", 0, 100, 1),
      unit("waveX", "Wave X"),
      unit("waveXShift", "Wave X shift"),
      unit("waveY", "Wave Y"),
      unit("waveYShift", "Wave Y shift"),
      unit("mixing", "Mixing"),
      ...grain,
    ],
    false,
  ),
  definition(
    "static-radial-gradient",
    "Static Radial Gradient",
    StaticRadialGradient,
    staticRadialGradientPresets,
    [
      range("radius", "Radius", 0, 3),
      range("focalDistance", "Focal distance", 0, 3),
      angle("focalAngle", "Focal angle"),
      range("falloff", "Falloff", -1, 1),
      unit("mixing", "Mixing"),
      unit("distortion", "Distortion"),
      bipolar("distortionShift", "Distortion shift"),
      range("distortionFreq", "Distortion frequency", 0, 20, 0.1),
      ...grain,
    ],
    false,
  ),
  definition(
    "swirl",
    "Swirl",
    Swirl,
    swirlPresets,
    [
      range("bandCount", "Band count", 0, 15, 1),
      unit("twist", "Twist"),
      unit("center", "Center"),
      unit("proportion", "Proportion"),
      unit("softness", "Softness"),
      unit("noise", "Noise"),
      unit("noiseFrequency", "Noise frequency"),
    ],
    true,
  ),
  definition(
    "voronoi",
    "Voronoi",
    Voronoi,
    voronoiPresets,
    [
      range("stepsPerColor", "Color steps", 1, 3, 1),
      range("distortion", "Distortion", 0, 0.5),
      range("gap", "Cell gap", 0, 0.1, 0.005),
      unit("glow", "Glow"),
    ],
    true,
  ),
  definition(
    "warp",
    "Warp",
    Warp,
    warpPresets,
    [
      unit("proportion", "Proportion"),
      unit("softness", "Softness"),
      unit("distortion", "Distortion"),
      unit("swirl", "Swirl"),
      range("swirlIterations", "Swirl layers", 0, 20, 1),
      unit("shapeScale", "Pattern scale"),
      select("shape", "Pattern", ["checks", "stripes", "edge"]),
    ],
    true,
  ),
  definition(
    "water",
    "Water",
    Water,
    waterPresets,
    [
      unit("highlights", "Highlights"),
      unit("layering", "Layering"),
      unit("edges", "Edges"),
      unit("waves", "Waves"),
      unit("caustic", "Caustic"),
      range("size", "Pattern size", 0.01, 7, 0.01),
    ],
    true,
    true,
  ),
  definition(
    "waves",
    "Waves",
    Waves,
    wavesPresets,
    [
      range("shape", "Wave shape", 0, 3, 0.05),
      unit("amplitude", "Amplitude"),
      range("frequency", "Frequency", 0, 2),
      range("spacing", "Spacing", 0, 2),
      unit("proportion", "Proportion"),
      unit("softness", "Softness"),
    ],
    false,
  ),
];

const BY_ID = new Map(PAPER_SHADER_DEFINITIONS.map((item) => [item.id, item]));

export function getPaperShaderDefinition(id: PaperShaderId) {
  return BY_ID.get(id)!;
}

/**
 * Paper 0.0.77's memoized wrappers are pure prop-to-uniform adapters. Calling
 * their exposed `type` keeps the official defaults, enums, textures and image
 * preprocessing in one place while our ShaderMount adds the post-process pass.
 */
export function resolvePaperShaderMount(
  id: PaperShaderId,
  props: Record<string, unknown>,
): ShaderMountProps {
  if (id === "gem-smoke" || id === "heatmap" || id === "liquid-metal") {
    return resolveStatefulPaperShader(id, {
      ...getPaperShaderDefinition(id).defaults,
      ...props,
    });
  }
  return getPaperShaderDefinition(id).component.type(props).props;
}

function sizingUniforms(props: Record<string, unknown>) {
  return {
    u_fit: ShaderFitOptions[props.fit as keyof typeof ShaderFitOptions],
    u_scale: props.scale as number,
    u_rotation: props.rotation as number,
    u_offsetX: props.offsetX as number,
    u_offsetY: props.offsetY as number,
    u_originX: (props.originX as number | undefined) ?? 0.5,
    u_originY: (props.originY as number | undefined) ?? 0.5,
    u_worldWidth: (props.worldWidth as number | undefined) ?? 0,
    u_worldHeight: (props.worldHeight as number | undefined) ?? 0,
  };
}

function mountShell(props: Record<string, unknown>) {
  return {
    speed: props.speed as number,
    frame: (props.frame as number | undefined) ?? 0,
    width: props.width as string | number | undefined,
    height: props.height as string | number | undefined,
    minPixelRatio: props.minPixelRatio as number | undefined,
    maxPixelCount: props.maxPixelCount as number | undefined,
  };
}

function resolveStatefulPaperShader(
  id: "gem-smoke" | "heatmap" | "liquid-metal",
  props: Record<string, unknown>,
): ShaderMountProps {
  const colors = ((props.colors as string[] | undefined) ?? []).map(
    getShaderColorFromString,
  );
  if (id === "gem-smoke") {
    return {
      ...mountShell(props),
      fragmentShader: gemSmokeFragmentShader,
      uniforms: {
        u_colors: colors,
        u_colorsCount: colors.length,
        u_colorBack: getShaderColorFromString(props.colorBack as string),
        u_image: props.image as string | undefined,
        u_innerDistortion: props.innerDistortion as number,
        u_outerDistortion: props.outerDistortion as number,
        u_outerGlow: props.outerGlow as number,
        u_innerGlow: props.innerGlow as number,
        u_colorInner: getShaderColorFromString(props.colorInner as string),
        u_offset: props.offset as number,
        u_angle: props.angle as number,
        u_size: props.size as number,
        u_isImage: Boolean(props.image),
        u_shape: GemSmokeShapes[props.shape as keyof typeof GemSmokeShapes],
        ...sizingUniforms(props),
      },
    };
  }
  if (id === "heatmap") {
    return {
      ...mountShell(props),
      fragmentShader: heatmapFragmentShader,
      mipmaps: ["u_image"],
      uniforms: {
        u_image: props.image as string | undefined,
        u_contour: props.contour as number,
        u_angle: props.angle as number,
        u_noise: props.noise as number,
        u_innerGlow: props.innerGlow as number,
        u_outerGlow: props.outerGlow as number,
        u_colorBack: getShaderColorFromString(props.colorBack as string),
        u_colors: colors,
        u_colorsCount: colors.length,
        ...sizingUniforms(props),
      },
    };
  }
  return {
    ...mountShell(props),
    fragmentShader: liquidMetalFragmentShader,
    uniforms: {
      u_colorBack: getShaderColorFromString(props.colorBack as string),
      u_colorTint: getShaderColorFromString(props.colorTint as string),
      u_image: props.image as string | undefined,
      u_contour: props.contour as number,
      u_distortion: props.distortion as number,
      u_softness: props.softness as number,
      u_repetition: props.repetition as number,
      u_shiftRed: props.shiftRed as number,
      u_shiftBlue: props.shiftBlue as number,
      u_angle: props.angle as number,
      u_isImage: Boolean(props.image),
      u_shape: LiquidMetalShapes[props.shape as keyof typeof LiquidMetalShapes],
      ...sizingUniforms(props),
    },
  };
}
