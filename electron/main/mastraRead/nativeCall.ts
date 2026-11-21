import { MainReadError } from "./errors.js";

/**
 * The hooks a read lifecycle puts around a Native read call (DR-MP4-5). Both
 * are optional here because no turn is connected yet (MP-4b PR-1): PR-2 passes
 * the turn's `assertLive` and its in-flight count. With neither, nothing runs.
 */
export interface MainReadHooks {
  /**
   * Called synchronously just before the call is sent and again after it
   * answered. A throw before the send means Native is not called; a throw after
   * discards the result. It stands where the renderer's path checks the
   * workspace identity after a semantic call: main has no after-the-fact
   * identity comparison, it re-checks the turn instead.
   */
  readonly assertLive?: () => void;
  /**
   * Handed a promise that settles (never rejects) when the Native call itself
   * settles, whatever the caller's timeout did. The count it keeps must stay up
   * until then: a caller timeout does not stop Native.
   */
  readonly trackInFlight?: (settled: Promise<void>) => void;
}

/**
 * Runs one Native read with the caller's timeout and the lifecycle hooks.
 * `timeoutMs === null` waits for Native (the one command with no caller
 * timeout, as in the renderer).
 */
export async function runNativeRead<T>(
  call: () => Promise<T>,
  options: {
    readonly command: string;
    readonly timeoutMs: number | null;
    readonly hooks?: MainReadHooks | undefined;
  },
): Promise<T> {
  const hooks = options.hooks;
  hooks?.assertLive?.();
  let started: Promise<T>;
  try {
    started = call();
  } catch (error) {
    started = Promise.reject(error);
  }
  hooks?.trackInFlight?.(
    started.then(
      () => undefined,
      () => undefined,
    ),
  );
  const value = await withCallerTimeout(
    started,
    options.timeoutMs,
    options.command,
  );
  hooks?.assertLive?.();
  return value;
}

/**
 * Settles with `promise`, or rejects with a `timeout` error after `timeoutMs`.
 * The promise's own late result is observed and dropped (no unhandled
 * rejection), and the timer is cleared as soon as it settles.
 */
export function withCallerTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | null,
  command: string,
): Promise<T> {
  if (timeoutMs === null) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new MainReadError(
          "timeout",
          `${command} did not answer within ${timeoutMs} ms`,
          { command },
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
