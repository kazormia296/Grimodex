import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("invoke wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Clean up __TAURI_INTERNALS__ if set
    if ("__TAURI_INTERNALS__" in window) {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it("uses browser mock when __TAURI_INTERNALS__ is absent", async () => {
    const { invoke } = await import("./tauri");
    // Should work without Tauri — content mock
    await invoke("content_write", {
      sceneId: "test-1",
      markdown: "# Test",
      title: "テスト",
      chapterOrder: 1,
      sceneOrder: 1,
    });
    const result = await invoke<string>("content_read", {
      sceneId: "test-1",
    });
    expect(result).toBe("# Test");
  });

  it("delegates to tauri invoke when __TAURI_INTERNALS__ is present", async () => {
    // Simulate Tauri environment
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    const mockInvoke = vi.fn().mockResolvedValue("tauri-result");
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: mockInvoke,
    }));

    const { invoke } = await import("./tauri");
    const result = await invoke("some_command", { key: "value" });

    expect(mockInvoke).toHaveBeenCalledWith("some_command", { key: "value" });
    expect(result).toBe("tauri-result");
  });

  it("rejects with timeout when tauri invoke never settles", async () => {
    vi.useFakeTimers();

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    // Return a promise that never resolves
    const mockInvoke = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: mockInvoke,
    }));

    const { invoke } = await import("./tauri");
    const promise = invoke("hanging_command");

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const expectation = expect(promise).rejects.toThrow(/IPC timeout/);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(11_000);

    await expectation;

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
