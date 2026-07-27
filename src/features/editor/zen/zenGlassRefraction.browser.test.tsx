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

const BLACK_CONTRAST_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.0, 0.0, 0.0, 1.0);
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
  maxPixelCount = 24_000,
  width = 200,
  height = 120,
}: {
  name: string;
  refraction: number;
  glassRect?: ZenContrastGuardRect;
  glassCornerRadius?: number;
  uiSurfaces?: readonly ZenGlassLayout[];
  maxPixelCount?: number;
  width?: number;
  height?: number;
}) {
  const config = {
    ...ZEN_SHADER_DEFAULTS,
    opacity: 100,
    contrastGuard: { mode: "none" as const, strength: 1, toolMix: 0.5 },
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
      width={width}
      height={height}
      minPixelRatio={1}
      maxPixelCount={maxPixelCount}
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
  uiTextColor,
  backdropColor,
  toolMix = 0.5,
  strength = 1,
  opacity = 10,
  fragmentShader = CONTRAST_FRAGMENT,
}: {
  name: string;
  enabled: boolean;
  uiTextColor: [number, number, number];
  backdropColor: [number, number, number];
  toolMix?: number;
  strength?: number;
  opacity?: number;
  fragmentShader?: string;
}) {
  const config = {
    ...ZEN_SHADER_DEFAULTS,
    opacity,
    contrastGuard: {
      mode: enabled ? ("auto" as const) : ("none" as const),
      strength,
      toolMix,
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
      fragmentShader={buildZenPostProcessedFragment(fragmentShader)}
      uniforms={{
        ...SIZING_UNIFORMS,
        ...buildZenPostProcessUniforms(config, {
          rect: [0.45, 0.4, 0.55, 0.6],
          feather: [0, 0, 0, 0],
          glassRect: [0, 0, 0, 0],
          glassCornerRadius: 0,
          uiSurfaces: DISJOINT_UI_SURFACES,
          textColor: [0, 0, 0],
          uiTextColor,
          backdropColor,
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
      toolMix: 0.5,
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

function expectShaderDrawn(container: HTMLElement, selector: string) {
  const host = container.querySelector<HTMLElement>(selector);
  expect(host).not.toBeNull();
  if (!host) return;
  expect(isPaperShaderElement(host)).toBe(true);
  if (!isPaperShaderElement(host)) return;
  const canvas = host.querySelector("canvas");
  expect(canvas).not.toBeNull();
  if (!canvas) return;
  expect(canvas.width).toBeGreaterThan(0);
  expect(canvas.height).toBeGreaterThan(0);
  const mount = host.paperShaderMount;
  expect(mount).toBeDefined();
  if (!mount) return;
  expect(mount.getPerformanceStats().drawCount).toBeGreaterThan(1);
}

function shaderRgb(
  red: number,
  green: number,
  blue: number,
): [number, number, number] {
  return [red / 0xff, green / 0xff, blue / 0xff];
}

function PaperCompileProbe({ shader }: { shader: PaperShaderId }) {
  const resolved = resolvePaperShaderMount(shader, {
    width: 64,
    height: 64,
  });
  const config = {
    ...ZEN_SHADER_DEFAULTS,
    shader,
    contrastGuard: { mode: "none" as const, strength: 1, toolMix: 0.5 },
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
        expectShaderDrawn(container, `[data-refraction-probe="${name}"]`);
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
      expectShaderDrawn(container, '[data-refraction-probe="zen-bent"]');
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

  it("follows the rounded SDF normal at a corner", async () => {
    const { container } = render(
      <div>
        <RefractionProbe
          name="normal-flat"
          refraction={0}
          glassCornerRadius={20}
        />
        <RefractionProbe
          name="normal-bent"
          refraction={24}
          glassCornerRadius={20}
        />
      </div>,
    );

    await waitFor(() => {
      expectShaderDrawn(container, '[data-refraction-probe="normal-bent"]');
    });

    const flat = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="normal-flat"] canvas',
    )!;
    const bent = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="normal-bent"] canvas',
    )!;
    const flatCorner = pixelAt(flat, 0.25, 0.25);
    const bentCorner = pixelAt(bent, 0.25, 0.25);
    const redDelta = bentCorner[0] - flatCorner[0];
    const greenDelta = bentCorner[1] - flatCorner[1];

    expect(redDelta).toBeGreaterThan(4);
    expect(greenDelta).toBeGreaterThan(redDelta);
  });

  it("keeps the rounded normal non-zero near a large surface's corner core", async () => {
    const width = 1_000;
    const height = 600;
    const { container } = render(
      <div>
        <RefractionProbe
          name="large-normal-flat"
          refraction={0}
          glassCornerRadius={20}
          width={width}
          height={height}
          maxPixelCount={width * height}
        />
        <RefractionProbe
          name="large-normal-bent"
          refraction={75}
          glassCornerRadius={20}
          width={width}
          height={height}
          maxPixelCount={width * height}
        />
      </div>,
    );

    await waitFor(() => {
      expectShaderDrawn(
        container,
        '[data-refraction-probe="large-normal-bent"]',
      );
      expect(
        container.querySelector<HTMLCanvasElement>(
          '[data-refraction-probe="large-normal-bent"] canvas',
        )?.width,
      ).toBe(width);
    });

    const flat = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="large-normal-flat"] canvas',
    )!;
    const bent = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="large-normal-bent"] canvas',
    )!;
    const coreCorner = [0.218, 139 / height] as const;

    expect(bent.width / bent.clientWidth).toBeGreaterThanOrEqual(1);
    expect(
      Math.abs(
        pixelAt(bent, ...coreCorner)[0] - pixelAt(flat, ...coreCorner)[0],
      ),
    ).toBeGreaterThan(2);
  });

  it("softens rounded boundaries and limits small-surface displacement", async () => {
    const { container } = render(
      <div>
        <RefractionProbe
          name="diagnostic-flat"
          refraction={0}
          glassCornerRadius={20}
        />
        <RefractionProbe
          name="diagnostic-bent"
          refraction={24}
          glassCornerRadius={20}
        />
        <RefractionProbe
          name="small-flat"
          refraction={0}
          glassRect={[0.1, 0.25, 0.25, 0.5]}
          glassCornerRadius={15}
        />
        <RefractionProbe
          name="small-bent"
          refraction={24}
          glassRect={[0.1, 0.25, 0.25, 0.5]}
          glassCornerRadius={15}
        />
      </div>,
    );

    await waitFor(() => {
      for (const name of [
        "diagnostic-flat",
        "diagnostic-bent",
        "small-flat",
        "small-bent",
      ]) {
        expectShaderDrawn(container, `[data-refraction-probe="${name}"]`);
      }
    });

    const flat = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="diagnostic-flat"] canvas',
    )!;
    const bent = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="diagnostic-bent"] canvas',
    )!;
    const flatCornerBoundary = pixelAt(flat, 0.24, 0.24);
    const bentCornerBoundary = pixelAt(bent, 0.24, 0.24);
    expect(
      Math.max(
        Math.abs(bentCornerBoundary[0] - flatCornerBoundary[0]),
        Math.abs(bentCornerBoundary[1] - flatCornerBoundary[1]),
      ),
    ).toBeLessThanOrEqual(10);
    const smallFlat = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="small-flat"] canvas',
    )!;
    const smallBent = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="small-bent"] canvas',
    )!;
    const smallSamples = [
      [0.105, 0.375],
      [0.115, 0.375],
      [0.125, 0.375],
      [0.13, 0.3],
      [0.14, 0.29],
      [0.15, 0.28],
      [0.175, 0.28],
    ] as const;
    const smallBoundaryDeltas = smallSamples.map(([u, v]) => {
      const before = pixelAt(smallFlat, u, v);
      const after = pixelAt(smallBent, u, v);
      return Math.abs(after[0] - before[0]);
    });
    expect(Math.max(...smallBoundaryDeltas)).toBeLessThanOrEqual(12);

    const cornerTransitionDeltas = [0.34, 0.35, 0.36, 0.37, 0.38].map((v) =>
      Math.abs(pixelAt(bent, 0.22, v)[0] - pixelAt(flat, 0.22, v)[0]),
    );
    const maximumAdjacentStep = Math.max(
      ...cornerTransitionDeltas
        .slice(1)
        .map((value, index) => Math.abs(value - cornerTransitionDeltas[index])),
    );
    expect(maximumAdjacentStep).toBeLessThanOrEqual(3);
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
        expectShaderDrawn(container, `[data-refraction-probe="${name}"]`);
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
      expectShaderDrawn(container, '[data-refraction-probe="ui-bent"]');
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

  it("keeps CSS-sized UI corners aligned when the canvas is pixel-capped", async () => {
    const emptyEditorRect: ZenContrastGuardRect = [0, 0, 0, 0];
    const leftSurface = [DISJOINT_UI_SURFACES[0]];
    const { container } = render(
      <div>
        <RefractionProbe
          name="capped-flat"
          refraction={0}
          glassRect={emptyEditorRect}
          uiSurfaces={leftSurface}
          maxPixelCount={6_000}
        />
        <RefractionProbe
          name="capped-bent"
          refraction={24}
          glassRect={emptyEditorRect}
          uiSurfaces={leftSurface}
          maxPixelCount={6_000}
        />
      </div>,
    );

    await waitFor(() => {
      expectShaderDrawn(container, '[data-refraction-probe="capped-bent"]');
      expect(
        container.querySelector<HTMLCanvasElement>(
          '[data-refraction-probe="capped-bent"] canvas',
        )?.width,
      ).toBe(100);
    });

    const flat = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="capped-flat"] canvas',
    )!;
    const bent = container.querySelector<HTMLCanvasElement>(
      '[data-refraction-probe="capped-bent"] canvas',
    )!;
    const outsideCorner = [0.105, 0.11] as const;
    const insideCssRadius = [0.115, 0.14] as const;

    expect(
      Math.abs(
        pixelAt(bent, ...outsideCorner)[0] - pixelAt(flat, ...outsideCorner)[0],
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        pixelAt(bent, ...insideCssRadius)[0] -
          pixelAt(flat, ...insideCssRadius)[0],
      ),
    ).toBeGreaterThan(4);
  });

  it("softly guards dark and light UI surfaces without weakening the Editor guard", async () => {
    const { container } = render(
      <div>
        <UiContrastProbe
          name="dark-unguarded"
          enabled={false}
          uiTextColor={[1, 1, 1]}
          backdropColor={[0.4, 0.4, 0.4]}
        />
        <UiContrastProbe
          name="dark-guarded"
          enabled
          uiTextColor={[1, 1, 1]}
          backdropColor={[0.4, 0.4, 0.4]}
        />
        <UiContrastProbe
          name="dark-tool-off"
          enabled
          uiTextColor={[1, 1, 1]}
          backdropColor={[0.4, 0.4, 0.4]}
          toolMix={0}
        />
        <UiContrastProbe
          name="dark-tool-max"
          enabled
          uiTextColor={[1, 1, 1]}
          backdropColor={[0.4, 0.4, 0.4]}
          toolMix={0.75}
        />
        <UiContrastProbe
          name="light-unguarded"
          enabled={false}
          uiTextColor={[0.35, 0.35, 0.35]}
          backdropColor={[0.9, 0.9, 0.9]}
        />
        <UiContrastProbe
          name="light-guarded"
          enabled
          uiTextColor={[0.35, 0.35, 0.35]}
          backdropColor={[0.9, 0.9, 0.9]}
        />
      </div>,
    );

    await waitFor(() => {
      for (const name of [
        "dark-unguarded",
        "dark-guarded",
        "dark-tool-off",
        "dark-tool-max",
        "light-unguarded",
        "light-guarded",
      ]) {
        expectShaderDrawn(container, `[data-ui-contrast-probe="${name}"]`);
      }
    });

    const cases = [
      {
        guarded: "dark-guarded",
        unguarded: "dark-unguarded",
        direction: -1,
      },
      {
        guarded: "light-guarded",
        unguarded: "light-unguarded",
        direction: 1,
      },
    ] as const;

    for (const testCase of cases) {
      const unguarded = container.querySelector<HTMLCanvasElement>(
        `[data-ui-contrast-probe="${testCase.unguarded}"] canvas`,
      )!;
      const guarded = container.querySelector<HTMLCanvasElement>(
        `[data-ui-contrast-probe="${testCase.guarded}"] canvas`,
      )!;
      const uiDelta =
        pixelAt(guarded, 0.2, 0.5)[0] - pixelAt(unguarded, 0.2, 0.5)[0];

      expect(Math.sign(uiDelta)).toBe(testCase.direction);
      expect(Math.abs(uiDelta)).toBeGreaterThan(20);
      expect(Math.abs(uiDelta)).toBeLessThan(100);
      expect(
        Math.abs(
          pixelAt(guarded, 0.38, 0.5)[0] - pixelAt(unguarded, 0.38, 0.5)[0],
        ),
      ).toBeLessThanOrEqual(1);
    }

    const darkUnguarded = container.querySelector<HTMLCanvasElement>(
      '[data-ui-contrast-probe="dark-unguarded"] canvas',
    )!;
    const darkGuarded = container.querySelector<HTMLCanvasElement>(
      '[data-ui-contrast-probe="dark-guarded"] canvas',
    )!;
    const darkToolOff = container.querySelector<HTMLCanvasElement>(
      '[data-ui-contrast-probe="dark-tool-off"] canvas',
    )!;
    const darkToolMax = container.querySelector<HTMLCanvasElement>(
      '[data-ui-contrast-probe="dark-tool-max"] canvas',
    )!;
    const darkBasePixel = pixelAt(darkUnguarded, 0.2, 0.5)[0];
    expect(
      Math.abs(pixelAt(darkToolOff, 0.2, 0.5)[0] - darkBasePixel),
    ).toBeLessThanOrEqual(1);
    const darkGuardedDelta = Math.abs(
      pixelAt(darkGuarded, 0.2, 0.5)[0] - darkBasePixel,
    );
    expect(
      Math.abs(pixelAt(darkToolMax, 0.2, 0.5)[0] - darkBasePixel),
    ).toBeGreaterThan(darkGuardedDelta + 20);
    expect(
      Math.abs(
        pixelAt(darkGuarded, 0.5, 0.5)[0] - pixelAt(darkUnguarded, 0.5, 0.5)[0],
      ),
    ).toBeGreaterThan(80);
  });

  it("keeps every non-Simple light theme on the bright correction branch", async () => {
    const mutedForeground = shaderRgb(0x88, 0x88, 0x88);
    const lightThemes = [
      {
        name: "dark-academia",
        backdropColor: shaderRgb(0xf0, 0xed, 0xe6),
      },
      {
        name: "modern-mystic",
        backdropColor: shaderRgb(0xea, 0xee, 0xf2),
      },
      {
        name: "warm-craft",
        backdropColor: shaderRgb(0xf0, 0xeb, 0xe0),
      },
    ];
    const { container } = render(
      <div>
        {lightThemes.map(({ name, backdropColor }) => (
          <div key={name}>
            <UiContrastProbe
              name={`${name}-unguarded`}
              enabled={false}
              uiTextColor={mutedForeground}
              backdropColor={backdropColor}
            />
            <UiContrastProbe
              name={`${name}-guarded`}
              enabled
              uiTextColor={mutedForeground}
              backdropColor={backdropColor}
            />
          </div>
        ))}
      </div>,
    );

    await waitFor(() => {
      for (const { name } of lightThemes) {
        expectShaderDrawn(
          container,
          `[data-ui-contrast-probe="${name}-unguarded"]`,
        );
        expectShaderDrawn(
          container,
          `[data-ui-contrast-probe="${name}-guarded"]`,
        );
      }
    });

    for (const { name } of lightThemes) {
      const unguarded = container.querySelector<HTMLCanvasElement>(
        `[data-ui-contrast-probe="${name}-unguarded"] canvas`,
      )!;
      const guarded = container.querySelector<HTMLCanvasElement>(
        `[data-ui-contrast-probe="${name}-guarded"] canvas`,
      )!;

      expect(pixelAt(guarded, 0.2, 0.5)[0]).toBeGreaterThan(
        pixelAt(unguarded, 0.2, 0.5)[0] + 20,
      );
    }
  });

  it("lifts black tool backgrounds even when their raw muted-text contrast passes", async () => {
    const mutedForeground = shaderRgb(0x88, 0x88, 0x88);
    const backdropColor = shaderRgb(0xf0, 0xed, 0xe6);
    const { container } = render(
      <div>
        <UiContrastProbe
          name="black-light-unguarded"
          enabled={false}
          uiTextColor={mutedForeground}
          backdropColor={backdropColor}
          toolMix={0.75}
          strength={0}
          opacity={100}
          fragmentShader={BLACK_CONTRAST_FRAGMENT}
        />
        <UiContrastProbe
          name="black-light-guarded"
          enabled
          uiTextColor={mutedForeground}
          backdropColor={backdropColor}
          toolMix={0.75}
          strength={0}
          opacity={100}
          fragmentShader={BLACK_CONTRAST_FRAGMENT}
        />
      </div>,
    );

    await waitFor(() => {
      expectShaderDrawn(
        container,
        '[data-ui-contrast-probe="black-light-unguarded"]',
      );
      expectShaderDrawn(
        container,
        '[data-ui-contrast-probe="black-light-guarded"]',
      );
    });

    const unguarded = container.querySelector<HTMLCanvasElement>(
      '[data-ui-contrast-probe="black-light-unguarded"] canvas',
    )!;
    const guarded = container.querySelector<HTMLCanvasElement>(
      '[data-ui-contrast-probe="black-light-guarded"] canvas',
    )!;

    expect(pixelAt(guarded, 0.2, 0.5)[0]).toBeGreaterThan(
      pixelAt(unguarded, 0.2, 0.5)[0] + 20,
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
      expectShaderDrawn(
        container,
        '[data-low-opacity-contrast-probe="guarded"]',
      );
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

  it("keeps the patched ShaderMount animation loop running", async () => {
    const { container } = render(
      <ShaderMount
        data-animation-probe
        fragmentShader={GRADIENT_FRAGMENT}
        uniforms={SIZING_UNIFORMS}
        width={64}
        height={64}
        minPixelRatio={1}
        maxPixelCount={4_096}
        speed={1}
      />,
    );

    await waitFor(() => {
      const host = container.querySelector<HTMLElement>(
        "[data-animation-probe]",
      );
      expect(host).not.toBeNull();
      if (!host) return;
      expect(isPaperShaderElement(host)).toBe(true);
      if (!isPaperShaderElement(host)) return;
      const mount = host.paperShaderMount;
      expect(mount).toBeDefined();
      if (!mount) return;
      expect(mount.getPerformanceStats().drawCount).toBeGreaterThan(2);
    });
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
