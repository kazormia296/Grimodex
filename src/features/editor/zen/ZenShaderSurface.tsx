import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PaperShaderElement } from "@paper-design/shaders";
import {
  getPaperShaderDefinition,
  resolvePaperShaderMount,
} from "./paperShaderCatalog";
import { buildZenShaderProps, type ZenShaderConfig } from "./zenShaderConfig";
import { contrastTargetRatio } from "./zenContrastGuard";
import { useZenShaderLayouts } from "./useZenShaderLayouts";
import { useZenShaderAnimation } from "./zenShaderAnimation";
import { usePreparedZenShaderUniforms } from "./zenShaderImageUniforms";
import { useZenThemePalette } from "./zenThemePalette";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import { zenUiSurfaceVariantCapacity } from "./zenGlassRefraction";
import { hasZenGlassRegion } from "./zenGlassCompositor";
import { ZenMultipassCanvas } from "./ZenMultipassCanvas";
import {
  buildZenMultipassCompositeFragment,
  buildZenMultipassCompositeUniforms,
  buildZenMultipassSceneFragment,
  buildZenMultipassSceneUniforms,
} from "./zenMultipassPipeline";

const PREVIEW_PIXEL_BUDGET = 300_000;
const LIVE_BACKGROUND_PIXEL_BUDGET = 1920 * 1080;
const LIVE_BACKGROUND_MIN_PIXEL_RATIO = 1;
const INITIAL_UI_SURFACE_CAPACITY = 16;
const LIVE_WEBGL_CONTEXT_ATTRIBUTES = {
  alpha: true,
  antialias: false,
  powerPreference: "default",
  premultipliedAlpha: true,
} satisfies WebGLContextAttributes;

interface ZenShaderSurfaceProps {
  config: ZenShaderConfig;
  playing: boolean;
  preview?: boolean;
  webGlSupported?: boolean;
  onRendererStatusChange?: (status: ZenShaderRendererStatus) => void;
}

export type ZenShaderRendererStatus =
  | "initializing"
  | "webgl"
  | "fallback-unsupported"
  | "fallback-context-lost";

