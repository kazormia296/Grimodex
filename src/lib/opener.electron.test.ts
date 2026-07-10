// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { openUrl } from "./opener";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("openUrl electron 分岐", () => {
  it("bridge.openExternal へ写像する（scheme 検証は main 側の二重防御）", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      openExternal,
    };
    await openUrl("https://example.com/");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("main 側拒否（reject）はそのまま伝播する", async () => {
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      openExternal: vi
        .fn()
        .mockRejectedValue(new Error("EXTERNAL_URL_REJECTED: file:///etc")),
    };
    await expect(openUrl("file:///etc")).rejects.toThrow(
      /EXTERNAL_URL_REJECTED/,
    );
  });

  it("非 Tauri / 非 Electron では従来どおり reject する", async () => {
    await expect(openUrl("https://example.com/")).rejects.toThrow(
      /unavailable outside the Tauri runtime/,
    );
  });
});
