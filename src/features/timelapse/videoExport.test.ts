// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { captureCanvasToWebm } from "./videoExport";

/**
 * Stub MediaRecorder so happy-dom (which lacks it) can still exercise the
 * orchestrator. The stub does not produce actual video bytes; it emits a
 * synthetic Blob chunk on stop so we can assert the returned Blob is
 * constructed from collected chunks.
 */
function makeStubRecorder(): {
  Ctor: typeof MediaRecorder;
  instances: { started: boolean; stopped: boolean }[];
} {
  const instances: { started: boolean; stopped: boolean }[] = [];
  class StubRecorder {
    private listeners = new Map<string, ((e: unknown) => void)[]>();
    private record = { started: false, stopped: false };
    state: "inactive" | "recording" | "paused" = "inactive";
    constructor() {
      instances.push(this.record);
    }
    addEventListener(type: string, cb: (e: unknown) => void) {
      const arr = this.listeners.get(type) ?? [];
      arr.push(cb);
      this.listeners.set(type, arr);
    }
    dispatch(type: string, e: unknown) {
      const arr = this.listeners.get(type) ?? [];
      for (const cb of arr) cb(e);
    }
    start() {
      this.record.started = true;
      this.state = "recording";
    }
    stop() {
      this.record.stopped = true;
      this.state = "inactive";
      this.dispatch("dataavailable", {
        data: new Blob([new Uint8Array([0, 1, 2])], { type: "video/webm" }),
      });
      this.dispatch("stop", {});
    }
  }
  return { Ctor: StubRecorder as unknown as typeof MediaRecorder, instances };
}

function makeCanvasWithStream(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 100;
  canvas.height = 100;
  // happy-dom does not implement captureStream — stub it.
  (canvas as unknown as { captureStream: () => MediaStream }).captureStream =
    () => ({}) as unknown as MediaStream;
  return canvas;
}

describe("captureCanvasToWebm", () => {
  it("starts/stops the recorder and returns a Blob containing collected chunks", async () => {
    const { Ctor, instances } = makeStubRecorder();
    const canvas = makeCanvasWithStream();

    let calls = 0;
    const drawFrame = vi.fn(async () => {
      calls += 1;
      return calls >= 3;
    });

    const blob = await captureCanvasToWebm(canvas, {
      fps: 60,
      drawFrame,
      MediaRecorderCtor: Ctor,
    });
    expect(drawFrame).toHaveBeenCalledTimes(3);
    expect(instances[0].started).toBe(true);
    expect(instances[0].stopped).toBe(true);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
  });

  it("respects maxFrames as a safety cap", async () => {
    const { Ctor } = makeStubRecorder();
    const canvas = makeCanvasWithStream();
    const drawFrame = vi.fn(async () => false);
    await captureCanvasToWebm(canvas, {
      fps: 120,
      drawFrame,
      MediaRecorderCtor: Ctor,
      maxFrames: 5,
    });
    expect(drawFrame).toHaveBeenCalledTimes(5);
  });
});
