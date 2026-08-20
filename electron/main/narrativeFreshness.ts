/**
 * Electron main 専用の Change Feed freshness scheduler。
 *
 * Durable reservation / replay / publish / ack とbatch上限は共有Rust runtimeが
 * 担う。mainはcycleを直列化し、backlogを示す `hasMore` だけを使って次の有界
 * cycleを早める。renderer IPC / preload surfaceは持たない。
 */

const INITIAL_DELAY_MS = 250;
const IDLE_POLL_INTERVAL_MS = 1_000;
const BACKLOG_DELAY_MS = 10;
const ERROR_RETRY_DELAY_MS = 1_000;

export interface NarrativeFreshnessBackendLike {
  /** JSON batch summary。feed空 / workspace unavailable / in-flight skipはnull。 */
  runNarrativeFreshnessCycle?(): Promise<string | null>;
}

export interface NarrativeFreshnessScheduler {
  start(): void;
  dispose(): void;
}

interface SchedulerOptions {
  warn?: (...args: unknown[]) => void;
}

function batchHasMore(raw: string): boolean {
  const value = JSON.parse(raw) as unknown;
  return (
    typeof value === "object" &&
    value !== null &&
    "hasMore" in value &&
    value.hasMore === true
  );
}

export function createNarrativeFreshnessScheduler(
  backend: NarrativeFreshnessBackendLike | null,
  options: SchedulerOptions = {},
): NarrativeFreshnessScheduler {
  const warn = options.warn ?? console.warn;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let disposed = false;
  let inFlight = false;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number): void => {
    if (disposed) return;
    // start()やcycle完了が同じtickに重なってもpending wakeupは1件に畳む。
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void runCycle();
    }, delayMs);
  };

  const runCycle = async (): Promise<void> => {
    if (disposed || inFlight) return;
    const method = backend?.runNarrativeFreshnessCycle;
    if (typeof method !== "function") return;

    inFlight = true;
    let nextDelayMs = IDLE_POLL_INTERVAL_MS;
    try {
      // napi class methodはbindを失うとselfが壊れるためbackend経由で呼ぶ。
      const result = await method.call(backend);
      if (disposed) return;
      if (result !== null && batchHasMore(result)) {
        nextDelayMs = BACKLOG_DELAY_MS;
      }
    } catch (error) {
      nextDelayMs = ERROR_RETRY_DELAY_MS;
      if (!disposed) {
        warn("[narrative-freshness] background cycle failed:", error);
      }
    } finally {
      inFlight = false;
      // setIntervalを使わず、必ず前cycle完了後に次の1件だけを予約する。
      if (!disposed) schedule(nextDelayMs);
    }
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      if (typeof backend?.runNarrativeFreshnessCycle !== "function") {
        warn(
          "[narrative-freshness] background runtime disabled: native method unavailable",
        );
        return;
      }
      schedule(INITIAL_DELAY_MS);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimer();
      // in-flight native callは強制取消しない。完了後の再scheduleだけを抑止する。
    },
  };
}
