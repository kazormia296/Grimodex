import { describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceQuitFinalizer,
  type NarrativeMaintenanceQuitEvent,
} from "./narrativeMaintenanceShutdown.js";

function event(): NarrativeMaintenanceQuitEvent {
  return { preventDefault: vi.fn() };
}

describe("narrative maintenance quit finalizer", () => {
  it("waits for cleanup before allowing a successful quit", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn();
    const quit = vi.fn();
    const exit = vi.fn();
    const finalizer = createNarrativeMaintenanceQuitFinalizer({
      dispose,
      complete,
      quit,
      exit,
    });

    const current = event();
    await finalizer(current);

    expect(current.preventDefault).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it("retries a transient failure within one initial quit event", async () => {
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient cleanup failed"))
      .mockResolvedValue(undefined);
    const complete = vi.fn();
    const quit = vi.fn();
    const exit = vi.fn();
    const error = vi.fn();
    const finalizer = createNarrativeMaintenanceQuitFinalizer({
      dispose,
      complete,
      quit,
      exit,
      error,
      maxAttempts: 3,
    });

    await finalizer(event());

    expect(dispose).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits fatally after the bounded retries in one quit event", async () => {
    const dispose = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    const error = vi.fn();
    const quit = vi.fn();
    const exit = vi.fn();
    const finalizer = createNarrativeMaintenanceQuitFinalizer({
      dispose,
      complete: vi.fn(),
      quit,
      exit,
      error,
      maxAttempts: 3,
    });

    await finalizer(event());
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(quit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(3);
  });

  it("does not start a second dispose for a reentrant will-quit", async () => {
    let release!: () => void;
    const dispose = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const finalizer = createNarrativeMaintenanceQuitFinalizer({
      dispose,
      complete: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
    });

    const first = finalizer(event());
    const second = finalizer(event());
    expect(dispose).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
  });

  it("runs independent cleanup while Native observation is stuck", async () => {
    const dispose = vi.fn(() => new Promise<void>(() => undefined));
    const complete = vi.fn().mockResolvedValue(undefined);
    const quit = vi.fn();
    const exit = vi.fn();
    const error = vi.fn();
    const finalizer = createNarrativeMaintenanceQuitFinalizer({
      dispose,
      complete,
      quit,
      exit,
      error,
      nativeObservationBudgetMs: 5,
    });

    await finalizer(event());

    expect(dispose).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(error).toHaveBeenCalled();
  });

  describe("confirmFatalExit (PUB-G #36)", () => {
    const failing = () =>
      vi.fn().mockRejectedValue(new Error("cleanup failed"));

    it("asks before the fatal exit; exit keeps exit(1)", async () => {
      const order: string[] = [];
      const confirmFatalExit = vi.fn(async () => {
        order.push("confirm");
        return "exit" as const;
      });
      const exit = vi.fn(() => order.push("exit"));
      const finalizer = createNarrativeMaintenanceQuitFinalizer({
        dispose: failing(),
        complete: vi.fn(),
        quit: vi.fn(),
        exit,
        confirmFatalExit,
        maxAttempts: 1,
      });

      await finalizer(event());

      expect(order).toEqual(["confirm", "exit"]);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it("stay cancels the exit and lets a later quit run the finalizer again", async () => {
      const dispose = failing();
      const exit = vi.fn();
      const quit = vi.fn();
      const confirmFatalExit = vi
        .fn<() => Promise<"exit" | "stay">>()
        .mockResolvedValueOnce("stay")
        .mockResolvedValueOnce("exit");
      const finalizer = createNarrativeMaintenanceQuitFinalizer({
        dispose,
        complete: vi.fn(),
        quit,
        exit,
        confirmFatalExit,
        maxAttempts: 1,
      });

      const first = event();
      await finalizer(first);
      expect(first.preventDefault).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();

      // The author later quits again; the whole finalizer retries.
      const second = event();
      await finalizer(second);
      expect(second.preventDefault).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledTimes(2);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    });

    // The confirmation has no parent window: while it is open the renderer
    // can still close itself, and window-all-closed asks the app to quit.
    it("a will-quit re-entering during the confirmation turns stay into exit", async () => {
      const exit = vi.fn();
      const quit = vi.fn();
      let release!: (value: "stay") => void;
      const confirmFatalExit = vi.fn(
        () => new Promise<"exit" | "stay">((resolve) => (release = resolve)),
      );
      const finalizer = createNarrativeMaintenanceQuitFinalizer({
        dispose: failing(),
        complete: vi.fn(),
        quit,
        exit,
        confirmFatalExit,
        maxAttempts: 1,
      });

      const first = event();
      const pending = finalizer(first);
      await vi.waitFor(() => expect(confirmFatalExit).toHaveBeenCalled());
      const reentrant = event();
      await finalizer(reentrant);
      expect(reentrant.preventDefault).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();

      release("stay");
      await pending;

      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(quit).not.toHaveBeenCalled();
    });

    it("a quit that re-entered before the confirmation does not count", async () => {
      const exit = vi.fn();
      let release!: (value: "stay") => void;
      let disposeCalls = 0;
      const finalizer = createNarrativeMaintenanceQuitFinalizer({
        dispose: () => {
          disposeCalls += 1;
          return Promise.reject(new Error("cleanup failed"));
        },
        complete: vi.fn(),
        quit: vi.fn(),
        exit,
        confirmFatalExit: () =>
          new Promise<"exit" | "stay">((resolve) => (release = resolve)),
        maxAttempts: 1,
      });

      const pending = finalizer(event());
      // Re-entered while dispose is still being observed.
      await finalizer(event());
      await vi.waitFor(() => expect(release).toBeDefined());
      release("stay");
      await pending;

      expect(disposeCalls).toBe(1);
      expect(exit).not.toHaveBeenCalled();
    });

    it("a throwing confirmation keeps the fatal exit", async () => {
      const exit = vi.fn();
      const error = vi.fn();
      const finalizer = createNarrativeMaintenanceQuitFinalizer({
        dispose: failing(),
        complete: vi.fn(),
        quit: vi.fn(),
        exit,
        error,
        confirmFatalExit: () => {
          throw new Error("dialog gone");
        },
        maxAttempts: 1,
      });

      await finalizer(event());

      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it("is not asked when shutdown succeeds", async () => {
      const confirmFatalExit = vi.fn();
      const quit = vi.fn();
      const finalizer = createNarrativeMaintenanceQuitFinalizer({
        dispose: vi.fn().mockResolvedValue(undefined),
        complete: vi.fn(),
        quit,
        exit: vi.fn(),
        confirmFatalExit,
      });

      await finalizer(event());

      expect(confirmFatalExit).not.toHaveBeenCalled();
      expect(quit).toHaveBeenCalledOnce();
    });

    it("an independent cleanup failure is also confirmed before exit", async () => {
      const confirmFatalExit = vi.fn().mockResolvedValue("stay");
      const exit = vi.fn();
      const finalizer = createNarrativeMaintenanceQuitFinalizer({
        dispose: vi.fn().mockResolvedValue(undefined),
        complete: vi.fn().mockRejectedValue(new Error("cleanup failed")),
        quit: vi.fn(),
        exit,
        confirmFatalExit,
      });

      await finalizer(event());

      expect(confirmFatalExit).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
    });
  });
});
