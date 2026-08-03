// @vitest-environment happy-dom
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
    // Should work without Tauri — global settings mock
    const result = await invoke("get_global_settings");
    expect(result).toBeDefined();
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

  it("rejects with timeout when a verified read-only invoke never settles", async () => {
    vi.useFakeTimers();

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    // Return a promise that never resolves
    const mockInvoke = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: mockInvoke,
    }));

    const { invoke } = await import("./tauri");
    const promise = invoke("get_global_settings");

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const expectation = expect(promise).rejects.toThrow(/IPC timeout/);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(11_000);

    await expectation;

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("applies the frozen audit safe-query allowlist to BrowserMock invokes", async () => {
    const ipcQueue = await import("./ipcQueue");
    const tauri = await import("./tauri");
    const mockInvoke = vi.fn(async (command: string) => ({ command }));
    tauri.installBrowserMock({
      invoke: mockInvoke,
    } as unknown as import("./browser-mock").BrowserMock);
    const releaseRead = ipcQueue.acquireIpcReadAdmissionBarrier();
    const releaseDerived = ipcQueue.acquireIpcDerivedAdmissionBarrier();
    const releaseMutation = ipcQueue.acquireIpcMutationAdmissionBarrier();
    const releaseSafeReads = ipcQueue.acquireAuditExportSafeReadAllowance();

    try {
      await expect(
        tauri.invoke("db_execute", { sql: "SELECT 1", method: "all" }),
      ).resolves.toEqual({ command: "db_execute" });
      await expect(tauri.invoke("ai_audit_read_snapshot")).resolves.toEqual({
        command: "ai_audit_read_snapshot",
      });
      await expect(tauri.invoke("ai_audit_verify")).resolves.toEqual({
        command: "ai_audit_verify",
      });
      await expect(tauri.invoke("semantic_search")).rejects.toThrow(
        "IPC_READ_CANCELLED",
      );
      await expect(tauri.invoke("semantic_index_scene")).rejects.toThrow(
        "IPC_DERIVED_CANCELLED",
      );
      await expect(
        tauri.invoke("db_execute", {
          sql: "UPDATE projects SET title = 'changed'",
          method: "run",
        }),
      ).rejects.toThrow("IPC_MUTATION_CANCELLED");
      await expect(tauri.invoke("save_scene")).rejects.toThrow(
        "IPC_MUTATION_CANCELLED",
      );
      expect(mockInvoke).toHaveBeenCalledTimes(3);
    } finally {
      releaseSafeReads();
      releaseMutation();
      releaseDerived();
      releaseRead();
      ipcQueue.resetIpcQueueForTests();
    }
  });
});
