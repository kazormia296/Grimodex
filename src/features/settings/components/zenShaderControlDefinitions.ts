import type { ZenShaderId } from "@/features/editor/zen/zenShaderConfig";

interface SliderDefinition {
  suffix: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  percent?: boolean;
}

const unit = (
  suffix: string,
  label: string,
  defaultValue: number,
): SliderDefinition => ({
  suffix,
  label,
  min: 0,
  max: 1,
  step: 0.05,
  defaultValue,
  percent: true,
});

export const ZEN_SHADER_SLIDERS: Record<ZenShaderId, SliderDefinition[]> = {
  "mesh-gradient": [
    unit("mesh.distortion", "zenMeshDistortion", 0.7),
    unit("mesh.swirl", "zenMeshSwirl", 0.25),
    unit("mesh.grainMixer", "zenGrainMixer", 0),
    unit("mesh.grainOverlay", "zenGrainOverlay", 0),
  ],
  "grain-gradient": [
    unit("grain.softness", "zenGrainSoftness", 0.75),
    unit("grain.intensity", "zenGrainIntensity", 0.35),
    unit("grain.noise", "zenGrainNoise", 0.12),
  ],
  "neuro-noise": [
    unit("neuro.brightness", "zenNeuroBrightness", 0.1),
    unit("neuro.contrast", "zenNeuroContrast", 0.35),
  ],
  warp: [
    unit("warp.proportion", "zenWarpProportion", 0.5),
    unit("warp.softness", "zenWarpSoftness", 0.8),
    unit("warp.distortion", "zenWarpDistortion", 0.2),
    unit("warp.swirl", "zenWarpSwirl", 0.5),
    {
      suffix: "warp.swirlIterations",
      label: "zenWarpIterations",
      min: 0,
      max: 20,
      step: 1,
      defaultValue: 6,
    },
    unit("warp.shapeScale", "zenWarpShapeScale", 0.4),
  ],
  "static-mesh-gradient": [
    {
      suffix: "staticMesh.positions",
      label: "zenStaticPositions",
      min: 0,
      max: 100,
      step: 1,
      defaultValue: 35,
    },
    unit("staticMesh.waveX", "zenStaticWaveX", 0.5),
    unit("staticMesh.waveXShift", "zenStaticWaveXShift", 0.25),
    unit("staticMesh.waveY", "zenStaticWaveY", 0.55),
    unit("staticMesh.waveYShift", "zenStaticWaveYShift", 0.65),
    unit("staticMesh.mixing", "zenStaticMixing", 0.65),
    unit("staticMesh.grainMixer", "zenGrainMixer", 0),
    unit("staticMesh.grainOverlay", "zenGrainOverlay", 0),
  ],
};
