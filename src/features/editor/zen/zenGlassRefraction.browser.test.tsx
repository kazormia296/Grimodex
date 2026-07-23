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
import type { ZenGlassLayout } from "./useZenShaderLayouts";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";

const GRADIENT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_objectUV;
out vec4 fragColor;
void main() {
  fragColor = vec4(v_objectUV.x + 0.5, v_objectUV.y + 0.5, 0.0, 1.0);
}`;

const CONTRAST_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.45, 0.45, 0.45, 1.0);
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
  glassCornerRadius = 0,
  uiSurfaces = [],
}: {
  name: string;
  refraction: number;
  glassRect?: ZenContrastGuardRect;
  glassCornerRadius?: number;
  uiSurfaces?: readonly ZenGlassLayout[];
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
      glassCornerRadius,
      uiSurfaces,
      textColor: [1, 1, 1],
      uiTextColor: [1, 1, 1],
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

const DISJOINT_UI_SURFACES = [
  {
    rect: [0.1, 0.1, 0.3, 0.9],
    feather: [0, 0, 0, 0],
    cornerRadius: 12,
  },
  {
    rect: [0.7, 0.1, 0.9, 0.9],
    feather: [0, 0, 0, 0],
    cornerRadius: 12,
  },
] satisfies readonly ZenGlassLayout[];

function UiContrastProbe({
  name,
  enabled,
}: {
  name: string;
  enabled: boolean;
}) {
  const config = {
    ...ZEN_SHADER_DEFAULTS,
    opacity: 100,
    contrastGuard: {
      mode: enabled ? ("auto" as const) : ("none" as const),
      strength: 1,
    },
    glass: {
      ...ZEN_SHADER_DEFAULTS.glass,
      enabled: false,
      refraction: 0,
    },
  };
  return (
    <ShaderMount
      data-ui-contrast-probe={name}
      fragmentShader={buildZenPostProcessedFragment(CONTRAST_FRAGMENT)}
      uniforms={{
        ...SIZING_UNIFORMS,
        ...buildZenPostProcessUniforms(config, {
          rect: [0.45, 0.4, 0.55, 0.6],
          feather: [0, 0, 0, 0],
          glassRect: [0, 0, 0, 0],
          glassCornerRadius: 0,
          uiSurfaces: DISJOINT_UI_SURFACES,
          textColor: [0, 0, 0],
          uiTextColor: [1, 1, 1],
          backdropColor: [0, 0, 0],
        }),
      }}
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

function LowOpacityContrastProbe({
  name,
  enabled,
}: {
  name: string;
  enabled: boolean;
}) {
  const config = {
    ...ZEN_SHADER_DEFAULTS,
    opacity: 10,
    contrastGuard: {
      mode: enabled ? ("auto" as const) : ("none" as const),
      strength: 1,
    },
    glass: {
      ...ZEN_SHADER_DEFAULTS.glass,
      enabled: false,
      refraction: 0,
    },
  };

  return (
    <ShaderMount
      data-low-opacity-contrast-probe={name}
      fragmentShader={buildZenPostProcessedFragment(CONTRAST_FRAGMENT)}
      uniforms={{
        ...SIZING_UNIFORMS,
        ...buildZenPostProcessUniforms(config, {
          rect: [0.4, 0.4, 0.6, 0.6],
          feather: [0.1, 0, 0.1, 0],
          glassRect: [0, 0, 0, 0],
          glassCornerRadius: 0,
          textColor: [0, 0, 0],
          backdropColor: [0, 0, 0],
        }),
      }}
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
          glassCornerRadius: 0,
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

    const flatRightEdge = pixelAt(flat, 0.79, 0.5);
    const bentRightEdge = pixelAt(bent, 0.79, 0.5);
    expect(bentRightEdge[0]).toBeLessThan(flatRightEdge[0] - 16);
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
    ).toBeGreaterThan(4);
  });

  it("keeps refraction on the rounded Editor perimeter at corners", async () => {
    const { container } = render(
      <div>
        <RefractionProbe
          name="round-flat"
          refraction={0}
          glassCornerRadius={20}
        />
        <RefractionProbe
          name="round-bent"
          refraction={24}
          glassCornerRadius={20}
        />
      </div>,
    );

    await waitFor(() => {
      for (const name of ["round-flat", "round-bent"]) {
        expect(
          container.querySelector<HTMLCanvasElement>(
            `[data-refraction-probe="${name}"] canvas`,
          )?.width,
        ).toBeGreaterThan(0);
      }
    });

    const flat = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="round-flat"] canvas',
    )!;
    const bent = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="round-bent"] canvas',
    )!;
    const outsideCorner = [0.21, 0.21] as const;
    const insideCorner = [0.23, 0.27] as const;

    for (const channel of [0, 1] as const) {
      expect(
        Math.abs(
          pixelAt(bent, ...outsideCorner)[channel] -
            pixelAt(flat, ...outsideCorner)[channel],
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          pixelAt(bent, ...insideCorner)[channel] -
            pixelAt(flat, ...insideCorner)[channel],
        ),
      ).toBeGreaterThan(6);
    }
  });

  it("refracts each disjoint UI surface while leaving the gap unchanged", async () => {
    const emptyEditorRect: ZenContrastGuardRect = [0, 0, 0, 0];
    const { container } = render(
      <div>
        <RefractionProbe
          name="ui-flat"
          refraction={0}
          glassRect={emptyEditorRect}
          uiSurfaces={DISJOINT_UI_SURFACES}
        />
        <RefractionProbe
          name="ui-bent"
          refraction={24}
          glassRect={emptyEditorRect}
          uiSurfaces={DISJOINT_UI_SURFACES}
        />
      </div>,
    );

    await waitFor(() => {
      expect(
        container.querySelector<HTMLCanvasElement>(
          '[data-refraction-probe="ui-bent"] canvas',
        )?.width,
      ).toBeGreaterThan(0);
    });

    const flat = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="ui-flat"] canvas',
    )!;
    const bent = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="ui-bent"] canvas',
    )!;

    expect(
      Math.abs(pixelAt(bent, 0.11, 0.5)[0] - pixelAt(flat, 0.11, 0.5)[0]),
    ).toBeGreaterThan(10);
    expect(
      Math.abs(pixelAt(bent, 0.89, 0.5)[0] - pixelAt(flat, 0.89, 0.5)[0]),
    ).toBeGreaterThan(10);
    expect(
      Math.abs(pixelAt(bent, 0.5, 0.25)[0] - pixelAt(flat, 0.5, 0.25)[0]),
    ).toBeLessThanOrEqual(1);
  });

  it("guards UI surfaces and Editor paper independently without filling the gap", async () => {
    const { container } = render(
      <div>
        <UiContrastProbe name="unguarded" enabled={false} />
        <UiContrastProbe name="guarded" enabled />
      </div>,
    );

    await waitFor(() => {
      expect(
        container.querySelector<HTMLCanvasElement>(
          '[data-ui-contrast-probe="guarded"] canvas',
        )?.width,
      ).toBeGreaterThan(0);
    });

    const unguarded = container.querySelector<HTMLCanvasElement>(
      '[data-ui-contrast-probe="unguarded"] canvas',
    )!;
    const guarded = container.querySelector<HTMLCanvasElement>(
      '[data-ui-contrast-probe="guarded"] canvas',
    )!;

    expect(
      Math.abs(pixelAt(guarded, 0.2, 0.5)[0] - pixelAt(unguarded, 0.2, 0.5)[0]),
    ).toBeGreaterThan(20);
    expect(
      Math.abs(pixelAt(guarded, 0.5, 0.5)[0] - pixelAt(unguarded, 0.5, 0.5)[0]),
    ).toBeGreaterThan(20);
    expect(
      Math.abs(
        pixelAt(guarded, 0.38, 0.5)[0] - pixelAt(unguarded, 0.38, 0.5)[0],
      ),
    ).toBeLessThanOrEqual(1);
    expect(pixelAt(guarded, 0.2, 0.5)[0]).toBeLessThan(
      pixelAt(unguarded, 0.2, 0.5)[0] - 20,
    );
    expect(pixelAt(guarded, 0.5, 0.5)[0]).toBeGreaterThan(
      pixelAt(unguarded, 0.5, 0.5)[0] + 20,
    );
  });

  it("keeps the Editor feather gradual at low shader opacity", async () => {
    const { container } = render(
      <div>
        <LowOpacityContrastProbe name="unguarded" enabled={false} />
        <LowOpacityContrastProbe name="guarded" enabled />
      </div>,
    );

    await waitFor(() => {
      expect(
        container.querySelector<HTMLCanvasElement>(
          '[data-low-opacity-contrast-probe="guarded"] canvas',
        )?.width,
      ).toBeGreaterThan(0);
    });

    const guarded = container.querySelector<HTMLCanvasElement>(
      '[data-low-opacity-contrast-probe="guarded"] canvas',
    )!;
    const outside = pixelAt(guarded, 0.25, 0.5)[0];
    const feather = pixelAt(guarded, 0.35, 0.5)[0];
    const center = pixelAt(guarded, 0.5, 0.5)[0];

    expect(feather).toBeGreaterThan(outside + 20);
    expect(feather).toBeLessThan(center - 20);
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
