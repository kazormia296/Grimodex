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

  it("keeps the first failure retryable and exits fatally after the bound", async () => {
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
    expect(dispose).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();

    await finalizer(event());
    await finalizer(event());
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(quit).not.toHaveBeenCalled();
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
});
