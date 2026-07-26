// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserMock } from "./browser-mock";

type TauriModuleWithBrowserMockInjection = typeof import("./tauri") & {
  installBrowserMock(mock: BrowserMock): void;
};

beforeEach(() => {
  vi.resetModules();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).grimodex;
});

afterEach(() => {
  vi.doUnmock("./browser-mock");
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("browser mock injection", () => {
  it("uses a preinstalled BrowserMock for the first browser invoke without creating the default mock", async () => {
    const createBrowserMock = vi.fn(() =>
      Promise.reject(new Error("default BrowserMock must not be created")),
    );
    vi.doMock("./browser-mock", () => ({ createBrowserMock }));

    const tauri =
      (await import("./tauri")) as TauriModuleWithBrowserMockInjection;
    const preinstalled: BrowserMock = {
      invoke: vi.fn().mockResolvedValue({ source: "preinstalled" }),
    };

    tauri.installBrowserMock(preinstalled);

    await expect(tauri.invoke("get_global_settings")).resolves.toEqual({
      source: "preinstalled",
    });
    expect(preinstalled.invoke).toHaveBeenCalledWith(
      "get_global_settings",
      undefined,
    );
    expect(createBrowserMock).not.toHaveBeenCalled();
  });
});
