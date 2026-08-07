import { createRef } from "react";
import { act, render, waitFor } from "@testing-library/react";
import type {
  PaperShaderElement,
  ShaderMountUniforms,
} from "@paper-design/shaders";
import { describe, expect, it } from "vitest";
import { ZenMultipassCanvas } from "./ZenMultipassCanvas";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import {
  buildZenMultipassCompositeFragment,
  buildZenMultipassCompositeUniforms,
  ZEN_MULTIPASS_FULLSCREEN_VERTEX,
} from "./zenMultipassPipeline";

const SCENE_VERTEX_UNIFORMS: ShaderMountUniforms = {
  u_fit: 2,
  u_scale: 1,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
  u_imageAspectRatio: 1,
};

const TIME_SCENE_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_time;
out vec4 fragColor;
void main() {
  fragColor = vec4(fract(u_time), 0.0, 0.0, 1.0);
}`;

const CONSTANT_SCENE_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.5, 0.5, 0.5, 1.0);
}`;

const GAIN_COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sceneTexture;
uniform float u_gain;
void main() {
  fragColor = vec4(texture(u_sceneTexture, v_uv).rgb * u_gain, 1.0);
}`;

function readCenterPixel(container: HTMLElement) {
  const canvas = container.querySelector("canvas");
  expect(canvas).toBeInstanceOf(HTMLCanvasElement);
  const gl = canvas?.getContext("webgl2");
  expect(gl).not.toBeNull();
  const pixel = new Uint8Array(4);
  gl?.readPixels(
    Math.floor((canvas?.width ?? 1) / 2),
    Math.floor((canvas?.height ?? 1) / 2),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixel,
  );
  return pixel;
}

async function waitForDraw(
  ref: React.RefObject<PaperShaderElement | null>,
  minimum: number,
) {
  await waitFor(() => {
    expect(
      ref.current?.paperShaderMount?.getPerformanceStats().drawCount ?? 0,
    ).toBeGreaterThanOrEqual(minimum);
  });
}

const contextAttributes = {
  alpha: false,
  antialias: false,
  preserveDrawingBuffer: true,
} satisfies WebGLContextAttributes;

describe("ZenMultipassCanvas runtime updates", () => {
  it("redraws an animated Paper scene when the shared scheduler advances its frame", async () => {
    const ref = createRef<PaperShaderElement>();
    const view = render(
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="frame-probe"
        sceneFragment={TIME_SCENE_FRAGMENT}
        sceneUniforms={SCENE_VERTEX_UNIFORMS}
        compositeFragment={GAIN_COMPOSITE_FRAGMENT}
        compositeUniforms={{ u_gain: 1 }}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        webGlContextAttributes={contextAttributes}
        style={{ position: "relative", width: 64, height: 64 }}
      />,
    );

    await waitForDraw(ref, 1);
    const initialDrawCount =
      ref.current?.paperShaderMount?.getPerformanceStats().drawCount ?? 0;
    const initial = readCenterPixel(view.container);

    act(() => {
      ref.current?.paperShaderMount?.setFrame(500);
    });
    await waitForDraw(ref, initialDrawCount + 1);
    const advanced = readCenterPixel(view.container);

    expect(initial[0]).toBeLessThan(8);
    expect(advanced[0]).toBeGreaterThan(96);
  });

  it("redraws the final pass when live contrast uniforms change", async () => {
    const ref = createRef<PaperShaderElement>();
    const surfaceBuffer = new ZenUiSurfaceUniformBuffer(1);
    const compositeFragment = buildZenMultipassCompositeFragment(1);
    const runtime = {
      rect: [0, 0, 1, 1] as [number, number, number, number],
      feather: [0, 0, 0, 0] as [number, number, number, number],
      glassRect: [0, 0, 0, 0] as [number, number, number, number],
      glassCornerRadius: 0,
      uiSurfaces: [],
      textColor: [1, 1, 1] as [number, number, number],
      uiTextColor: [1, 1, 1] as [number, number, number],
      backdropColor: [0, 0, 0] as [number, number, number],
    };
    const weakConfig = {
      ...ZEN_SHADER_DEFAULTS,
      opacity: 100,
      glass: {
        ...ZEN_SHADER_DEFAULTS.glass,
        enabled: false,
        blur: 0,
        refraction: 0,
      },
      contrastGuard: {
        ...ZEN_SHADER_DEFAULTS.contrastGuard,
        mode: "auto" as const,
        strength: 0,
      },
    };
    const strongConfig = {
      ...weakConfig,
      contrastGuard: { ...weakConfig.contrastGuard, strength: 1 },
    };
    const view = render(
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="contrast-probe"
        sceneFragment={CONSTANT_SCENE_FRAGMENT}
        sceneUniforms={SCENE_VERTEX_UNIFORMS}
        compositeFragment={compositeFragment}
        compositeUniforms={buildZenMultipassCompositeUniforms(
          weakConfig,
          runtime,
          surfaceBuffer,
        )}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        webGlContextAttributes={contextAttributes}
        style={{ position: "relative", width: 64, height: 64 }}
      />,
    );

    await waitForDraw(ref, 1);
    const weak = readCenterPixel(view.container);
    const initialDrawCount =
      ref.current?.paperShaderMount?.getPerformanceStats().drawCount ?? 0;

    view.rerender(
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="contrast-probe"
        sceneFragment={CONSTANT_SCENE_FRAGMENT}
        sceneUniforms={SCENE_VERTEX_UNIFORMS}
        compositeFragment={compositeFragment}
        compositeUniforms={buildZenMultipassCompositeUniforms(
          strongConfig,
          runtime,
          surfaceBuffer,
        )}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        webGlContextAttributes={contextAttributes}
        style={{ position: "relative", width: 64, height: 64 }}
      />,
    );

    await waitForDraw(ref, initialDrawCount + 1);
    const strong = readCenterPixel(view.container);

    expect(strong[0]).toBeLessThan(weak[0] - 12);
  });

  it("keeps the fullscreen vertex contract available to focused renderer tests", () => {
    expect(ZEN_MULTIPASS_FULLSCREEN_VERTEX).toContain("out vec2 v_uv");
  });
});
