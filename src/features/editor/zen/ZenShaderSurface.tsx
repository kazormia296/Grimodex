import { useMemo, useRef } from "react";
import type { PaperShaderElement } from "@paper-design/shaders";
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
import { useZenShaderAnimation } from "./zenShaderAnimation";
import { usePreparedZenShaderUniforms } from "./zenShaderImageUniforms";
import { useZenThemePalette } from "./zenThemePalette";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import { zenUiSurfaceVariantCapacity } from "./zenGlassRefraction";
import { buildZenGlassMask } from "./zenGlassCompositor";

const PREVIEW_PIXEL_BUDGET = 300_000;
const LIVE_BACKGROUND_PIXEL_BUDGET = 1920 * 1080;
const LIVE_BACKGROUND_MIN_PIXEL_RATIO = 1;

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
  const paperMountRef = useRef<PaperShaderElement>(null);
  const palette = useZenThemePalette();
  const layouts = useZenShaderLayouts(surfaceRef);
  // Paper prepares uniforms asynchronously. Keep the program, upload buffer,
  // and React mount on one capacity so a stale smaller initialization cannot
  // win while the startup layout expands from one surface to the full shell.
  const uiSurfaceCapacity = zenUiSurfaceVariantCapacity(
    layouts.uiSurfaces.length,
  );
  const surfaceUniformBuffer = useMemo(
    () => new ZenUiSurfaceUniformBuffer(uiSurfaceCapacity),
    [uiSurfaceCapacity],
  );
  const resolved = useMemo(
    () =>
      resolvePaperShaderMount(
        config.shader,
        buildZenShaderProps(config, palette),
      ),
    [config, palette],
  );
  const fragmentShader = useMemo(
    () =>
      buildZenPostProcessedFragment(resolved.fragmentShader, uiSurfaceCapacity),
    [resolved.fragmentShader, uiSurfaceCapacity],
  );
  const uniforms = useMemo(
    () => ({
      ...resolved.uniforms,
      ...buildZenPostProcessUniforms(
        config,
        {
          ...layouts.contrast,
          glassRect: layouts.glass.rect,
          glassCornerRadius: layouts.glass.cornerRadius,
          uiSurfaces: layouts.uiSurfaces,
          textColor: palette.textColor ?? [0.85, 0.85, 0.85],
          uiTextColor: palette.uiTextColor ??
            palette.textColor ?? [0.85, 0.85, 0.85],
          backdropColor: palette.backdropColor ?? [0.063, 0.075, 0.094],
        },
        surfaceUniformBuffer,
      ),
    }),
    [config, layouts, palette, resolved.uniforms, surfaceUniformBuffer],
  );
  const preparedUniforms = usePreparedZenShaderUniforms(uniforms);
  const definition = getPaperShaderDefinition(config.shader);
  const animationSpeed = config.speed / 100;
  const shouldAnimate =
    preparedUniforms !== null &&
    playing &&
    definition.animated &&
    animationSpeed > 0;
  useZenShaderAnimation(paperMountRef, {
    playing: shouldAnimate,
    speed: animationSpeed,
    resetKey: config.shader,
  });
  const {
    fragmentShader: _fragmentShader,
    uniforms: _uniforms,
    speed: _speed,
    frame: _frame,
    maxPixelCount: resolvedMaxPixelCount,
    webGlContextAttributes: _context,
    ...mountProps
  } = resolved;
  const maxPixelCount = preview
    ? PREVIEW_PIXEL_BUDGET
    : Math.min(
        resolvedMaxPixelCount ?? LIVE_BACKGROUND_PIXEL_BUDGET,
        LIVE_BACKGROUND_PIXEL_BUDGET,
      );
  const useSharedGlassCompositor =
    !preview && config.glass.enabled && layouts.uiSurfaces.length > 0;

  return (
    <div
      ref={surfaceRef}
      data-zen-shader-surface
      data-zen-shader-preview={preview ? "true" : "false"}
      data-zen-shader-ready={preparedUniforms ? "true" : "false"}
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
      data-glass-corner-radius={layouts.glass.cornerRadius}
      data-glass-refraction={config.glass.enabled ? config.glass.refraction : 0}
      data-ui-glass-surface-count={layouts.uiSurfaces.length}
      className="zen-shader-surface absolute inset-0 overflow-hidden"
      style={{
        opacity: config.opacity / 100,
        background: `linear-gradient(135deg, ${palette.colors[0]}, ${palette.colors[1]})`,
      }}
    >
      {preparedUniforms && (
        <ShaderMount
          key={`${config.shader}:${uiSurfaceCapacity}`}
          {...mountProps}
          ref={paperMountRef}
          data-paper-shader={config.shader}
          fragmentShader={fragmentShader}
          uniforms={preparedUniforms}
          speed={0}
          frame={0}
          width="100%"
          height="100%"
          minPixelRatio={LIVE_BACKGROUND_MIN_PIXEL_RATIO}
          maxPixelCount={maxPixelCount}
          webGlContextAttributes={{
            alpha: true,
            antialias: false,
            powerPreference: "default",
            premultipliedAlpha: true,
          }}
        />
      )}
      {useSharedGlassCompositor && (
        <div
          data-zen-glass-compositor
          className="pointer-events-none absolute inset-0"
          style={{
            backdropFilter: `blur(${config.glass.blur}px) saturate(${config.glass.saturation}) contrast(1.03)`,
            maskImage: buildZenGlassMask(
              layouts.surfaceSize,
              layouts.glass,
              layouts.uiSurfaces,
            ),
            maskPosition: "0 0",
            maskRepeat: "no-repeat",
            maskSize: "100% 100%",
          }}
        />
      )}
    </div>
  );
}
