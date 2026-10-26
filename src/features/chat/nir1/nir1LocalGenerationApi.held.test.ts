// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DD-1c re-review P3-2 (DR-DD1C-18): the held class comes from the typed code
// the real `invoke` attaches when the frozen audit export holds a mutation
// before Main, not from the text of the error.

type AnyWindow = Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (window as unknown as AnyWindow).grimodex;
});

describe("the held class through the real invoke", () => {
  it("is held for a mutation the queue refuses before Main", async () => {
    const bridge = {
      shell: "electron",
      invoke: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      listen: vi.fn().mockReturnValue(() => {}),
      emit: vi.fn().mockResolvedValue(undefined),
    };
    (window as unknown as AnyWindow).grimodex = bridge;
    const { acquireIpcMutationAdmissionBarrier, resetIpcQueueForTests } =
      await import("@/lib/ipcQueue");
    const { continueNir1LocalGeneration, cancelNir1LocalGeneration } =
      await import("./nir1LocalGenerationApi");
    resetIpcQueueForTests();
    const release = acquireIpcMutationAdmissionBarrier();
    try {
      const handle = "0123456789abcdef0123456789abcdef";
      await expect(continueNir1LocalGeneration(handle)).resolves.toEqual({
        status: "error",
        error: "held",
      });
      await expect(cancelNir1LocalGeneration(handle)).resolves.toEqual({
        status: "error",
        error: "held",
      });
      expect(bridge.invoke).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("is not held for a Main error that only names the code in its text", async () => {
    const { classifyNir1LocalIpcError } =
      await import("./nir1LocalGenerationApi");
    expect(
      classifyNir1LocalIpcError(
        new Error("Native said IPC_MUTATION_CANCELLED in some text"),
      ),
    ).toBe("failed");
  });
});
