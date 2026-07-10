// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { getVersion } from "./appInfo";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("getVersion electron 分岐", () => {
  it("bridge.getVersion へ写像する", async () => {
    const bridgeGetVersion = vi.fn().mockResolvedValue("1.2.3");
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      getVersion: bridgeGetVersion,
    };
    await expect(getVersion()).resolves.toBe("1.2.3");
    expect(bridgeGetVersion).toHaveBeenCalledOnce();
  });

  it("非 Tauri / 非 Electron では従来どおり reject する", async () => {
    await expect(getVersion()).rejects.toThrow(
      /unavailable outside the Tauri runtime/,
    );
  });
});
