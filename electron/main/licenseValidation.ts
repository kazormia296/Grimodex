/**
 * Electron main のライセンス再検証スケジューラ（Phase 3e）。
 *
 * 状態機械・license.json・Polar通信・single-flightは共有Rust backendが担う。
 * mainはTauri setupと同じ「起動5秒後、以後は前cycle完了から6時間後」を管理し、
 * DTOが返った場合だけ全窓へ `license:state_changed` を配信する。
 */

const INITIAL_DELAY_MS = 5_000;
const VALIDATION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface LicenseValidationBackendLike {
  /** JSON DTO。検証不要/disabled/in-flight skip は null。 */
  runLicenseValidateCycle?(): Promise<string | null>;
}

export interface LicenseValidationScheduler {
  start(): void;
  dispose(): void;
  /** Main-only D2a barrier: stop new cycles and await the admitted cycle. */
  quiesceForProfileEgress(): Promise<void>;
  /** Main-only admission for manual license mutations. */
  runManualOperation<T>(operation: () => Promise<T>): Promise<T>;
}

interface SchedulerOptions {
  warn?: (...args: unknown[]) => void;
  /** Startup is disabled while the persisted profile gate is restricted. */
  startEnabled?: boolean;
}

type Broadcast = (channel: string, payload: unknown) => void;

export function createLicenseValidationScheduler(
  backend: LicenseValidationBackendLike | null,
  broadcast: Broadcast,
  options: SchedulerOptions = {},
): LicenseValidationScheduler {
  const warn = options.warn ?? console.warn;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let disposed = false;
  let inFlightCycle: Promise<void> | null = null;
  const manualOperations = new Set<Promise<unknown>>();
  let quiescenceFlight: Promise<void> | null = null;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number): void => {
    if (disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void runCycle();
    }, delayMs);
  };

  const runCycle = (): Promise<void> => {
    if (disposed || inFlightCycle !== null) return Promise.resolve();
    const method = backend?.runLicenseValidateCycle;
    if (typeof method !== "function") return Promise.resolve();

    const cycle = (async (): Promise<void> => {
      try {
        // bindを失うとnapi class methodのselfが壊れるためbackend経由で呼ぶ。
        const result = await method.call(backend);
        if (disposed) return;
        if (result !== null) {
          const payload = JSON.parse(result) as unknown;
          if (!disposed) broadcast("license:state_changed", payload);
        }
      } catch (error) {
        if (!disposed) {
          warn("[license] background validation cycle failed:", error);
        }
      } finally {
        // setIntervalではなく、通信を含むcycle完了から6時間を数える。
        if (!disposed) schedule(VALIDATION_INTERVAL_MS);
      }
    })();
    inFlightCycle = cycle;
    void cycle.then(
      () => {
        if (inFlightCycle === cycle) inFlightCycle = null;
      },
      () => {
        if (inFlightCycle === cycle) inFlightCycle = null;
      },
    );
    return cycle;
  };

  const runManualOperation = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (disposed) {
      return Promise.reject(
        new Error("license validation is closed for profile egress"),
      );
    }

    let admitted: Promise<T>;
    try {
      // Invoke synchronously after the admission check so activation cannot
      // begin between admission and the actual backend call.
      admitted = Promise.resolve(operation());
    } catch (error) {
      admitted = Promise.reject(error);
    }
    manualOperations.add(admitted);
    void admitted.then(
      () => manualOperations.delete(admitted),
      () => manualOperations.delete(admitted),
    );
    return admitted;
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      if (options.startEnabled === false) return;
      if (typeof backend?.runLicenseValidateCycle !== "function") {
        warn(
          "[license] background validation disabled: native method unavailable",
        );
        return;
      }
      schedule(INITIAL_DELAY_MS);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimer();
      // in-flight native callは安全に取消できない。完了後のemit/rescheduleは
      // disposed guardで抑止する。
    },

    quiesceForProfileEgress(): Promise<void> {
      if (quiescenceFlight) return quiescenceFlight;
      disposed = true;
      clearTimer();
      const pending = [
        ...(inFlightCycle ? [inFlightCycle] : []),
        ...manualOperations,
      ];
      // A manual mutation's application/network result belongs to its
      // caller. Once that promise settles, it is no longer an in-flight
      // transport and must not turn an otherwise successful activation into
      // an unavailable profile.
      quiescenceFlight = Promise.allSettled(pending).then(() => undefined);
      return quiescenceFlight;
    },

    runManualOperation,
  };
}
