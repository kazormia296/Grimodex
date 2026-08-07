import {
  act,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PaperShaderElement,
  ShaderMount,
  ShaderMountUniforms,
} from "@paper-design/shaders";
import { ZenShaderSurface } from "./ZenShaderSurface";
import { DEFAULT_ZEN_SHADER_CONFIG } from "./zenShaderConfig";
import type {
  ZenGlassLayout,
  ZenShaderLayouts,
} from "./useZenShaderLayouts";

const rendererTransitions: string[] = [];
const shaderLifecycle = {
  mounted: 0,
  unmounted: 0,
  mountedCapacities: [] as number[],
  uniformLengths: [] as number[],
  staticFrameReady: true,
  props: null as null | {
    speed?: number;
    minPixelRatio?: number;
    maxPixelCount?: number;
    webGlContextAttributes?: WebGLContextAttributes;
  },
};

const emptyGlass: ZenGlassLayout = {
  rect: [0, 0, 0, 0],
  feather: [0, 0, 0, 0],
  cornerRadius: 0,
};

let layoutState: ZenShaderLayouts = {
  surfaceSize: { width: 1_000, height: 700 },
  contrast: {
    rect: [0.25, 0.1, 0.75, 0.9],
    feather: [0.05, 0.05, 0.05, 0.05],
  },
  glass: {
    rect: [0.2, 0.05, 0.8, 0.95],
    feather: [0, 0, 0, 0],
    cornerRadius: 18,
  },
  uiSurfaces: [],
};

vi.mock("./useZenShaderLayouts", () => ({
  useZenShaderLayouts: () => layoutState,
}));

vi.mock("./zenThemePalette", () => ({
  useZenThemePalette: () => ({
    colors: ["#10131a", "#223047"],
    textColor: [0.9, 0.9, 0.9],
    uiTextColor: [0.1, 0.1, 0.1],
    backdropColor: [0.05, 0.06, 0.08],
  }),
}));

vi.mock("./ZenMultipassCanvas", () => ({
  ZenMultipassCanvas: forwardRef<
    PaperShaderElement,
    {
      sceneFragment: string;
      sceneUniforms: ShaderMountUniforms;
      compositeFragment: string;
      compositeUniforms: ShaderMountUniforms;
      speed?: number;
      minPixelRatio?: number;
      maxPixelCount?: number;
      webGlContextAttributes?: WebGLContextAttributes;
      className?: string;
      style?: CSSProperties;
      "data-paper-shader": string;
      "data-zen-glass-compositor"?: string;
    }
  >(function MockZenMultipassCanvas(
    {
      compositeFragment,
      compositeUniforms,
      speed,
      minPixelRatio,
      maxPixelCount,
      webGlContextAttributes,
      className,
      style,
      "data-paper-shader": paperShader,
      "data-zen-glass-compositor": ownsGlass,
    },
    forwardedRef,
  ) {
    const elementRef = useRef<HTMLDivElement>(null);
    const capacity = Number(
      /u_zenUiSurfaceRects\[(\d+)\]/.exec(compositeFragment)?.[1] ?? 0,
    );
    const packedRects = compositeUniforms[
      "u_zenUiSurfaceRects[0]"
    ] as Float32Array;
    shaderLifecycle.mounted += 1;
    shaderLifecycle.mountedCapacities.push(capacity);
    shaderLifecycle.uniformLengths.push(packedRects.length);
    shaderLifecycle.props = {
      speed,
      minPixelRatio,
      maxPixelCount,
      webGlContextAttributes,
    };

    useImperativeHandle(
      forwardedRef,
      () => {
        const element = elementRef.current as unknown as PaperShaderElement;
        element.paperShaderMount = {
          setFrame: vi.fn(),
          getPerformanceStats: () => ({
            drawCount: shaderLifecycle.staticFrameReady ? 1 : 0,
            gpuTimeMs: null,
            isStaticFrameReady: shaderLifecycle.staticFrameReady,
          }),
          resetPerformanceStats: vi.fn(),
        } as unknown as ShaderMount;
        return element;
      },
      [],
    );

    useEffect(
      () => () => {
        shaderLifecycle.unmounted += 1;
      },
      [],
    );

    return (
      <div
        ref={elementRef}
        data-paper-shader={paperShader}
        data-zen-glass-compositor={ownsGlass}
        className={className}
        style={style}
      />
    );
  }),
}));

function staticConfig() {
  return {
    ...DEFAULT_ZEN_SHADER_CONFIG,
    shader: "static-mesh-gradient" as const,
    glass: {
      ...DEFAULT_ZEN_SHADER_CONFIG.glass,
      enabled: true,
    },
    contrastGuard: {
      ...DEFAULT_ZEN_SHADER_CONFIG.contrastGuard,
      mode: "auto" as const,
    },
  };
}

