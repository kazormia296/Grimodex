// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isWebGl2GpuBlocked } from "./gpuFeatureStatus";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("isWebGl2GpuBlocked", () => {
  it("Web Editor（window.grimodex 不在）は不明として false を返す", async () => {
    await expect(isWebGl2GpuBlocked()).resolves.toBe(false);
  });

  it("Electron では bridge の判定をそのまま返す", async () => {
    const getWebGl2GpuBlocked = vi.fn().mockResolvedValue(true);
    (window as unknown as Record<string, unknown>).grimodex = {
      getWebGl2GpuBlocked,
    };
    await expect(isWebGl2GpuBlocked()).resolves.toBe(true);
    expect(getWebGl2GpuBlocked).toHaveBeenCalledOnce();
  });

  it("bridge が失敗した場合は不明として false を返す（probe に委ねる）", async () => {
    (window as unknown as Record<string, unknown>).grimodex = {
      getWebGl2GpuBlocked: vi.fn().mockRejectedValue(new Error("IPC down")),
    };
    await expect(isWebGl2GpuBlocked()).resolves.toBe(false);
  });
});
