export type ZenShaderCadenceMode =
  | "native-raf"
  | "timer-60"
  | "raf-skip-60"
  | "stopped-retained";

export interface ZenShaderCadenceDriver {
  now: () => number;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (handle: number) => void;
}

export interface ZenShaderCadenceSnapshot {
  mode: ZenShaderCadenceMode;
  running: boolean;
  frame: number;
  rafCallbackCount: number;
  timerWakeupCount: number;
  emittedFrameCount: number;
  skippedRafCount: number;
  integratedElapsedMs: number;
}

export interface ZenShaderCadenceScheduler {
  start: () => void;
  stop: () => void;
  getSnapshot: () => ZenShaderCadenceSnapshot;
}

export interface ZenShaderCadenceSchedulerOptions {
  mode: ZenShaderCadenceMode;
  animationSpeed: number;
  initialFrame: number;
  targetFps: number;
  driver: ZenShaderCadenceDriver;
  emitFrame: (frame: number, timestampMs: number) => void;
}

const FRAME_INTERVAL_TOLERANCE_MS = 0.1;

function finiteNonNegative(value: number, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/**
 * Research-only scheduler that makes display-native, timer-capped, rAF-skipped,
 * and retained/stopped workloads directly comparable under one clock.
 */
export function createZenShaderCadenceScheduler({
  mode,
  animationSpeed,
  initialFrame,
  targetFps,
  driver,
  emitFrame,
}: ZenShaderCadenceSchedulerOptions): ZenShaderCadenceScheduler {
  const speed = finiteNonNegative(animationSpeed);
  const normalizedTargetFps =
    Number.isFinite(targetFps) && targetFps > 0 ? targetFps : 60;
  const frameIntervalMs = 1_000 / normalizedTargetFps;

  let running = false;
  let frame = Number.isFinite(initialFrame) ? initialFrame : 0;
  let rafHandle: number | null = null;
  let timerHandle: number | null = null;
  let lastTimestampMs: number | null = null;
  let nextTimerDeadlineMs: number | null = null;
  let pendingRafElapsedMs = 0;
  let rafCallbackCount = 0;
  let timerWakeupCount = 0;
  let emittedFrameCount = 0;
  let skippedRafCount = 0;
  let integratedElapsedMs = 0;

  const emit = (timestampMs: number) => {
    emittedFrameCount += 1;
    emitFrame(frame, timestampMs);
  };

  const scheduleAnimationFrame = () => {
    rafHandle = driver.requestAnimationFrame(onAnimationFrame);
  };

  const onAnimationFrame = (timestampMs: number) => {
    rafHandle = null;
    if (!running) return;
    rafCallbackCount += 1;

    if (lastTimestampMs === null) {
      lastTimestampMs = timestampMs;
    } else {
      const elapsedMs = Math.max(0, timestampMs - lastTimestampMs);
      integratedElapsedMs += elapsedMs;
      frame += elapsedMs * speed;
      lastTimestampMs = Math.max(lastTimestampMs, timestampMs);

      if (mode === "native-raf") {
        emit(timestampMs);
      } else {
        pendingRafElapsedMs += elapsedMs;
        if (
          pendingRafElapsedMs + FRAME_INTERVAL_TOLERANCE_MS >=
          frameIntervalMs
        ) {
          emit(timestampMs);
          pendingRafElapsedMs =
            pendingRafElapsedMs >= frameIntervalMs
              ? pendingRafElapsedMs % frameIntervalMs
              : 0;
        } else {
          skippedRafCount += 1;
        }
      }
    }

    if (running) scheduleAnimationFrame();
  };

  const scheduleTimer = () => {
    const deadlineMs = nextTimerDeadlineMs;
    if (deadlineMs === null) return;
    timerHandle = driver.setTimer(
      onTimer,
      Math.max(0, deadlineMs - driver.now()),
    );
  };

  const onTimer = () => {
    timerHandle = null;
    if (!running) return;
    timerWakeupCount += 1;
    const timestampMs = driver.now();
    const previousTimestampMs = lastTimestampMs ?? timestampMs;
    const elapsedMs = Math.max(0, timestampMs - previousTimestampMs);
    integratedElapsedMs += elapsedMs;
    frame += elapsedMs * speed;
    lastTimestampMs = Math.max(previousTimestampMs, timestampMs);
    emit(timestampMs);

    let deadlineMs = nextTimerDeadlineMs ?? timestampMs;
    do {
      deadlineMs += frameIntervalMs;
    } while (deadlineMs <= timestampMs);
    nextTimerDeadlineMs = deadlineMs;
    if (running) scheduleTimer();
  };

  const stop = () => {
    running = false;
    lastTimestampMs = null;
    nextTimerDeadlineMs = null;
    pendingRafElapsedMs = 0;
    if (rafHandle !== null) {
      driver.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (timerHandle !== null) {
      driver.clearTimer(timerHandle);
      timerHandle = null;
    }
  };

  return {
    start() {
      if (running || mode === "stopped-retained" || speed === 0) return;
      running = true;
      lastTimestampMs = mode === "timer-60" ? driver.now() : null;
      pendingRafElapsedMs = 0;
      if (mode === "timer-60") {
        nextTimerDeadlineMs = driver.now() + frameIntervalMs;
        scheduleTimer();
      } else {
        scheduleAnimationFrame();
      }
    },
    stop,
    getSnapshot() {
      return {
        mode,
        running,
        frame,
        rafCallbackCount,
        timerWakeupCount,
        emittedFrameCount,
        skippedRafCount,
        integratedElapsedMs,
      };
    },
  };
}
