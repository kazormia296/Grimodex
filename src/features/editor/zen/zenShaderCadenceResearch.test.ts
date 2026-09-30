import { describe, expect, it, vi } from "vitest";
import {
  createZenShaderCadenceScheduler,
  type ZenShaderCadenceDriver,
  type ZenShaderCadenceMode,
} from "./zenShaderCadenceResearch";
import { createZenShaderFrameCadence } from "./zenShaderAnimation";

class FakeCadenceDriver implements ZenShaderCadenceDriver {
  private nextHandle = 1;
  private nowMs = 0;
  private readonly animationFrames = new Map<number, FrameRequestCallback>();
  private readonly timers = new Map<
    number,
    { callback: () => void; dueAtMs: number }
  >();

  readonly cancelledAnimationFrames: number[] = [];
  readonly cancelledTimers: number[] = [];
  readonly requestedTimerDelaysMs: number[] = [];

  now = () => this.nowMs;

  requestAnimationFrame = (callback: FrameRequestCallback) => {
    const handle = this.nextHandle++;
    this.animationFrames.set(handle, callback);
    return handle;
  };

  cancelAnimationFrame = (handle: number) => {
    this.cancelledAnimationFrames.push(handle);
    this.animationFrames.delete(handle);
  };

  setTimer = (callback: () => void, delayMs: number) => {
    const handle = this.nextHandle++;
    this.requestedTimerDelaysMs.push(delayMs);
    this.timers.set(handle, {
      callback,
      dueAtMs: this.nowMs + Math.max(0, delayMs),
    });
    return handle;
  };

  clearTimer = (handle: number) => {
    this.cancelledTimers.push(handle);
    this.timers.delete(handle);
  };

  stepAnimationFrame(timestampMs: number) {
    this.nowMs = timestampMs;
    const callbacks = [...this.animationFrames.values()];
    this.animationFrames.clear();
    callbacks.forEach((callback) => callback(timestampMs));
  }

  fireNextTimerAt(timestampMs: number) {
    const next = [...this.timers.entries()].sort(
      ([, left], [, right]) => left.dueAtMs - right.dueAtMs,
    )[0];
    if (!next) throw new Error("No timer is pending");
    const [handle, timer] = next;
    this.timers.delete(handle);
    this.nowMs = timestampMs;
    timer.callback();
  }

  get pendingAnimationFrameCount() {
    return this.animationFrames.size;
  }

  get pendingTimerCount() {
    return this.timers.size;
  }
}

function schedulerFor(
  mode: ZenShaderCadenceMode,
  driver: FakeCadenceDriver,
  emitted: Array<{ frame: number; timestampMs: number }>,
) {
  return createZenShaderCadenceScheduler({
    mode,
    animationSpeed: 1,
    initialFrame: 0,
    targetFps: 60,
    driver,
    emitFrame: (frame, timestampMs) => emitted.push({ frame, timestampMs }),
  });
}

