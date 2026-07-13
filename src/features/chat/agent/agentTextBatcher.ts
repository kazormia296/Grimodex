export type ScheduleAgentTextFrame = (callback: () => void) => number;
export type CancelAgentTextFrame = (handle: number) => void;

function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return setTimeout(callback, 0) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
  } else {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }
}

/** Coalesce agent-loop responses so the message list is published once/frame. */
export function createAgentTextBatcher(
  publish: (text: string) => void,
  schedule: ScheduleAgentTextFrame = scheduleFrame,
  cancel: CancelAgentTextFrame = cancelFrame,
): {
  push: (text: string) => void;
  flush: () => void;
  dispose: () => void;
} {
  let pending = "";
  let handle: number | null = null;
  let disposed = false;

  const flush = () => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
    if (!pending || disposed) {
      pending = "";
      return;
    }
    const text = pending;
    pending = "";
    publish(text);
  };

  const push = (text: string) => {
    if (disposed || !text) return;
    pending += pending ? `\n\n${text}` : text;
    if (handle === null) handle = schedule(flush);
  };

  const dispose = () => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
    pending = "";
    disposed = true;
  };

  return { push, flush, dispose };
}