export function ZenShaderSurface({
  config,
  playing,
  preview = false,
  webGlSupported = true,
  onRendererStatusChange,
}: ZenShaderSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const paperMountRef = useRef<PaperShaderElement>(null);
  const palette = useZenThemePalette();
  const layouts = useZenShaderLayouts(surfaceRef);

  // Keep the shader variants and packed UI buffer on a high-water capacity so
  // transient surface removal cannot replace the renderer during panel exit.
  const requiredUiSurfaceCapacity = zenUiSurfaceVariantCapacity(
    layouts.uiSurfaces.length,
  );
  const uiSurfaceCapacityRef = useRef(INITIAL_UI_SURFACE_CAPACITY);
  if (requiredUiSurfaceCapacity > uiSurfaceCapacityRef.current) {
    uiSurfaceCapacityRef.current = requiredUiSurfaceCapacity;
  }
  const uiSurfaceCapacity = uiSurfaceCapacityRef.current;
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
  const sceneFragment = useMemo(
    () => buildZenMultipassSceneFragment(resolved.fragmentShader),
    [resolved.fragmentShader],
  );
  const compositeFragment = useMemo(
    () => buildZenMultipassCompositeFragment(uiSurfaceCapacity),
    [uiSurfaceCapacity],
  );
  const sceneUniforms = useMemo(
    () => ({
      ...resolved.uniforms,
      ...buildZenMultipassSceneUniforms(config),
    }),
    [config, resolved.uniforms],
  );
  const preparedSceneUniforms = usePreparedZenShaderUniforms(sceneUniforms);
  const compositeUniforms = useMemo(
    () =>
      buildZenMultipassCompositeUniforms(
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
    [config, layouts, palette, surfaceUniformBuffer],
  );

  const mountKey = `${config.shader}:${uiSurfaceCapacity}`;
  const definition = getPaperShaderDefinition(config.shader);
  const [readyMountKey, setReadyMountKey] = useState<string | null>(null);
  const [lostMountKey, setLostMountKey] = useState<string | null>(null);
  const shaderReady =
    webGlSupported && readyMountKey === mountKey && lostMountKey !== mountKey;
  const rendererStatus: ZenShaderRendererStatus = !webGlSupported
    ? "fallback-unsupported"
    : lostMountKey === mountKey
      ? "fallback-context-lost"
      : shaderReady
        ? "webgl"
        : "initializing";

  // Keep the parent CSS topology in the same paint as mount-key changes.
  // A passive update would briefly restore per-surface fallback filters while
  // the replacement compositor is still settling.
  useLayoutEffect(() => {
    onRendererStatusChange?.(rendererStatus);
  }, [onRendererStatusChange, rendererStatus]);

  useEffect(() => {
    if (
      !webGlSupported ||
      preparedSceneUniforms === null ||
      lostMountKey === mountKey
    ) {
      return;
    }
    let frameId: number | null = null;
    let cancelled = false;
    const observeFirstDraw = () => {
      if (cancelled) return;
      const stats =
        paperMountRef.current?.paperShaderMount?.getPerformanceStats();
      if (stats?.isStaticFrameReady) {
        setReadyMountKey(mountKey);
        return;
      }
      frameId = requestAnimationFrame(observeFirstDraw);
    };
    frameId = requestAnimationFrame(observeFirstDraw);
    return () => {
      cancelled = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [lostMountKey, mountKey, preparedSceneUniforms, webGlSupported]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      setReadyMountKey(null);
      setLostMountKey(mountKey);
    };
    surface.addEventListener("webglcontextlost", handleContextLost, true);
    return () => {
      surface.removeEventListener("webglcontextlost", handleContextLost, true);
    };
  }, [mountKey]);

  const animationSpeed = config.speed / 100;
  const shouldAnimate =
    preparedSceneUniforms !== null &&
    shaderReady &&
    playing &&
    definition.animated &&
    animationSpeed > 0;
  useZenShaderAnimation(paperMountRef, {
    playing: shouldAnimate,
    speed: animationSpeed,
    resetKey: config.shader,
  });

  const resolvedMaxPixelCount = resolved.maxPixelCount;
  const maxPixelCount = preview
    ? PREVIEW_PIXEL_BUDGET
    : Math.min(
        resolvedMaxPixelCount ?? LIVE_BACKGROUND_PIXEL_BUDGET,
        LIVE_BACKGROUND_PIXEL_BUDGET,
      );
  const ownsGpuGlass =
    shaderReady &&
    !preview &&
    config.glass.enabled &&
    hasZenGlassRegion(layouts.glass, layouts.uiSurfaces);

  return (
    <div
      ref={surfaceRef}
      data-zen-shader-surface
      data-zen-shader-preview={preview ? "true" : "false"}
      data-zen-shader-ready={preparedSceneUniforms ? "true" : "false"}
      data-zen-shader-renderer={rendererStatus}
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
      data-ui-glass-surface-count={
        layouts.uiSurfaces.filter(({ refracts }) => refracts !== false).length
      }
      data-ui-contrast-surface-count={layouts.uiSurfaces.length}
      className="zen-shader-surface absolute inset-0 overflow-hidden"
      style={{
        // The final GPU pass already composites the configured opacity against
        // the theme backdrop. Do not apply it again after contrast correction.
        opacity: shaderReady ? 1 : config.opacity / 100,
        background: `linear-gradient(135deg, ${palette.colors[0]}, ${palette.colors[1]})`,
      }}
    >
      {webGlSupported && lostMountKey !== mountKey && preparedSceneUniforms && (
        <ZenMultipassCanvas
          key={mountKey}
          ref={paperMountRef}
          data-paper-shader={config.shader}
          data-zen-glass-compositor={ownsGpuGlass ? "true" : undefined}
          sceneFragment={sceneFragment}
          sceneUniforms={preparedSceneUniforms}
          compositeFragment={compositeFragment}
          compositeUniforms={compositeUniforms}
          mipmaps={resolved.mipmaps}
          speed={0}
          minPixelRatio={LIVE_BACKGROUND_MIN_PIXEL_RATIO}
          maxPixelCount={maxPixelCount}
          webGlContextAttributes={LIVE_WEBGL_CONTEXT_ATTRIBUTES}
          className="pointer-events-none absolute inset-0 overflow-hidden"
        />
      )}
    </div>
  );
}
