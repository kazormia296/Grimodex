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
});
