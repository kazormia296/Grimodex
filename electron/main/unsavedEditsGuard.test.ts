import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FATAL_EXIT_CONFIRM_TIMEOUT_MS,
  createUnsavedEditsGuard,
  showUnsavedFatalExitDialog,
  type FatalExitDecision,
} from "./unsavedEditsGuard.js";
import {
  REPORT_UNSAVED_EDITS_COMMAND,
  UNSAVED_EDITS_RETAINED_EVENT,
  parseUnsavedEditsReport,
} from "../shared/unsavedEditsWire.js";

function makeGuard(
  options: {
    alive?: Set<number>;
    decision?: FatalExitDecision | Error;
    windows?: { count: number };
    /** Runs while the dialog is open (windows close, flags change). */
    whileOpen?: () => void;
  } = {},
) {
  const alive = options.alive ?? new Set([1, 2]);
  const windows = options.windows ?? { count: 1 };
  const confirm = vi.fn(async () => {
    options.whileOpen?.();
    if (options.decision instanceof Error) throw options.decision;
    return options.decision ?? "stay";
  });
  const notifyRetained = vi.fn();
  const guard = createUnsavedEditsGuard({
    isOwnerAlive: (id) => alive.has(id),
    liveWindowCount: () => windows.count,
    confirm,
    notifyRetained,
  });
  const report = (owner: number, value: unknown) =>
    guard.handlersForOwner(owner)[REPORT_UNSAVED_EDITS_COMMAND]({
      hasUnsaved: value,
    });
  return { guard, alive, windows, confirm, notifyRetained, report };
}

describe("unsaved edits wire", () => {
  it("accepts exactly { hasUnsaved: boolean }", () => {
    expect(parseUnsavedEditsReport({ hasUnsaved: true })).toEqual({
      hasUnsaved: true,
    });
    expect(parseUnsavedEditsReport({ hasUnsaved: false })).toEqual({
      hasUnsaved: false,
    });
    for (const bad of [
      null,
      [],
      {},
      { hasUnsaved: "true" },
      { hasUnsaved: true, extra: 1 },
      { other: true },
    ]) {
      expect(parseUnsavedEditsReport(bad)).toBeNull();
    }
  });
});

describe("unsaved edits guard", () => {
  it("does not ask when nothing is unsaved (previous behaviour)", async () => {
    const { guard, confirm, report } = makeGuard();
    await report(1, false);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("exit");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks once when a live window holds unsaved edits", async () => {
    const { guard, confirm, report } = makeGuard({ decision: "exit" });
    await report(1, true);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("exit");
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("clears the flag when the renderer reports it saved", async () => {
    const { guard, confirm, report } = makeGuard();
    await report(1, true);
    await report(1, false);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("exit");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("never asks about a destroyed window", async () => {
    const { guard, confirm, alive, report } = makeGuard();
    await report(1, true);
    alive.delete(1);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("exit");
    expect(confirm).not.toHaveBeenCalled();
    expect(guard.ownersWithUnsaved()).toEqual([]);
  });

  it("on stay, tells only the live windows that hold unsaved edits", async () => {
    const { guard, notifyRetained, report } = makeGuard({ decision: "stay" });
    await report(1, true);
    await report(2, false);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("stay");
    expect(notifyRetained).toHaveBeenCalledExactlyOnceWith(
      1,
      UNSAVED_EDITS_RETAINED_EVENT,
      { kind: "unsaved-edits-retained" },
    );
  });

  it("on stay, exits when every window closed while the dialog was open", async () => {
    const alive = new Set([1]);
    const { guard, notifyRetained, report } = makeGuard({
      alive,
      decision: "stay",
      whileOpen: () => alive.clear(),
    });
    await report(1, true);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("exit");
    expect(notifyRetained).not.toHaveBeenCalled();
  });

  it("on stay, exits when no window remains even if an owner looks alive", async () => {
    const windows = { count: 1 };
    const { guard, notifyRetained, report } = makeGuard({
      windows,
      decision: "stay",
      whileOpen: () => {
        windows.count = 0;
      },
    });
    await report(1, true);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("exit");
    expect(notifyRetained).not.toHaveBeenCalled();
  });

  it("on stay, exits when the unsaved edits were saved while the dialog was open", async () => {
    const { guard, report } = makeGuard({
      decision: "stay",
      whileOpen: () => {
        void report(1, false);
      },
    });
    await report(1, true);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("exit");
  });

  it("on stay with a live window still holding edits, stays and tells it", async () => {
    const { guard, notifyRetained, report } = makeGuard({ decision: "stay" });
    await report(1, true);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("stay");
    expect(notifyRetained).toHaveBeenCalledOnce();
  });

  it("on exit, tells no window", async () => {
    const { guard, notifyRetained, report } = makeGuard({ decision: "exit" });
    await report(1, true);
    await guard.confirmBeforeFatalExit();
    expect(notifyRetained).not.toHaveBeenCalled();
  });

  it("a broken dialog keeps the fatal exit instead of hanging", async () => {
    const { guard, report } = makeGuard({ decision: new Error("dialog gone") });
    await report(1, true);
    await expect(guard.confirmBeforeFatalExit()).resolves.toBe("exit");
  });

  it("rejects a malformed report and leaves the flag untouched", async () => {
    const { guard, report } = makeGuard({ decision: "stay" });
    await report(1, true);
    await expect(report(1, "no")).rejects.toThrow(/IPC_INVALID_REQUEST/);
    expect(guard.ownersWithUnsaved()).toEqual([1]);
  });
});

describe("unsaved fatal exit dialog", () => {
  const show = (response: number) =>
    showUnsavedFatalExitDialog({
      showMessageBox: vi.fn(async () => ({ response })),
    });

  it("defaults to the safe choice and maps the buttons", async () => {
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    await showUnsavedFatalExitDialog({ showMessageBox });
    const options = (
      showMessageBox.mock.calls as unknown as Array<
        [{ defaultId: number; cancelId: number; buttons: string[] }]
      >
    )[0][0];
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    expect(options.buttons).toHaveLength(2);
    await expect(show(0)).resolves.toBe("stay");
    await expect(show(1)).resolves.toBe("exit");
  });

  describe("timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives up after the limit, closes the dialog and exits", async () => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      // Like Electron: an aborted box resolves as cancelled (response 0).
      const showMessageBox = vi.fn(
        (options: { signal?: AbortSignal }) =>
          new Promise<{ response: number }>((resolve) => {
            signal = options.signal;
            options.signal?.addEventListener("abort", () =>
              resolve({ response: 0 }),
            );
          }),
      );
      const result = showUnsavedFatalExitDialog({ showMessageBox });
      await vi.advanceTimersByTimeAsync(FATAL_EXIT_CONFIRM_TIMEOUT_MS - 1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe("exit");
      expect(signal?.aborted).toBe(true);
    });

    it("a dialog that ignores the signal is still cut off", async () => {
      vi.useFakeTimers();
      const showMessageBox = vi.fn(
        () => new Promise<{ response: number }>(() => {}),
      );
      const result = showUnsavedFatalExitDialog({ showMessageBox }, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toBe("exit");
    });

    it("an answer in time wins and leaves no timer behind", async () => {
      vi.useFakeTimers();
      const result = showUnsavedFatalExitDialog({
        showMessageBox: vi.fn(async () => ({ response: 0 })),
      });
      await expect(result).resolves.toBe("stay");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
