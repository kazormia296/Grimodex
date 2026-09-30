import { describe, expect, it } from "vitest";
import { collectZenWebGlMetadata } from "./zenWebGlDiagnostics";

interface FakeGlOptions {
  debugExtension?: boolean;
  throwOnExtension?: boolean;
  throwOnParameter?: boolean;
}

function fakeGl({
  debugExtension = true,
  throwOnExtension = false,
  throwOnParameter = false,
}: FakeGlOptions = {}) {
  const gl = {
    VENDOR: 1,
    RENDERER: 2,
    VERSION: 3,
    SHADING_LANGUAGE_VERSION: 4,
    MAX_TEXTURE_SIZE: 5,
    MAX_TEXTURE_IMAGE_UNITS: 6,
    getExtension(name: string) {
      if (throwOnExtension) throw new Error("extension probe failed");
      if (name !== "WEBGL_debug_renderer_info" || !debugExtension) return null;
      return {
        UNMASKED_VENDOR_WEBGL: 7,
        UNMASKED_RENDERER_WEBGL: 8,
      };
    },
    getParameter(parameter: number) {
      if (throwOnParameter) throw new Error("parameter probe failed");
      return new Map<number, string | number>([
        [1, "Chromium"],
        [2, "WebKit WebGL"],
        [3, "WebGL 2.0"],
        [4, "WebGL GLSL ES 3.00"],
        [5, 16_384],
        [6, 16],
        [7, "NVIDIA Corporation"],
        [8, "ANGLE (NVIDIA, RTX 2070 SUPER, D3D11)"],
      ]).get(parameter);
    },
  };
  return gl as unknown as WebGL2RenderingContext;
}

describe("Zen WebGL diagnostics", () => {
  it("captures masked and unmasked GPU/ANGLE metadata with runtime identity", () => {
    expect(
      collectZenWebGlMetadata(fakeGl(), {
        userAgent: "Grimodex benchmark agent",
        platform: "Win32",
      }),
    ).toEqual({
      vendor: "Chromium",
      renderer: "WebKit WebGL",
      unmaskedVendor: "NVIDIA Corporation",
      unmaskedRenderer: "ANGLE (NVIDIA, RTX 2070 SUPER, D3D11)",
      version: "WebGL 2.0",
      shadingLanguageVersion: "WebGL GLSL ES 3.00",
      maxTextureSize: 16_384,
      maxTextureImageUnits: 16,
      userAgent: "Grimodex benchmark agent",
      platform: "Win32",
    });
  });

  it("keeps debug-renderer unavailability explicit without failing rendering", () => {
    expect(
      collectZenWebGlMetadata(fakeGl({ debugExtension: false })),
    ).toMatchObject({
      unmaskedVendor: null,
      unmaskedRenderer: null,
      vendor: "Chromium",
      renderer: "WebKit WebGL",
    });
  });

  it("contains driver probe failures and returns a serializable null report", () => {
    expect(() =>
      collectZenWebGlMetadata(
        fakeGl({ throwOnExtension: true, throwOnParameter: true }),
      ),
    ).not.toThrow();
    const metadata = collectZenWebGlMetadata(
      fakeGl({ throwOnExtension: true, throwOnParameter: true }),
    );

    expect(metadata).toMatchObject({
      vendor: null,
      renderer: null,
      unmaskedVendor: null,
      unmaskedRenderer: null,
      maxTextureSize: null,
    });
    expect(() => JSON.stringify(metadata)).not.toThrow();
  });
});
