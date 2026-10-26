import { describe, expect, it } from "vitest";
import type {
  Nir1LocalCancelResult,
  Nir1LocalContinueResult,
  Nir1LocalStartResult,
} from "@/features/chat/nir1/nir1LocalGenerationApi";
import {
  createNir1LocalGenerationTurn,
  NIR1_LOCAL_HELD_MAX_BACKOFF_MS,
  NIR1_LOCAL_MAX_HELD_MS,
  NIR1_LOCAL_POLL_IDLE_MS,
  type Nir1LocalTurnPorts,
  type Nir1LocalTurnSnapshot,
} from "./nir1LocalGenerationTurn";

// DD-1c (DR-DD1C-4〜6): the renderer's state machine of one local generation.
// Every IPC answer is a deferred promise the test settles, and the timer is a
// manual queue, so each race of the lifecycle matrix is played in order.

const HANDLE = "0123456789abcdef0123456789abcdef";
const TARGET = {
  purpose: "writing" as const,
  conversationId: "nir1-local-writing-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sceneId: "scene-1",
};

interface Deferred<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

function harness() {
  const starts: Deferred<Nir1LocalStartResult>[] = [];
  const continues: Array<
    { handle: string } & Deferred<Nir1LocalContinueResult>
  > = [];
  const cancels: Array<{ handle: string } & Deferred<Nir1LocalCancelResult>> =
    [];
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const clock = { ms: 0 };
  let inFlightContinues = 0;
  let maxInFlightContinues = 0;
  const snapshots: Nir1LocalTurnSnapshot[] = [];
  const ports: Nir1LocalTurnPorts = {
    start: () =>
      new Promise((resolve, reject) => starts.push({ resolve, reject })),
    continue: (handle) => {
      inFlightContinues += 1;
      maxInFlightContinues = Math.max(maxInFlightContinues, inFlightContinues);
      return new Promise<Nir1LocalContinueResult>((resolve, reject) =>
        continues.push({ handle, resolve, reject }),
      ).finally(() => {
        inFlightContinues -= 1;
      });
    },
    cancel: (handle) =>
      new Promise((resolve, reject) =>
        cancels.push({ handle, resolve, reject }),
      ),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    now: () => clock.ms,
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  };
  const turn = createNir1LocalGenerationTurn(TARGET, ports, (snapshot) =>
    snapshots.push(snapshot),
  );
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** Run the pending timers (in order) and let their calls start. */
  const tick = async () => {
    const due = timers.splice(0).filter((timer) => !timer.cleared);
    // The manual clock moves by the longest wait that was due.
    clock.ms += Math.max(0, ...due.map((timer) => timer.ms));
    for (const timer of due) timer.run();
    await flush();
  };
  const ok = (
    patch: Partial<Extract<Nir1LocalContinueResult, { status: "ok" }>> = {},
  ): Nir1LocalContinueResult => ({
    status: "ok",
    text: "",
    thinking: "",
    state: "running",
    terminalCode: null,
    drained: false,
    ...patch,
  });
  const begin = async () => {
    turn.start();
    starts[0].resolve({ status: "started", handle: HANDLE });
    await flush();
  };
  return {
    turn,
    starts,
    continues,
    cancels,
    timers,
    clock,
    snapshots,
    flush,
    tick,
    ok,
    begin,
    get maxInFlightContinues() {
      return maxInFlightContinues;
    },
  };
}

