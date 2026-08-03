interface AnimationFrameDriver {
  request: (callback: FrameRequestCallback) => number;
  cancel: (handle: number) => void;
}

export interface ZenShaderDrawInvalidator {
  invalidate: () => void;
  flush: (timestamp: number) => void;
  dispose: () => void;
}

/** Coalesces every mutation observed during a display frame into one GPU draw. */
export function createZenShaderDrawInvalidator(
  draw: (timestamp: number) => void,
  driver: AnimationFrameDriver = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  },
): ZenShaderDrawInvalidator {
  let handle: number | null = null;
  let disposed = false;

  const flush = (timestamp: number) => {
    handle = null;
    if (!disposed) draw(timestamp);
  };

  return {
    invalidate() {
      if (disposed || handle !== null) return;
      handle = driver.request(flush);
    },
    flush,
    dispose() {
      disposed = true;
      if (handle !== null) driver.cancel(handle);
      handle = null;
    },
  };
}
