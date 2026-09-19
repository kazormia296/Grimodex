import { afterEach, describe, expect, it, vi } from "vitest";
import { createNarrativeMaintenanceScheduler, type NarrativeMaintenanceBackendLike, type NarrativeMaintenanceWorkspaceBinding } from "./narrativeMaintenance.js";
import type { NarrativeMaintenanceTerminalReceipt } from "./narrativeMaintenanceAttempt.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let binding: NarrativeMaintenanceWorkspaceBinding = { authorityId: "pr600-workspace", generation: 1 };
  const bindings = new Map<string, NarrativeMaintenanceWorkspaceBinding>();
  const receipts = new Map<string, NarrativeMaintenanceTerminalReceipt>();
  const receipt = (id: string, succeeded = true, reusable = true): NarrativeMaintenanceTerminalReceipt => {
    const bound = bindings.get(id)!;
    return { schemaVersion: 1, attemptId: id, state: succeeded ? "succeeded" : "interrupted",
      stopReason: succeeded ? null : "workspace-generation-changed", generation: bound.generation,
      workspaceBinding: bound, publishedGeneration: null, works: [],
      cleanup: reusable ? { status: "clean" } : { status: "failed", error: "permanent quarantine" }, connectionReusable: reusable };
  };
  const backend: NarrativeMaintenanceBackendLike = {
    getNarrativeMaintenanceWorkspaceBinding: () => binding,
    beginNarrativeMaintenanceAttempt: vi.fn(async (id, bound) => {
      bindings.set(id, { ...bound });
      return { status: "open", attemptId: id, ...bound };
    }),
    cancelNarrativeMaintenanceAttempt: vi.fn(async (id) => receipts.get(id) ?? receipt(id, false)),
    runNarrativeMaintenanceCycle: vi.fn(async () => ({ status: "accepted", hasMore: false })),
  };
  const scheduler = createNarrativeMaintenanceScheduler(backend, { warn: vi.fn() });
  return { backend, scheduler, receipt, receipts, bindings, replaceBinding: () => { binding = { ...binding, generation: binding.generation + 1 }; } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("PR600 manual Native ownership", () => {
  it("fetches the exact Native terminal receipt before returning manual success", async () => {
    const f = fixture();
    const operation = vi.fn(async (id: string) => { f.receipts.set(id, f.receipt(id)); return "verified"; });
    await expect(f.scheduler.runManualOperation!("project", operation)).resolves.toBe("verified");
    expect(operation).toHaveBeenCalledOnce();
    expect(f.backend.cancelNarrativeMaintenanceAttempt).toHaveBeenCalledWith(operation.mock.calls[0]![0], "closed");
    await f.scheduler.dispose();
  });

  it("does not confuse a cancel request with actual manual termination", async () => {
    const f = fixture();
    const started = deferred<string>(); const nativeClosed = deferred<void>(); const cancelled = deferred<void>();
    f.backend.cancelNarrativeMaintenanceAttempt = vi.fn(async (id) => {
      cancelled.resolve(); await nativeClosed.promise;
      return f.receipt(id, false);
    });
    const manual = f.scheduler.runManualOperation!("project", async (id) => {
      started.resolve(id); await nativeClosed.promise; throw new Error("native cancelled");
    });
    const rejected = expect(manual).rejects.toThrow("native cancelled");
    await started.promise;
    let switched = false;
    const switchFlight = f.scheduler.quiesceForWorkspaceSwitch!().then((lease) => { switched = true; return lease; });
    await cancelled.promise;
    expect(switched).toBe(false);
    nativeClosed.resolve();
    await rejected;
    const lease = await switchFlight;
    if (lease) lease.resume();
    await f.scheduler.dispose();
  });

  it("rejects a second manual start without cancelling the existing owner", async () => {
    const f = fixture(); const started = deferred<void>(); const closed = deferred<void>();
    const manual = f.scheduler.runManualOperation!("project", async (id) => {
      started.resolve(); await closed.promise; f.receipts.set(id, f.receipt(id)); return 1;
    });
    await started.promise;
    const second = vi.fn(async () => 2);
    await expect(f.scheduler.runManualOperation!("project", second)).rejects.toThrow("ACTIVE");
    expect(second).not.toHaveBeenCalled(); expect(f.backend.cancelNarrativeMaintenanceAttempt).not.toHaveBeenCalled();
    closed.resolve(); await manual; await f.scheduler.dispose();
  });

  it("does not start manual work when a workspace switch wins during begin", async () => {
    const f = fixture(); const entered = deferred<void>(); const release = deferred<void>();
    f.backend.beginNarrativeMaintenanceAttempt = vi.fn(async (id, bound) => {
      f.bindings.set(id, bound); entered.resolve(); await release.promise;
      return { status: "open", attemptId: id, ...bound };
    });
    const operation = vi.fn(async () => 1);
    const manual = f.scheduler.runManualOperation!("project", operation);
    const rejected = expect(manual).rejects.toThrow("CANCELLED");
    await entered.promise;
    const switching = f.scheduler.quiesceForWorkspaceSwitch!();
    release.resolve(); await rejected;
    const lease = await switching; if (lease) lease.resume();
    expect(operation).not.toHaveBeenCalled();
    await f.scheduler.dispose();
  });
});

describe("PR600 terminal failure versus connection reuse", () => {
  it("adopts permanent failed receipts, allows explicit reopen, and only resumes on a new binding", async () => {
    const f = fixture();
    const binding = { authorityId: "pr600-workspace", generation: 1 };
    await f.scheduler.beginNarrativeMaintenanceAttempt!("failed-attempt", binding);
    const failed = f.receipt("failed-attempt", false, false);
    f.receipts.set("failed-attempt", failed);
    await expect(f.scheduler.cancelNarrativeMaintenanceAttempt!("failed-attempt", "closed")).resolves.toEqual(failed);
    const oldLease = await f.scheduler.quiesceForWorkspaceSwitch!();
    if (oldLease) oldLease.resume();
    const operation = vi.fn(async (id: string) => { f.receipts.set(id, f.receipt(id)); return 1; });
    await expect(f.scheduler.runManualOperation!("project", operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    const newLease = await f.scheduler.quiesceForWorkspaceSwitch!();
    f.replaceBinding(); if (newLease) newLease.resume();
    await expect(f.scheduler.runManualOperation!("project", operation)).resolves.toBe(1);
    expect(f.receipts.get("failed-attempt")).toEqual(failed);
    await f.scheduler.dispose();
  });

  it("keeps malformed terminal evidence blocking rather than treating it as quarantine recovery", async () => {
    const f = fixture(); const binding = { authorityId: "pr600-workspace", generation: 1 };
    await f.scheduler.beginNarrativeMaintenanceAttempt!("unknown-attempt", binding);
    f.backend.cancelNarrativeMaintenanceAttempt = vi.fn(async () => ({ state: "interrupted", connectionReusable: false }));
    await expect(f.scheduler.quiesceForWorkspaceSwitch!()).rejects.toThrow();
    f.replaceBinding();
    await expect(f.scheduler.quiesceForWorkspaceSwitch!()).rejects.toThrow();
    const operation = vi.fn(async () => 1);
    await expect(f.scheduler.runManualOperation!("project", operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
});
