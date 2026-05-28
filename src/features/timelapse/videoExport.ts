/**
 * 執筆タイムラプス video export — thin MediaRecorder wrapper.
 *
 * The caller (TimelapsePlayer / future export UI) is responsible for
 * driving the canvas through the desired frames; this module just turns
 * `canvas.captureStream()` into a webm Blob and resolves once the recorder
 * stops.
 *
 * MediaRecorder is a browser-only API. happy-dom (vitest's default) does
 * not implement it, so the public surface is structured so unit tests can
 * exercise the orchestrator with an injected `MediaRecorder` ctor.
 */

const DEFAULT_FPS = 30;
const DEFAULT_MIME = "video/webm;codecs=vp9";

export interface CaptureWebmOptions {
  /** Frames per second the captureStream() should emit. Defaults to 30. */
  fps?: number;
  /** MediaRecorder mimeType. Defaults to "video/webm;codecs=vp9". */
  mimeType?: string;
  /** MediaRecorder bitsPerSecond. Defaults to browser default. */
  videoBitsPerSecond?: number;
  /**
   * Called once per frame; should mutate the canvas in-place. Resolves to
   * `true` when there are no more frames (recording stops).
   */
  drawFrame: (frameIndex: number) => boolean | Promise<boolean>;
  /**
   * Optional total-frame hint used as a safety cap so a buggy `drawFrame`
   * that never returns `true` cannot record forever. Defaults to 30 * 60 * 60
   * (one hour at 30 fps).
   */
  maxFrames?: number;
  /**
   * Test seam — override `MediaRecorder` for unit tests. Defaults to the
   * global symbol. Throws synchronously if neither is available.
   */
  MediaRecorderCtor?: typeof MediaRecorder;
}

export async function captureCanvasToWebm(
  canvas: HTMLCanvasElement,
  opts: CaptureWebmOptions,
): Promise<Blob> {
  const Ctor =
    opts.MediaRecorderCtor ??
    (typeof MediaRecorder !== "undefined" ? MediaRecorder : null);
  if (!Ctor) {
    throw new Error("MediaRecorder is not available in this environment");
  }
  const fps = opts.fps ?? DEFAULT_FPS;
  const maxFrames = opts.maxFrames ?? fps * 60 * 60;
  const stream = canvas.captureStream(fps);
  const recorder = new Ctor(stream, {
    mimeType: opts.mimeType ?? DEFAULT_MIME,
    ...(opts.videoBitsPerSecond
      ? { videoBitsPerSecond: opts.videoBitsPerSecond }
      : {}),
  });

  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (e: BlobEvent) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener("stop", () => {
      try {
        resolve(new Blob(chunks, { type: opts.mimeType ?? DEFAULT_MIME }));
      } catch (e) {
        reject(e);
      }
    });
    recorder.addEventListener("error", (e) => reject(e));
  });

  recorder.start();
  try {
    const frameMs = 1000 / fps;
    for (let i = 0; i < maxFrames; i += 1) {
      const done = await opts.drawFrame(i);
      if (done) break;
      // Yield to the captureStream so the painted canvas is sampled.
      await new Promise((r) => setTimeout(r, frameMs));
    }
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
  }
  return finished;
}
