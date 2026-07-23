import { useMemo, useRef } from "react";
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
import { contrastTargetRatio } from "./zenContrastGuard";
import { useZenShaderLayouts } from "./useZenShaderLayouts";
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
  const surfaceRef = useRef<HTMLDivElement>(null);
  const palette = useZenThemePalette();
  const layouts = useZenShaderLayouts(surfaceRef);
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
      ...buildZenPostProcessUniforms(config, {
        ...layouts.contrast,
        glassRect: layouts.glass.rect,
        textColor: palette.textColor ?? [0.85, 0.85, 0.85],
        backdropColor: palette.backdropColor ?? [0.063, 0.075, 0.094],
      }),
    }),
    [config, layouts, palette, resolved.uniforms],
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
      ref={surfaceRef}
      data-zen-shader-surface
      data-zen-shader-preview={preview ? "true" : "false"}
      data-contrast-guard={config.contrastGuard.mode}
      data-contrast-target={
        config.contrastGuard.mode === "auto"
          ? contrastTargetRatio(config.contrastGuard.strength)
          : undefined
      }
      data-contrast-rect={layouts.contrast.rect.join(" ")}
      data-contrast-feather={layouts.contrast.feather.join(" ")}
      data-glass-rect={layouts.glass.rect.join(" ")}
      data-glass-feather={layouts.glass.feather.join(" ")}
      data-glass-refraction={config.glass.enabled ? config.glass.refraction : 0}
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
