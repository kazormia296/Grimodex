import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLicenseValidationScheduler } from "./licenseValidation.js";

const INITIAL_DELAY_MS = 5_000;
const VALIDATION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const LICENSE_DTO = {
  licensingEnabled: true,
  status: "license_stale",
  trialDaysRemaining: null,
  graceDaysRemaining: null,
  keyTail: "1234",
  activatedAt: "2026-06-01T00:00:00Z",
  lastValidatedAt: "2026-06-01T00:00:00Z",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createLicenseValidationScheduler", () => {
  const schedulers: Array<{ dispose(): void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createScheduler(
    backend: unknown,
    broadcast = vi.fn(),
    warn = vi.fn(),
  ) {
    const scheduler = createLicenseValidationScheduler(
      backend as Parameters<typeof createLicenseValidationScheduler>[0],
      broadcast,
      { warn },
    );
    schedulers.push(scheduler);
    return { scheduler, broadcast, warn };
  }

  it("startから5秒後に初回cycleを実行する", async () => {
    const runLicenseValidateCycle = vi.fn().mockResolvedValue(null);
    const { scheduler } = createScheduler({ runLicenseValidateCycle });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(runLicenseValidateCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runLicenseValidateCycle).toHaveBeenCalledOnce();
  });

  it("次のcycleは前回cycleの完了時点から6時間後に実行する", async () => {
    const first = deferred<string | null>();
    const runLicenseValidateCycle = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(null);
    const { scheduler } = createScheduler({ runLicenseValidateCycle });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runLicenseValidateCycle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(VALIDATION_INTERVAL_MS * 2);
    expect(runLicenseValidateCycle).toHaveBeenCalledOnce();

    first.resolve(null);
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(VALIDATION_INTERVAL_MS - 1);
    expect(runLicenseValidateCycle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(runLicenseValidateCycle).toHaveBeenCalledTimes(2);
  });

  it("長時間のin-flight cycleを重複実行しない", async () => {
    const first = deferred<string | null>();
    const runLicenseValidateCycle = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(null);
    const { scheduler } = createScheduler({ runLicenseValidateCycle });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(VALIDATION_INTERVAL_MS * 3);
    expect(runLicenseValidateCycle).toHaveBeenCalledOnce();

    first.resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(VALIDATION_INTERVAL_MS);
    expect(runLicenseValidateCycle).toHaveBeenCalledTimes(2);
  });

  it("JSON DTOをlicense:state_changedとしてそのままbroadcastする", async () => {
    const runLicenseValidateCycle = vi
      .fn()
      .mockResolvedValue(JSON.stringify(LICENSE_DTO));
    const { scheduler, broadcast } = createScheduler({
      runLicenseValidateCycle,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      "license:state_changed",
      LICENSE_DTO,
    );
  });

  it("cycleがnullを返した場合はbroadcastしない", async () => {
    const runLicenseValidateCycle = vi.fn().mockResolvedValue(null);
    const { scheduler, broadcast } = createScheduler({
      runLicenseValidateCycle,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(broadcast).not.toHaveBeenCalled();
  });

  it("cycle失敗をwarnして次の6時間周期を継続する", async () => {
    const runLicenseValidateCycle = vi
      .fn()
      .mockRejectedValueOnce(new Error("Polar unavailable"))
      .mockResolvedValue(null);
    const { scheduler, broadcast, warn } = createScheduler({
      runLicenseValidateCycle,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().map(String).join(" ")).toContain(
      "Polar unavailable",
    );
    expect(broadcast).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(VALIDATION_INTERVAL_MS);
    expect(runLicenseValidateCycle).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["backendがnull", null],
    ["旧bindingにcycle methodがない", {}],
  ])("%s場合もfail-softで停止する", async (_label, backend) => {
    const { scheduler, broadcast, warn } = createScheduler(backend);

    expect(() => scheduler.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(
      INITIAL_DELAY_MS + VALIDATION_INTERVAL_MS,
    );

    expect(broadcast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("初回timer前のdisposeはcycleを開始せず、複数回呼んでも安全", async () => {
    const runLicenseValidateCycle = vi.fn().mockResolvedValue(null);
    const { scheduler, broadcast } = createScheduler({
      runLicenseValidateCycle,
    });

    scheduler.start();
    expect(() => {
      scheduler.dispose();
      scheduler.dispose();
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(
      INITIAL_DELAY_MS + VALIDATION_INTERVAL_MS,
    );

    expect(runLicenseValidateCycle).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("in-flight中のdisposeは完了後のemitと再scheduleを抑止する", async () => {
    const first = deferred<string | null>();
    const runLicenseValidateCycle = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(null);
    const { scheduler, broadcast } = createScheduler({
      runLicenseValidateCycle,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runLicenseValidateCycle).toHaveBeenCalledOnce();

    scheduler.dispose();
    scheduler.dispose();
    first.resolve(JSON.stringify(LICENSE_DTO));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(VALIDATION_INTERVAL_MS * 2);

    expect(broadcast).not.toHaveBeenCalled();
    expect(runLicenseValidateCycle).toHaveBeenCalledOnce();
  });
});
