// @vitest-environment happy-dom
/**
 * windowControls の Electron 分岐（設計書 §6.3 / §6.4）:
 * bridge.windowControls への写像と、onCloseRequested の
 * preventDefault → veto=true 翻訳。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowCloseRequested,
  onWindowResized,
  toggleMaximizeWindow,
} from "./windowControls";

function installBridge() {
  const closeCbs: Array<() => boolean> = [];
  const resizeCbs: Array<() => void> = [];
  const unlistenResized = vi.fn();
  const unlistenClose = vi.fn();
  const windowControls = {
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(true),
    onResized: vi.fn((cb: () => void) => {
      resizeCbs.push(cb);
      return unlistenResized;
    }),
    onCloseRequested: vi.fn((cb: () => boolean) => {
      closeCbs.push(cb);
      return unlistenClose;
    }),
  };
  (window as unknown as Record<string, unknown>).grimodex = {
    shell: "electron",
    windowControls,
  };
  return { windowControls, closeCbs, resizeCbs, unlistenResized };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("windowControls electron 分岐", () => {
  it("minimize / toggleMaximize / close / isMaximized を bridge へ写像する", async () => {
    const { windowControls } = installBridge();
    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();
    await expect(isWindowMaximized()).resolves.toBe(true);
    expect(windowControls.minimize).toHaveBeenCalledOnce();
    expect(windowControls.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowControls.close).toHaveBeenCalledOnce();
    expect(windowControls.isMaximized).toHaveBeenCalledOnce();
  });

  it("onWindowResized は handler をそのまま購読し、bridge の unlisten を返す", async () => {
    const { resizeCbs, unlistenResized } = installBridge();
    const handler = vi.fn();
    const unlisten = await onWindowResized(handler);
    expect(resizeCbs).toHaveLength(1);
    resizeCbs[0]();
    expect(handler).toHaveBeenCalledOnce();
    unlisten();
    expect(unlistenResized).toHaveBeenCalledOnce();
  });

  it("onWindowCloseRequested: preventDefault 呼び出しを veto=true に翻訳する", async () => {
    const { closeCbs } = installBridge();
    await onWindowCloseRequested((event) => {
      event.preventDefault();
    });
    expect(closeCbs).toHaveLength(1);
    expect(closeCbs[0]()).toBe(true);
  });

  it("onWindowCloseRequested: preventDefault を呼ばなければ veto=false", async () => {
    const { closeCbs } = installBridge();
    await onWindowCloseRequested(() => {
      /* veto しない */
    });
    expect(closeCbs).toHaveLength(1);
    expect(closeCbs[0]()).toBe(false);
  });

  it("非 Tauri / 非 Electron では従来どおり reject する", async () => {
    await expect(minimizeWindow()).rejects.toThrow(
      /unavailable outside the Tauri runtime/,
    );
  });
});
