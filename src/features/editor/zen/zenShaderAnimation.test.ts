import { describe, expect, it, vi } from "vitest";
import { createZenShaderAnimationScheduler } from "./zenShaderAnimation";

class FakeAnimationFrames {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  request = (callback: FrameRequestCallback) => {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  };

  cancel = vi.fn((handle: number) => {
    this.callbacks.delete(handle);
  });

  step(timestamp: number) {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(timestamp));
  }
}

describe("Zen shader animation scheduler", () => {
  it("caps Paper frame updates at 30fps", () => {
    const frames = new FakeAnimationFrames();
    const setFrame = vi.fn();
    const scheduler = createZenShaderAnimationScheduler(
      () => ({ setFrame }),
      frames,
    );

    scheduler.start(0.08);
    for (let timestamp = 0; timestamp <= 1_000; timestamp += 5) {
      frames.step(timestamp);
    }

    expect(setFrame.mock.calls.length).toBeGreaterThanOrEqual(28);
    expect(setFrame.mock.calls.length).toBeLessThanOrEqual(30);
  });

  it("carries 60Hz timing remainder instead of falling toward 20fps", () => {
    const frames = new FakeAnimationFrames();
    const setFrame = vi.fn();
    const scheduler = createZenShaderAnimationScheduler(
      () => ({ setFrame }),
      frames,
    );

    scheduler.start(0.08);
    for (let timestamp = 0; timestamp <= 1_000; timestamp += 1_000 / 60) {
      frames.step(timestamp);
    }

    expect(setFrame.mock.calls.length).toBeGreaterThanOrEqual(28);
    expect(setFrame.mock.calls.length).toBeLessThanOrEqual(30);
    expect(scheduler.getFrame()).toBeCloseTo(80, 5);
  });

  it("cancels while paused and excludes paused time when resumed", () => {
    const frames = new FakeAnimationFrames();
    const setFrame = vi.fn();
    const scheduler = createZenShaderAnimationScheduler(
      () => ({ setFrame }),
      frames,
    );

    scheduler.start(0.1);
    frames.step(0);
    frames.step(40);
    expect(setFrame).toHaveBeenLastCalledWith(4);

    scheduler.stop();
    frames.step(1_000);
    expect(setFrame).toHaveBeenCalledTimes(1);
    expect(frames.cancel).toHaveBeenCalledTimes(1);

    scheduler.start(0.1);
    frames.step(2_000);
    frames.step(2_040);
    expect(setFrame).toHaveBeenCalledTimes(2);
    expect(setFrame).toHaveBeenLastCalledWith(8);
    expect(scheduler.getFrame()).toBe(8);
  });
});
