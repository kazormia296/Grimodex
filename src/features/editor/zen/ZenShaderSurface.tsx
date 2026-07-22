import { useMemo } from "react";
import { ShaderMount } from "@paper-design/shaders-react";
import {
  getPaperShaderDefinition,
  resolvePaperShaderMount,
} from "./paperShaderCatalog";
import { buildZenShaderProps, type ZenShaderConfig } from "./zenShaderConfig";
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

export function ZenShaderSurface({
  config,
  playing,
  preview = false,
}: ZenShaderSurfaceProps) {
  const palette = useZenThemePalette();
  const resolved = useMemo(
    () =>
      resolvePaperShaderMount(
        config.shader,
        buildZenShaderProps(config, palette),
      ),
    [config, palette],
  );
  const fragmentShader = useMemo(
    () => buildZenPostProcessedFragment(resolved.fragmentShader),
    [resolved.fragmentShader],
  );
  const uniforms = useMemo(
    () => ({
      ...resolved.uniforms,
      ...buildZenPostProcessUniforms(config),
    }),
    [config, resolved.uniforms],
  );
  const definition = getPaperShaderDefinition(config.shader);
  const speed = playing && definition.animated ? config.speed / 100 : 0;
  const {
    fragmentShader: _fragmentShader,
    uniforms: _uniforms,
    speed: _speed,
    frame: _frame,
    maxPixelCount: resolvedMaxPixelCount,
    webGlContextAttributes: _context,
    ...mountProps
  } = resolved;

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
        key={config.shader}
        {...mountProps}
        data-paper-shader={config.shader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        speed={speed}
        frame={0}
        width="100%"
        height="100%"
        minPixelRatio={1}
        maxPixelCount={preview ? 300_000 : (resolvedMaxPixelCount ?? 1_500_000)}
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
