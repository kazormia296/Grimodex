import { useEffect, useRef, type RefObject } from "react";
import type { PaperShaderElement, ShaderMount } from "@paper-design/shaders";

export const ZEN_SHADER_MAX_FPS = 60;
const FRAME_INTERVAL_MS = 1_000 / ZEN_SHADER_MAX_FPS;
// rAF timestamps can undershoot an exact refresh interval by a tiny amount.
const FRAME_INTERVAL_TOLERANCE_MS = 0.1;

export interface ZenShaderFrameCadence {
  advance: (elapsedMs: number) => boolean;
  reset: () => void;
}

export function createZenShaderFrameCadence(): ZenShaderFrameCadence {
  let pendingElapsed = 0;

  return {
    advance(elapsedMs) {
      pendingElapsed += Math.max(0, elapsedMs);
      if (pendingElapsed + FRAME_INTERVAL_TOLERANCE_MS < FRAME_INTERVAL_MS) {
        return false;
      }
      pendingElapsed =
        pendingElapsed >= FRAME_INTERVAL_MS
          ? pendingElapsed % FRAME_INTERVAL_MS
          : 0;
      return true;
    },
    reset() {
      pendingElapsed = 0;
    },
  };
}

type ShaderFrameTarget = Pick<ShaderMount, "setFrame">;

interface AnimationFrameDriver {
  request: (callback: FrameRequestCallback) => number;
  cancel: (handle: number) => void;
}

export interface ZenShaderAnimationScheduler {
  start: (speed: number) => void;
  stop: () => void;
  reset: () => void;
  getFrame: () => number;
}

export function createZenShaderAnimationScheduler(
  getTarget: () => ShaderFrameTarget | null | undefined,
  driver: AnimationFrameDriver = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  },
): ZenShaderAnimationScheduler {
  let running = false;
  let requestHandle: number | null = null;
  let lastTimestamp: number | null = null;
  let shaderFrame = 0;
  let speed = 0;
  const cadence = createZenShaderFrameCadence();

  function schedule() {
    requestHandle = driver.request(tick);
  }

  function tick(timestamp: number) {
    requestHandle = null;
    if (!running) return;

    if (lastTimestamp === null) {
      lastTimestamp = timestamp;
    } else {
      const elapsed = Math.max(0, timestamp - lastTimestamp);
      shaderFrame += elapsed * speed;
      lastTimestamp = timestamp;
      if (cadence.advance(elapsed)) {
        const target = getTarget();
        if (target) target.setFrame(shaderFrame);
      }
    }

    if (running) schedule();
  }

  function stop() {
    running = false;
    lastTimestamp = null;
    cadence.reset();
    if (requestHandle !== null) {
      driver.cancel(requestHandle);
      requestHandle = null;
    }
  }

  return {
    start(nextSpeed) {
      speed = Number.isFinite(nextSpeed) ? Math.max(0, nextSpeed) : 0;
      if (speed === 0) {
        stop();
        return;
      }
      if (running) return;
      running = true;
      lastTimestamp = null;
      cadence.reset();
      schedule();
    },
    stop,
    reset() {
      shaderFrame = 0;
      lastTimestamp = null;
      cadence.reset();
    },
    getFrame() {
      return shaderFrame;
    },
  };
}

export function useZenShaderAnimation(
  elementRef: RefObject<PaperShaderElement | null>,
  options: {
    playing: boolean;
    speed: number;
    resetKey: string;
  },
) {
  const schedulerRef = useRef<ZenShaderAnimationScheduler | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = createZenShaderAnimationScheduler(
      () => elementRef.current?.paperShaderMount,
    );
  }

  useEffect(() => {
    schedulerRef.current?.stop();
    schedulerRef.current?.reset();
  }, [options.resetKey]);

  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (options.playing) scheduler?.start(options.speed);
    else scheduler?.stop();
    return () => scheduler?.stop();
  }, [options.playing, options.resetKey, options.speed]);
}
