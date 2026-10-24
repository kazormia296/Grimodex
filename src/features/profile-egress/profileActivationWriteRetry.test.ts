import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import {
  _resetQuiescenceParticipantsForTests,
  registerQuiescenceParticipant,
} from "@/application/lifecycle/quiescenceParticipants";
import {
  _resetMapPersistenceWritesForTests,
  scheduleMapFrameResizeWrite,
} from "@/features/map/hooks/mapPersistenceWriteQueue";
import { createStickyDraftController } from "@/features/sticky/stickyDraftController";
import {
  ACTIVATION_WRITE_RETRY_DELAYS_MS,
  _resetWritesRetryAfterActivationForTests,
  retryWritesAfterActivation,
  startWritesRetryAfterActivation,
} from "./profileActivationWriteRetry";

// W-1 (K3/2; DR-DA2B-R8): a generic DB write refused from activation stage 4
// to 7 keeps its draft and is written by the bounded retry after the
// activation completes. The retry runs the real strict flush over the real
// participant registry (a sticky draft registered as `StickyNode` registers
// it) and the real Map write queue; only the persistence calls are faked.

const h = vi.hoisted(() => ({
  updateFrame: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-a",
}));
vi.mock("@/features/map/mapApi", () => ({
  updateMapBoardSettings: vi.fn(),
  updateFrame: h.updateFrame,
}));
vi.mock("sonner", () => ({ toast: { error: h.toastError } }));

const STAGE_REFUSAL =
  "db_execute rejected: D2A_EGRESS_DENIED: plaintext-publication: publication is closed during startup quiescence";
const BODY = '{"type":"doc","content":[{"type":"text","text":"x"}]}';

function refused(): Promise<never> {
  return Promise.reject(new Error(STAGE_REFUSAL));
}

/** The participant `StickyNode` registers for its draft controller. */
function registerSticky(persist: (body: string) => Promise<void>) {
  const draft = createStickyDraftController("sticky-1", "{}");
  draft.setPersist(persist);
  registerQuiescenceParticipant({
    id: `sticky:${draft.id}`,
    flush: () => draft.save(),
    discard: () => draft.discard(),
  });
  return draft;
}

/** A Map frame resize whose debounced write is refused inside stages 4..7. */
async function refusedFrameResize(): Promise<void> {
  h.updateFrame.mockImplementationOnce(refused);
  scheduleMapFrameResizeWrite({
    projectId: "project-a",
    boardId: "board-a",
    frameId: "frame-a",
    width: 320,
    height: 200,
  });
  await vi.runOnlyPendingTimersAsync();
  expect(h.updateFrame).toHaveBeenCalledTimes(1);
}

const TOTAL_DELAY_MS = ACTIVATION_WRITE_RETRY_DELAYS_MS.reduce(
  (sum, ms) => sum + ms,
  0,
);

/**
 * Runs the retry with the real dependencies under fake timers for the whole
 * schedule, and requires it to have settled by then.
 */