describe("Zen shader cadence research scheduler", () => {
  it("emits every native rAF while keeping shader time tied to wall time", () => {
    const driver = new FakeCadenceDriver();
    const emitted: Array<{ frame: number; timestampMs: number }> = [];
    const scheduler = schedulerFor("native-raf", driver, emitted);

    scheduler.start();
    for (let timestamp = 0; timestamp <= 1_000; timestamp += 5) {
      driver.stepAnimationFrame(timestamp);
    }

    expect(emitted).toHaveLength(200);
    expect(emitted.at(-1)).toEqual({ frame: 1_000, timestampMs: 1_000 });
    expect(scheduler.getSnapshot()).toMatchObject({
      mode: "native-raf",
      running: true,
      frame: 1_000,
      rafCallbackCount: 201,
      timerWakeupCount: 0,
      emittedFrameCount: 200,
      skippedRafCount: 0,
      integratedElapsedMs: 1_000,
    });
  });

  it("uses absolute 60fps timer deadlines so late wakeups do not accumulate drift", () => {
    const driver = new FakeCadenceDriver();
    const emitted: Array<{ frame: number; timestampMs: number }> = [];
    const scheduler = schedulerFor("timer-60", driver, emitted);

    scheduler.start();
    expect(driver.requestedTimerDelaysMs[0]).toBeCloseTo(1_000 / 60, 6);

    driver.fireNextTimerAt(20);
    expect(driver.requestedTimerDelaysMs[1]).toBeCloseTo(1_000 / 30 - 20, 6);

    driver.fireNextTimerAt(35);
    expect(driver.requestedTimerDelaysMs[2]).toBeCloseTo(50 - 35, 6);
    expect(emitted).toEqual([
      { frame: 20, timestampMs: 20 },
      { frame: 35, timestampMs: 35 },
    ]);
    expect(scheduler.getSnapshot()).toMatchObject({
      mode: "timer-60",
      rafCallbackCount: 0,
      timerWakeupCount: 2,
      emittedFrameCount: 2,
      frame: 35,
      integratedElapsedMs: 35,
    });
  });

  it("keeps native rAF wakeups but skips draws above 60fps", () => {
    const driver = new FakeCadenceDriver();
    const emitted: Array<{ frame: number; timestampMs: number }> = [];
    const scheduler = schedulerFor("raf-skip-60", driver, emitted);

    scheduler.start();
    for (let timestamp = 0; timestamp <= 1_000; timestamp += 5) {
      driver.stepAnimationFrame(timestamp);
    }

    expect(emitted.length).toBeGreaterThanOrEqual(58);
    expect(emitted.length).toBeLessThanOrEqual(60);
    expect(emitted.at(-1)?.frame).toBeCloseTo(1_000, 5);
    expect(scheduler.getSnapshot()).toMatchObject({
      mode: "raf-skip-60",
      rafCallbackCount: 201,
      timerWakeupCount: 0,
      emittedFrameCount: emitted.length,
      skippedRafCount: 200 - emitted.length,
      frame: 1_000,
      integratedElapsedMs: 1_000,
    });
  });

  it("keeps a retained canvas fully quiescent in stopped mode", () => {
    const driver = new FakeCadenceDriver();
    const emitted: Array<{ frame: number; timestampMs: number }> = [];
    const scheduler = schedulerFor("stopped-retained", driver, emitted);

    scheduler.start();
    driver.stepAnimationFrame(1_000);

    expect(emitted).toEqual([]);
    expect(driver.pendingAnimationFrameCount).toBe(0);
    expect(driver.pendingTimerCount).toBe(0);
    expect(scheduler.getSnapshot()).toEqual({
      mode: "stopped-retained",
      running: false,
      frame: 0,
      rafCallbackCount: 0,
      timerWakeupCount: 0,
      emittedFrameCount: 0,
      skippedRafCount: 0,
      integratedElapsedMs: 0,
    });
  });

  it("matches the product cadence for irregular rAF elapsed sequences", () => {
    const timestamps = [0, 5, 17, 33, 34, 50, 73, 91, 120, 121, 167];
    const productCadence = createZenShaderFrameCadence();
    const productEmissions: number[] = [];
    for (let index = 1; index < timestamps.length; index += 1) {
      const elapsedMs = timestamps[index]! - timestamps[index - 1]!;
      if (productCadence.advance(elapsedMs)) {
        productEmissions.push(timestamps[index]!);
      }
    }

    const driver = new FakeCadenceDriver();
    const researchEmissions: Array<{ frame: number; timestampMs: number }> = [];
    const scheduler = schedulerFor("raf-skip-60", driver, researchEmissions);
    scheduler.start();
    timestamps.forEach((timestamp) => driver.stepAnimationFrame(timestamp));

    expect(researchEmissions.map(({ timestampMs }) => timestampMs)).toEqual(
      productEmissions,
    );
    expect(scheduler.getSnapshot().skippedRafCount).toBe(
      timestamps.length - 1 - productEmissions.length,
    );
  });

  it.each(["native-raf", "timer-60", "raf-skip-60"] as const)(
    "cancels pending %s work and ignores callbacks after stop",
    (mode) => {
      const driver = new FakeCadenceDriver();
      const emitted: Array<{ frame: number; timestampMs: number }> = [];
      const scheduler = schedulerFor(mode, driver, emitted);

      scheduler.start();
      scheduler.stop();
      driver.stepAnimationFrame(100);

      expect(emitted).toEqual([]);
      expect(driver.pendingAnimationFrameCount).toBe(0);
      expect(driver.pendingTimerCount).toBe(0);
      expect(scheduler.getSnapshot()).toMatchObject({
        running: false,
        frame: 0,
        emittedFrameCount: 0,
      });
      if (mode === "timer-60") {
        expect(driver.cancelledTimers).toHaveLength(1);
      } else {
        expect(driver.cancelledAnimationFrames).toHaveLength(1);
      }
    },
  );

  it("normalizes non-finite speed without emitting invalid frames", () => {
    const driver = new FakeCadenceDriver();
    const emitFrame = vi.fn();
    const scheduler = createZenShaderCadenceScheduler({
      mode: "native-raf",
      animationSpeed: Number.NaN,
      initialFrame: 42,
      targetFps: 60,
      driver,
      emitFrame,
    });

    scheduler.start();
    driver.stepAnimationFrame(0);
    driver.stepAnimationFrame(20);

    expect(emitFrame).not.toHaveBeenCalled();
    expect(scheduler.getSnapshot().frame).toBe(42);
  });
});