describe("ZenShaderSurface", () => {
  beforeEach(() => {
    rendererTransitions.length = 0;
    shaderLifecycle.mounted = 0;
    shaderLifecycle.unmounted = 0;
    shaderLifecycle.mountedCapacities.length = 0;
    shaderLifecycle.uniformLengths.length = 0;
    shaderLifecycle.staticFrameReady = true;
    shaderLifecycle.props = null;
    layoutState = {
      surfaceSize: { width: 1_000, height: 700 },
      contrast: {
        rect: [0.25, 0.1, 0.75, 0.9],
        feather: [0.05, 0.05, 0.05, 0.05],
      },
      glass: {
        rect: [0.2, 0.05, 0.8, 0.95],
        feather: [0, 0, 0, 0],
        cornerRadius: 18,
      },
      uiSurfaces: [],
    };
  });

  it("mounts one shader and one shared GPU compositor when ready", async () => {
    const { container } = render(
      <ZenShaderSurface config={staticConfig()} playing={false} />,
    );

    await waitFor(() => {
      expect(container.querySelector("[data-paper-shader]")).toBeTruthy();
      expect(
        container.querySelector("[data-zen-glass-compositor]"),
      ).toBeTruthy();
    });
    expect(shaderLifecycle.props?.speed).toBe(0);
  });

  it("waits for the first complete multipass draw before owning Glass", async () => {
    shaderLifecycle.staticFrameReady = false;
    const { container } = render(
      <ZenShaderSurface config={staticConfig()} playing={false} />,
    );

    await waitFor(() => {
      expect(
        container
          .querySelector("[data-zen-shader-surface]")
          ?.getAttribute("data-zen-shader-renderer"),
      ).toBe("initializing");
    });
    expect(
      container.querySelector("[data-zen-glass-compositor]"),
    ).toBeNull();

    shaderLifecycle.staticFrameReady = true;
    await waitFor(() => {
      expect(
        container
          .querySelector("[data-zen-shader-surface]")
          ?.getAttribute("data-zen-shader-renderer"),
      ).toBe("webgl");
      expect(
        container.querySelector("[data-zen-glass-compositor]"),
      ).toBeTruthy();
    });
  });

  it("keeps the high-water shader variant when tool surfaces disappear", async () => {
    layoutState = {
      ...layoutState,
      uiSurfaces: Array.from({ length: 9 }, (_, index) => ({
        ...emptyGlass,
        rect: [index / 20, 0.1, index / 20 + 0.04, 0.2],
        cornerRadius: 8,
        refracts: true,
      })),
    };
    const { rerender } = render(
      <ZenShaderSurface config={staticConfig()} playing={false} />,
    );

    layoutState = { ...layoutState, uiSurfaces: [] };
    rerender(<ZenShaderSurface config={staticConfig()} playing={false} />);

    await waitFor(() => {
      expect(shaderLifecycle.unmounted).toBe(0);
    });
    expect(Math.max(...shaderLifecycle.mountedCapacities)).toBe(16);
  });

  it("uploads one packed UI buffer for Glass and tool contrast", async () => {
    layoutState = {
      ...layoutState,
      uiSurfaces: [
        {
          ...emptyGlass,
          rect: [0.05, 0.1, 0.2, 0.25],
          cornerRadius: 10,
          refracts: true,
        },
        {
          ...emptyGlass,
          rect: [0.3, 0.1, 0.45, 0.25],
          cornerRadius: 6,
          refracts: false,
        },
      ],
    };
    render(<ZenShaderSurface config={staticConfig()} playing={false} />);

    await waitFor(() => {
      expect(shaderLifecycle.uniformLengths.at(-1)).toBe(16 * 4);
    });
  });

  it("uses the live-background pixel budget without forced supersampling", () => {
    render(<ZenShaderSurface config={staticConfig()} playing={false} />);

    expect(shaderLifecycle.props?.minPixelRatio).toBe(1);
    expect(shaderLifecycle.props?.maxPixelCount).toBe(1920 * 1080);
    expect(shaderLifecycle.props?.webGlContextAttributes).toMatchObject({
      antialias: false,
      powerPreference: "default",
    });
  });

  it("uses the smaller preview pixel budget", () => {
    render(
      <ZenShaderSurface config={staticConfig()} playing={false} preview />,
    );

    expect(shaderLifecycle.props?.maxPixelCount).toBe(300_000);
  });

  it("falls back after WebGL context loss", async () => {
    const { container } = render(
      <ZenShaderSurface
        config={staticConfig()}
        playing={false}
        onRendererStatusChange={(status) => rendererTransitions.push(status)}
      />,
    );

    await waitFor(() => {
      expect(rendererTransitions).toContain("webgl");
    });
    const shader = container.querySelector("[data-paper-shader]");
    expect(shader).toBeTruthy();
    act(() => {
      shader?.dispatchEvent(
        new Event("webglcontextlost", { bubbles: true, cancelable: true }),
      );
    });

    await waitFor(() => {
      expect(rendererTransitions.at(-1)).toBe("fallback-context-lost");
      expect(container.querySelector("[data-paper-shader]")).toBeNull();
    });
  });

  it("does not mount WebGL when support is unavailable", () => {
    const { container } = render(
      <ZenShaderSurface
        config={staticConfig()}
        playing={false}
        webGlSupported={false}
      />,
    );

    expect(container.querySelector("[data-paper-shader]")).toBeNull();
    expect(
      container
        .querySelector("[data-zen-shader-surface]")
        ?.getAttribute("data-zen-shader-renderer"),
    ).toBe("fallback-unsupported");
  });

  it("keeps contrast diagnostics on the owning surface", () => {
    const { container } = render(
      <ZenShaderSurface config={staticConfig()} playing={false} />,
    );
    const surface = container.querySelector("[data-zen-shader-surface]");

    expect(surface?.getAttribute("data-contrast-guard")).toBe("auto");
    expect(surface?.getAttribute("data-contrast-rect")).toBe("0.25 0.1 0.75 0.9");
    expect(surface?.getAttribute("data-ui-contrast-surface-count")).toBe("0");
  });
});