async function runRetry(): Promise<boolean> {
  const result = startWritesRetryAfterActivation();
  expect(result).not.toBeNull();
  let settled: boolean | undefined;
  void result?.then((value) => {
    settled = value;
  });
  await vi.advanceTimersByTimeAsync(TOTAL_DELAY_MS);
  expect(settled).toBeDefined();
  return settled as boolean;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetQuiescenceLeasesForTests();
  _resetQuiescenceParticipantsForTests();
  _resetMapPersistenceWritesForTests();
  _resetWritesRetryAfterActivationForTests();
  h.updateFrame.mockReset();
  h.updateFrame.mockResolvedValue(undefined);
  h.toastError.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the retry of the writes refused during the activation (W-1)", () => {
  it("writes a refused sticky body and a refused Map write after the activation completes", async () => {
    const persist = vi
      .fn<(body: string) => Promise<void>>()
      .mockImplementationOnce(refused)
      .mockResolvedValue(undefined);
    const draft = registerSticky(persist);
    draft.markDirty(BODY);
    // Stage 4..7: the sticky's save and the Map's write are refused.
    await expect(draft.save()).rejects.toThrow("D2A_EGRESS_DENIED");
    expect(draft.dirty).toBe(true);
    await refusedFrameResize();

    // restricted: the retry's first attempt writes both.
    expect(await runRetry()).toBe(true);
    expect(draft.dirty).toBe(false);
    expect(persist.mock.calls.map(([body]) => body)).toEqual([BODY, BODY]);
    expect(h.updateFrame).toHaveBeenCalledTimes(2);
    expect(h.updateFrame).toHaveBeenLastCalledWith("frame-a", {
      width: 320,
      height: 200,
    });
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("keeps the draft dirty when an attempt is refused again, and writes it on a later one", async () => {
    const persist = vi
      .fn<(body: string) => Promise<void>>()
      .mockImplementationOnce(refused)
      .mockImplementationOnce(refused)
      .mockResolvedValue(undefined);
    const draft = registerSticky(persist);
    draft.markDirty(BODY);
    await expect(draft.save()).rejects.toThrow("D2A_EGRESS_DENIED");

    const result = startWritesRetryAfterActivation();
    await vi.advanceTimersByTimeAsync(ACTIVATION_WRITE_RETRY_DELAYS_MS[0]);
    // The first attempt was refused: nothing is lost, nothing is reported.
    expect(persist).toHaveBeenCalledTimes(2);
    expect(draft.dirty).toBe(true);
    expect(draft.latestBody).toBe(BODY);

    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(draft.dirty).toBe(false);
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("stops after a bounded number of attempts and leaves a visible failure", async () => {
    const persist = vi
      .fn<(body: string) => Promise<void>>()
      .mockImplementation(refused);
    const draft = registerSticky(persist);
    draft.markDirty(BODY);
    await expect(draft.save()).rejects.toThrow("D2A_EGRESS_DENIED");
    await refusedFrameResize();
    h.updateFrame.mockImplementation(refused);

    expect(await runRetry()).toBe(false);
    const attempts = ACTIVATION_WRITE_RETRY_DELAYS_MS.length;
    expect(attempts).toBe(4);
    expect(persist).toHaveBeenCalledTimes(1 + attempts);
    expect(h.updateFrame).toHaveBeenCalledTimes(1 + attempts);
    expect(draft.dirty).toBe(true);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(String(h.toastError.mock.calls[0]?.[0])).not.toContain(
      "D2A_EGRESS_DENIED",
    );

    // Nothing more is scheduled after it gave up.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persist).toHaveBeenCalledTimes(1 + attempts);
    // The draft is still there for the next save.
    persist.mockResolvedValue(undefined);
    await draft.save();
    expect(draft.dirty).toBe(false);
  });

  it("skips an attempt while a lifecycle lease owns the flush", async () => {
    const persist = vi
      .fn<(body: string) => Promise<void>>()
      .mockImplementationOnce(refused)
      .mockResolvedValue(undefined);
    const draft = registerSticky(persist);
    draft.markDirty(BODY);
    await expect(draft.save()).rejects.toThrow("D2A_EGRESS_DENIED");

    const lease = acquireQuiescenceLease("project-load");
    const result = startWritesRetryAfterActivation();
    await vi.advanceTimersByTimeAsync(ACTIVATION_WRITE_RETRY_DELAYS_MS[0]);
    expect(persist).toHaveBeenCalledTimes(1);
    lease.release();

    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(draft.dirty).toBe(false);
  });

  it("starts once per renderer process", async () => {
    const first = startWritesRetryAfterActivation();
    expect(first).not.toBeNull();
    expect(startWritesRetryAfterActivation()).toBeNull();
    await vi.runAllTimersAsync();
    await expect(first).resolves.toBe(true);
    expect(startWritesRetryAfterActivation()).toBeNull();
  });

  it("does not report a failure when every attempt was left to a lifecycle", async () => {
    const flush = vi.fn<() => Promise<void>>();
    const notifyFailure = vi.fn();
    let waits = 0;
    await expect(
      retryWritesAfterActivation({
        flush,
        canFlush: () => false,
        wait: () => {
          waits += 1;
          // An unbounded loop fails here instead of starving the worker.
          if (waits > 10) throw new Error("unbounded retry");
          return Promise.resolve();
        },
        notifyFailure,
      }),
    ).resolves.toBe(false);
    expect(waits).toBe(ACTIVATION_WRITE_RETRY_DELAYS_MS.length);
    expect(flush).not.toHaveBeenCalled();
    expect(notifyFailure).not.toHaveBeenCalled();
  });
});
