// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPanelLoaded,
  preloadPanel,
  registerPanelPreloaders,
  startPanelIdlePreload,
} from "./panelPreload";

function fakePreloader() {
  let loaded = false;
  const preload = vi.fn(async () => {
    loaded = true;
  });
  return { preload, isLoaded: () => loaded };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("panelPreload", () => {
  it("treats unregistered (eager) panels as loaded and preloads registered ones", async () => {
    const chat = fakePreloader();
    registerPanelPreloaders({ chat });
    expect(isPanelLoaded("scenes")).toBe(true);
    expect(isPanelLoaded("chat")).toBe(false);
    await preloadPanel("chat");
    expect(chat.preload).toHaveBeenCalledTimes(1);
    expect(isPanelLoaded("chat")).toBe(true);
  });

  it("preloads one panel per idle period after the start delay, skipping loaded ones", async () => {
    vi.useFakeTimers();
    const idle: Array<(d: { timeRemaining: () => number }) => void> = [];
    vi.stubGlobal(
      "requestIdleCallback",
      (cb: (d: { timeRemaining: () => number }) => void) => {
        idle.push(cb);
        return idle.length;
      },
    );
    vi.stubGlobal("cancelIdleCallback", () => {});
    const timeline = fakePreloader();
    const map = fakePreloader();
    registerPanelPreloaders({ timeline, map });

    const stop = startPanelIdlePreload(() => ["scenes", "timeline", "map"]);
    expect(idle).toHaveLength(0);
    vi.advanceTimersByTime(5_000);
    expect(idle).toHaveLength(1);

    idle.shift()!({ timeRemaining: () => 50 });
    expect(timeline.preload).toHaveBeenCalledTimes(1);
    expect(map.preload).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(idle).toHaveLength(1));

    // 残りが少ない idle では評価しない。
    idle.shift()!({ timeRemaining: () => 5 });
    expect(map.preload).not.toHaveBeenCalled();
    idle.shift()!({ timeRemaining: () => 50 });
    expect(map.preload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("waits while the user is typing", () => {
    vi.useFakeTimers();
    const idle: Array<(d: { timeRemaining: () => number }) => void> = [];
    vi.stubGlobal(
      "requestIdleCallback",
      (cb: (d: { timeRemaining: () => number }) => void) => {
        idle.push(cb);
        return idle.length;
      },
    );
    vi.stubGlobal("cancelIdleCallback", () => {});
    const grid = fakePreloader();
    registerPanelPreloaders({ grid });
    const stop = startPanelIdlePreload(() => ["grid"]);
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    idle.shift()!({ timeRemaining: () => 50 });
    expect(grid.preload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    idle.shift()!({ timeRemaining: () => 50 });
    expect(grid.preload).toHaveBeenCalledTimes(1);
    stop();
  });
});