describe("the local generation state machine (DD-1c)", () => {
  it("polls the handle to the drained terminal and drops it", async () => {
    const h = harness();
    await h.begin();
    expect(h.turn.snapshot().phase).toBe("running");
    await h.tick();
    expect(h.continues).toHaveLength(1);
    expect(h.continues[0].handle).toBe(HANDLE);
    h.continues[0].resolve(h.ok({ text: "一", thinking: "思" }));
    await h.flush();
    // A delta asks for the next continue at once.
    expect(h.timers.at(-1)?.ms).toBe(0);
    await h.tick();
    h.continues[1].resolve(h.ok());
    await h.flush();
    // Nothing new: wait before the next continue.
    expect(h.timers.at(-1)?.ms).toBe(NIR1_LOCAL_POLL_IDLE_MS);
    await h.tick();
    h.continues[2].resolve(h.ok({ text: "二", state: "succeeded" }));
    await h.flush();
    await h.tick();
    h.continues[3].resolve(
      h.ok({ state: "succeeded", terminalCode: "completed", drained: true }),
    );
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "succeeded",
      text: "一二",
      thinking: "思",
      terminalCode: "completed",
      canCancel: false,
    });
    await h.tick();
    expect(h.continues).toHaveLength(4);
    expect(h.maxInFlightContinues).toBe(1);
  });

  it("dispatches the start only once (no re-press of the same capture)", async () => {
    const h = harness();
    h.turn.start();
    h.turn.start();
    expect(h.starts).toHaveLength(1);
    h.starts[0].resolve({
      status: "unavailable",
      reason: "NIR1_LOCAL_ALREADY_STARTED",
    });
    await h.flush();
    h.turn.start();
    expect(h.starts).toHaveLength(1);
    expect(h.turn.snapshot()).toMatchObject({
      phase: "refused",
      reason: "NIR1_LOCAL_ALREADY_STARTED",
      canCancel: false,
    });
  });

  it.each([
    [{ status: "error", error: "egress-denied" } as const, "refused"],
    [{ status: "unknown" } as const, "unknown"],
  ])("ends a start answered %o without polling", async (answer, phase) => {
    const h = harness();
    h.turn.start();
    h.starts[0].resolve(answer);
    await h.flush();
    await h.tick();
    expect(h.turn.snapshot().phase).toBe(phase);
    expect(h.continues).toHaveLength(0);
    expect(h.cancels).toHaveLength(0);
  });

  it("ends a start whose IPC throws", async () => {
    const h = harness();
    h.turn.start();
    h.starts[0].reject(new Error("socket"));
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "refused",
      ipcError: "failed",
    });
  });

  it("stops with the one cancel command as soon as a pending start returns", async () => {
    const h = harness();
    h.turn.start();
    h.turn.cancel();
    h.turn.cancel();
    expect(h.cancels).toHaveLength(0);
    expect(h.turn.snapshot()).toMatchObject({
      phase: "starting",
      cancelRequested: true,
      canCancel: false,
    });
    h.starts[0].resolve({ status: "started", handle: HANDLE });
    await h.flush();
    expect(h.cancels.map(({ handle }) => handle)).toEqual([HANDLE]);
    h.cancels[0].resolve({ status: "ok" });
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("cancelling");
    await h.tick();
    h.continues[0].resolve(
      h.ok({ state: "cancelled", terminalCode: "cancelled", drained: true }),
    );
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("cancelled");
    expect(h.cancels).toHaveLength(1);
  });

  it("sends one cancel while one is in flight and stays cancelling over a stale running answer", async () => {
    const h = harness();
    await h.begin();
    await h.tick();
    // A continue is in flight when the user stops.
    h.turn.cancel();
    h.turn.cancel();
    expect(h.cancels).toHaveLength(1);
    expect(h.turn.snapshot().canCancel).toBe(false);
    h.cancels[0].resolve({ status: "ok" });
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("cancelling");
    h.turn.cancel();
    expect(h.cancels).toHaveLength(1);
    // The continue sent before the cancel returns late with `running`.
    h.continues[0].resolve(h.ok({ text: "途中" }));
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("cancelling");
    await h.tick();
    h.continues[1].resolve(h.ok({ state: "cancelled", drained: true }));
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "cancelled",
      text: "途中",
    });
  });

  // Review fix 6: a refused cancel while a continue is in flight waits for
  // that continue, so its last delta is not lost.
  it("waits for the in-flight continue before a refused cancel ends the generation", async () => {
    const h = harness();
    await h.begin();
    await h.tick();
    h.turn.cancel();
    h.cancels[0].resolve({
      status: "refused",
      reason: "NIR1_LOCAL_HANDLE_NOT_FOUND",
    });
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("running");
    h.continues[0].resolve(h.ok({ text: "最後の差分" }));
    await h.flush();
    await h.tick();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "lost",
      reason: "NIR1_LOCAL_HANDLE_NOT_FOUND",
      text: "最後の差分",
    });
    expect(h.continues).toHaveLength(1);
  });

  it("lets the in-flight continue's drained terminal win over a refused cancel", async () => {
    const h = harness();
    await h.begin();
    await h.tick();
    h.turn.cancel();
    h.cancels[0].resolve({
      status: "refused",
      reason: "NIR1_LOCAL_HANDLE_NOT_FOUND",
    });
    await h.flush();
    h.continues[0].resolve(
      h.ok({ text: "完", state: "succeeded", drained: true }),
    );
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "succeeded",
      text: "完",
      reason: null,
    });
  });

  it("ends a refused cancel at once when no continue is in flight", async () => {
    const h = harness();
    await h.begin();
    h.turn.cancel();
    h.cancels[0].resolve({
      status: "refused",
      reason: "NIR1_LOCAL_CALLER_REVOKED",
    });
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "lost",
      reason: "NIR1_LOCAL_CALLER_REVOKED",
    });
  });

  it("drops a cancel answer that returns after the terminal", async () => {
    const h = harness();
    await h.begin();
    await h.tick();
    h.turn.cancel();
    h.continues[0].resolve(h.ok({ state: "succeeded", drained: true }));
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("succeeded");
    h.cancels[0].resolve({ status: "ok" });
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("succeeded");
    await h.tick();
    expect(h.continues).toHaveLength(1);
  });

  it.each([
    "NIR1_LOCAL_CALLER_REVOKED",
    "NIR1_LOCAL_HANDLE_NOT_FOUND",
    "NIR1_LOCAL_SENDER_REFUSED",
    "NIR1_LOCAL_GATE_CLOSED",
  ] as const)("ends at %s and drops the handle", async (reason) => {
    const h = harness();
    await h.begin();
    await h.tick();
    h.continues[0].resolve({ status: "refused", reason });
    await h.flush();
    await h.tick();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "lost",
      reason,
      canCancel: false,
    });
    expect(h.continues).toHaveLength(1);
    h.turn.cancel();
    expect(h.cancels).toHaveLength(0);
  });

  it("keeps the handle when the cancel could not cancel the capture", async () => {
    const h = harness();
    await h.begin();
    h.turn.cancel();
    h.cancels[0].resolve({
      status: "refused",
      reason: "NIR1_LOCAL_CANCEL_CAPTURE_FAILED",
    });
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "running",
      reason: "NIR1_LOCAL_CANCEL_CAPTURE_FAILED",
      canCancel: true,
    });
    h.turn.cancel();
    expect(h.cancels.map(({ handle }) => handle)).toEqual([HANDLE, HANDLE]);
  });

  it("lets the stop be pressed again after an IPC failure of the cancel", async () => {
    const h = harness();
    await h.begin();
    h.turn.cancel();
    h.cancels[0].reject(new Error("ipc"));
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "running",
      ipcError: "failed",
      canCancel: true,
    });
    h.turn.cancel();
    expect(h.cancels).toHaveLength(2);
  });

  it("survives two IPC failures and ends at the third with one best-effort stop", async () => {
    const h = harness();
    await h.begin();
    await h.tick();
    h.continues[0].reject(new Error("ipc"));
    await h.flush();
    await h.tick();
    h.continues[1].resolve({ status: "error", error: "failed" });
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("running");
    await h.tick();
    h.continues[2].resolve(h.ok());
    await h.flush();
    // A success resets the count.
    await h.tick();
    h.continues[3].reject(new Error("ipc"));
    await h.flush();
    await h.tick();
    h.continues[4].reject(new Error("ipc"));
    await h.flush();
    await h.tick();
    expect(h.turn.snapshot().phase).toBe("running");
    h.continues[5].reject(new Error("ipc"));
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "lost",
      ipcError: "failed",
    });
    expect(h.cancels.map(({ handle }) => handle)).toEqual([HANDLE]);
    await h.tick();
    expect(h.continues).toHaveLength(6);
  });

  it("treats a drained answer of a non-final state as unknown", async () => {
    const h = harness();
    await h.begin();
    await h.tick();
    h.continues[0].resolve(h.ok({ state: "running", drained: true }));
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("unknown");
  });

  it("ends at an unknown continue answer", async () => {
    const h = harness();
    await h.begin();
    await h.tick();
    h.continues[0].resolve({ status: "unknown" });
    await h.flush();
    await h.tick();
    expect(h.turn.snapshot().phase).toBe("unknown");
    expect(h.continues).toHaveLength(1);
  });

  it("does not offer a stop before the start or after the terminal", async () => {
    const h = harness();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "idle",
      canCancel: false,
    });
    h.turn.cancel();
    expect(h.turn.snapshot().cancelRequested).toBe(false);
    h.turn.start();
    expect(h.turn.snapshot().canCancel).toBe(true);
  });

  // Review fix 2: a mutation held by the frozen audit export
  // (`IPC_MUTATION_CANCELLED`) never reached Main; it is not a failure.
  it("waits with backoff while continues are held, without counting failures", async () => {
    const h = harness();
    await h.begin();
    await h.tick();
    h.continues[0].resolve({ status: "error", error: "failed" });
    await h.flush();
    for (let index = 1; index <= 6; index += 1) {
      await h.tick();
      h.continues[index].resolve({ status: "error", error: "held" });
      await h.flush();
    }
    expect(h.turn.snapshot()).toMatchObject({
      phase: "running",
      ipcError: "held",
    });
    expect(h.timers.at(-1)?.ms).toBe(NIR1_LOCAL_HELD_MAX_BACKOFF_MS);
    await h.tick();
    h.continues[7].resolve({ status: "error", error: "failed" });
    await h.flush();
    // Two failures in all: still running.
    expect(h.turn.snapshot().phase).toBe("running");
    await h.tick();
    h.continues[8].resolve(h.ok({ text: "再開" }));
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      phase: "running",
      text: "再開",
      ipcError: null,
    });
    expect(h.cancels).toHaveLength(0);
  });

  it("ends a hold that lasts longer than the wall-clock bound", async () => {
    const h = harness();
    await h.begin();
    await h.tick();
    let index = 0;
    while (
      h.clock.ms <=
      NIR1_LOCAL_MAX_HELD_MS + NIR1_LOCAL_HELD_MAX_BACKOFF_MS
    ) {
      h.continues[index].resolve({ status: "error", error: "held" });
      await h.flush();
      if (h.turn.snapshot().phase !== "running") break;
      await h.tick();
      index += 1;
    }
    expect(h.turn.snapshot()).toMatchObject({
      phase: "lost",
      ipcError: "held",
    });
    expect(h.clock.ms).toBeGreaterThan(NIR1_LOCAL_MAX_HELD_MS);
    expect(h.clock.ms).toBeLessThanOrEqual(
      NIR1_LOCAL_MAX_HELD_MS + NIR1_LOCAL_HELD_MAX_BACKOFF_MS,
    );
    expect(h.cancels.map(({ handle }) => handle)).toEqual([HANDLE]);
  });

  it("retries a held cancel by itself", async () => {
    const h = harness();
    await h.begin();
    h.turn.cancel();
    h.cancels[0].resolve({ status: "error", error: "held" });
    await h.flush();
    expect(h.turn.snapshot()).toMatchObject({
      canCancel: false,
      ipcError: "held",
    });
    await h.tick();
    expect(h.cancels).toHaveLength(2);
    h.cancels[1].resolve({ status: "ok" });
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("cancelling");
  });

  it("retries a held start (it never reached Main)", async () => {
    const h = harness();
    h.turn.start();
    h.starts[0].resolve({ status: "error", error: "held" });
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("starting");
    await h.tick();
    expect(h.starts).toHaveLength(2);
    h.starts[1].resolve({ status: "started", handle: HANDLE });
    await h.flush();
    expect(h.turn.snapshot().phase).toBe("running");
  });

  it("clears the capture-cancel reason when the stop is sent again", async () => {
    const h = harness();
    await h.begin();
    h.turn.cancel();
    h.cancels[0].resolve({
      status: "refused",
      reason: "NIR1_LOCAL_CANCEL_CAPTURE_FAILED",
    });
    await h.flush();
    h.turn.cancel();
    expect(h.turn.snapshot().reason).toBeNull();
  });

  // Re-review P2: a stop pressed while a held start waits must keep the
  // start from ever being sent again (nothing has reached Main yet).
  it("never sends a held start again once the stop was pressed", async () => {
    const h = harness();
    h.turn.start();
    h.starts[0].resolve({ status: "error", error: "held" });
    await h.flush();
    expect(h.turn.snapshot().canCancel).toBe(true);
    h.turn.cancel();
    // Ends at once: nothing reached Main, so there is nothing to wait for.
    expect(h.turn.snapshot().phase).toBe("cancelled");
    await h.tick();
    await h.tick();
    expect(h.starts).toHaveLength(1);
    expect(h.cancels).toHaveLength(0);
    expect(h.turn.snapshot()).toMatchObject({
      phase: "cancelled",
      canCancel: false,
    });
  });

  it("does not resend a start that comes back held after the stop was pressed", async () => {
    const h = harness();
    h.turn.start();
    h.turn.cancel();
    h.starts[0].resolve({ status: "error", error: "held" });
    await h.flush();
    // Ends with the held answer itself, without waiting for a resend timer.
    expect(h.turn.snapshot().phase).toBe("cancelled");
    expect(h.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
    await h.tick();
    expect(h.starts).toHaveLength(1);
  });
});
