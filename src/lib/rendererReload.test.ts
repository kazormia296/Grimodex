import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RENDERER_RELOAD_RELEASE_FRAMES,
  reloadRendererAfterReleasingGpuSurfaces,
  useRendererReloadStore,
} from "./rendererReload";

function createView() {
  const frames: FrameRequestCallback[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const reload = vi.fn(() => {
    // reload の時点で GPU の面はもう外れていること。
    expect(useRendererReloadStore.getState().gpuSurfacesReleased).toBe(true);
  });
  const view = {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }),
    setTimeout: vi.fn((callback: () => void) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    }),
    clearTimeout: vi.fn((id: number | undefined) => {
      if (id !== undefined) timers.delete(id);
    }),
    location: { reload } as unknown as Location,
  };
  const runFrame = () => frames.shift()?.(0);
  const runTimers = () => {
    for (const [id, callback] of [...timers]) {
      timers.delete(id);
      callback();
    }
  };
  return { view, reload, runFrame, runTimers, frames, timers };
}

afterEach(() => {
  useRendererReloadStore.setState({ gpuSurfacesReleased: false });
});

describe("reloadRendererAfterReleasingGpuSurfaces", () => {
  it("releases GPU surfaces first and reloads only after the release frames", async () => {
    const { view, reload, runFrame, timers } = createView();
    const done = reloadRendererAfterReleasingGpuSurfaces({
      view: view as unknown as Window,
    });

    expect(useRendererReloadStore.getState().gpuSurfacesReleased).toBe(true);
    for (let frame = 0; frame < RENDERER_RELOAD_RELEASE_FRAMES; frame += 1) {
      expect(reload).not.toHaveBeenCalled();
      runFrame();
    }
    await done;
    expect(reload).toHaveBeenCalledTimes(1);
    expect(view.requestAnimationFrame).toHaveBeenCalledTimes(
      RENDERER_RELOAD_RELEASE_FRAMES,
    );
    // 待ちの上限の timer は解除済み。
    expect(timers.size).toBe(0);
  });

  it("still reloads once when animation frames never arrive (hidden window)", async () => {
    const { view, reload, runFrame, runTimers } = createView();
    const done = reloadRendererAfterReleasingGpuSurfaces({
      view: view as unknown as Window,
    });

    runTimers();
    await done;
    expect(reload).toHaveBeenCalledTimes(1);

    // 遅れて届いた frame は 2 回目の reload を起こさない。
    runFrame();
    runFrame();
    runFrame();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
