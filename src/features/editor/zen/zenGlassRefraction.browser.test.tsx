import { render, waitFor } from "@testing-library/react";
import { isPaperShaderElement } from "@paper-design/shaders";
import { ShaderMount } from "@paper-design/shaders-react";
import { describe, expect, it } from "vitest";
import {
  PAPER_SHADER_IDS,
  resolvePaperShaderMount,
  type PaperShaderId,
} from "./paperShaderCatalog";
import {
  buildZenPostProcessUniforms,
  buildZenPostProcessedFragment,
} from "./zenPostProcessing";
import type { ZenContrastGuardRect } from "./zenContrastGuard";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";

const GRADIENT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_objectUV;
out vec4 fragColor;
void main() {
  fragColor = vec4(v_objectUV.x + 0.5, v_objectUV.y + 0.5, 0.0, 1.0);
}`;

const SIZING_UNIFORMS = {
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

function RefractionProbe({
  name,
  refraction,
  glassRect = [0.2, 0.2, 0.8, 0.8],
}: {
  name: string;
  refraction: number;
  glassRect?: ZenContrastGuardRect;
}) {
  const config = {
    ...ZEN_SHADER_DEFAULTS,
    opacity: 100,
    contrastGuard: { mode: "none" as const, strength: 1 },
    glass: {
      ...ZEN_SHADER_DEFAULTS.glass,
      enabled: refraction > 0,
      refraction,
    },
  };
  const uniforms = {
    ...SIZING_UNIFORMS,
    ...buildZenPostProcessUniforms(config, {
      rect: [0.4, 0.4, 0.6, 0.6],
      feather: [0.02, 0.02, 0.02, 0.02],
      glassRect,
      textColor: [1, 1, 1],
      backdropColor: [0, 0, 0],
    }),
  };

  return (
    <ShaderMount
      data-refraction-probe={name}
      fragmentShader={buildZenPostProcessedFragment(GRADIENT_FRAGMENT)}
      uniforms={uniforms}
      width={200}
      height={120}
      minPixelRatio={1}
      maxPixelCount={24_000}
      speed={0}
      frame={0}
      webGlContextAttributes={{
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
      }}
    />
  );
}

function pixelAt(canvas: HTMLCanvasElement, u: number, v: number) {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("WebGL2 context unavailable");
  const pixel = new Uint8Array(4);
  gl.readPixels(
    Math.floor(canvas.width * u),
    Math.floor(canvas.height * v),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixel,
  );
  return pixel;
}

function PaperCompileProbe({ shader }: { shader: PaperShaderId }) {
  const resolved = resolvePaperShaderMount(shader, {
    width: 64,
    height: 64,
  });
  const config = {
    ...ZEN_SHADER_DEFAULTS,
    shader,
    contrastGuard: { mode: "none" as const, strength: 1 },
    glass: {
      ...ZEN_SHADER_DEFAULTS.glass,
      enabled: true,
      refraction: 24,
    },
  };

  return (
    <ShaderMount
      {...resolved}
      data-paper-compile-probe={shader}
      fragmentShader={buildZenPostProcessedFragment(resolved.fragmentShader)}
      uniforms={{
        ...resolved.uniforms,
        ...buildZenPostProcessUniforms(config, {
          rect: [0.4, 0.4, 0.6, 0.6],
          feather: [0.02, 0.02, 0.02, 0.02],
          glassRect: [0.2, 0.2, 0.8, 0.8],
          textColor: [1, 1, 1],
          backdropColor: [0, 0, 0],
        }),
      }}
      width={64}
      height={64}
      minPixelRatio={1}
      maxPixelCount={4_096}
      speed={0}
      frame={0}
    />
  );
}

describe("Zen glass refraction (real Chromium WebGL)", () => {
  it("bends the shader at the Editor edge while leaving its center stationary", async () => {
    const { container } = render(
      <div>
        <RefractionProbe name="flat" refraction={0} />
        <RefractionProbe name="bent" refraction={24} />
      </div>,
    );

    await waitFor(() => {
      for (const name of ["flat", "bent"]) {
        const canvas = container.querySelector<HTMLCanvasElement>(
          `[data-refraction-probe="${name}"] canvas`,
        );
        expect(canvas?.width).toBeGreaterThan(0);
        expect(canvas?.height).toBeGreaterThan(0);
      }
    });

    const flat = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="flat"] canvas',
    )!;
    const bent = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="bent"] canvas',
    )!;
    const flatEdge = pixelAt(flat, 0.21, 0.5);
    const bentEdge = pixelAt(bent, 0.21, 0.5);
    const flatCenter = pixelAt(flat, 0.5, 0.5);
    const bentCenter = pixelAt(bent, 0.5, 0.5);

    expect(Math.abs(bentEdge[0] - flatEdge[0])).toBeGreaterThan(16);
    expect(Math.abs(bentCenter[0] - flatCenter[0])).toBeLessThanOrEqual(1);
    expect(Math.abs(bentCenter[1] - flatCenter[1])).toBeLessThanOrEqual(1);
  });

  it("keeps the full-surface Editor boundary refractive in Zen", async () => {
    const fullRect: ZenContrastGuardRect = [0, 0, 1, 1];
    const { container } = render(
      <div>
        <RefractionProbe name="zen-flat" refraction={0} glassRect={fullRect} />
        <RefractionProbe name="zen-bent" refraction={24} glassRect={fullRect} />
      </div>,
    );

    await waitFor(() => {
      expect(
        container.querySelector<HTMLCanvasElement>(
          '[data-refraction-probe="zen-bent"] canvas',
        )?.width,
      ).toBeGreaterThan(0);
    });

    const flat = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="zen-flat"] canvas',
    )!;
    const bent = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="zen-bent"] canvas',
    )!;

    expect(
      Math.abs(pixelAt(bent, 0.1, 0.5)[0] - pixelAt(flat, 0.1, 0.5)[0]),
    ).toBeGreaterThan(12);
  });

  it("compiles the refraction pass for every Paper background", async () => {
    for (const shader of PAPER_SHADER_IDS) {
      const view = render(<PaperCompileProbe shader={shader} />);
      await waitFor(
        () => {
          const host = view.container.querySelector<HTMLElement>(
            `[data-paper-compile-probe="${shader}"]`,
          );
          expect(host).not.toBeNull();
          expect(isPaperShaderElement(host!)).toBe(true);
          expect(host?.querySelector("canvas")).not.toBeNull();
        },
        { timeout: 2_000 },
      );
      view.unmount();
    }
  }, 30_000);
});
