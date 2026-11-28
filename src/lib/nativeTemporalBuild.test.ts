import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldAliasNativeTemporal } from "./nativeTemporalBuild";

describe("shouldAliasNativeTemporal", () => {
  it.each([
    ["Electron の desktop の build", "build", "production", undefined, true],
    ["Web Editor の build", "build", "web-editor", undefined, false],
    ["Tauri shell の build", "build", "production", "linux", false],
    ["dev server", "serve", "development", undefined, false],
  ] as const)("%s", (_label, command, mode, tauriPlatform, expected) => {
    expect(shouldAliasNativeTemporal({ command, mode, tauriPlatform })).toBe(
      expected,
    );
  });
});

describe("nativeTemporalShim", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("標準の Temporal をそのまま出す", async () => {
    const native = { Instant: {} };
    vi.stubGlobal("Temporal", native);
    vi.resetModules();
    const shim = await import("./nativeTemporalShim");
    expect(shim.Temporal).toBe(native);
  });

  it("標準の Temporal が無ければ読み込みで止める", async () => {
    vi.stubGlobal("Temporal", undefined);
    vi.resetModules();
    await expect(import("./nativeTemporalShim")).rejects.toThrow(
      "native Temporal",
    );
  });
});
