import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkLayerLivePort } from "./workLayerLivePort";
import type {
  CandidateCountSnapshot,
  WorkLayerLivePortDependencies,
  WorkLayerModel,
} from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function dependencies(
  overrides: Partial<WorkLayerLivePortDependencies> = {},
): WorkLayerLivePortDependencies {
  return {
    projectId: "p1",
    readStaleProposalCount: vi.fn().mockResolvedValue({
      allowed: true,
      count: 3,
    }),
    readCandidateCount: vi.fn(() => ({ status: "ready" as const, count: 2 })),
    ensureCandidateScan: vi.fn().mockResolvedValue(undefined),
    subscribeCandidateCount: vi.fn(() => vi.fn()),
    isCandidateExtractionApplicable: vi.fn(() => true),
    structureReviewAvailable: vi.fn(() => true),
    ...overrides,
  };
}

function entry(model: WorkLayerModel, id: string) {
  return model.liveEntries?.find((item) => item.id === id);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createWorkLayerLivePort", () => {
  it("returns ordered count rows and only exposes the available review入口", async () => {
    const deps = dependencies();
    const port = createWorkLayerLivePort(deps);
    const model = await port.load({ reason: "mount" });

    expect(model).toMatchObject({
      scopeId: "p1",
      focus: null,
      attention: [],
      disposedAttention: [],
      system: { state: "idle", label: "idle" },
      liveEntries: [
        {
          id: "codex-candidates",
          status: "ready",
          count: 2,
          open: { surface: "structure-extract-review" },
        },
        { id: "stale-proposals", status: "ready", count: 3 },
      ],
    });
    expect("attentionDelta" in model).toBe(false);
    expect(deps.ensureCandidateScan).not.toHaveBeenCalled();
  });

  it("omits disallowed rows and non-Japanese candidates", async () => {
    const ensureCandidateScan = vi.fn().mockResolvedValue(undefined);
    const port = createWorkLayerLivePort(
      dependencies({
        readStaleProposalCount: vi.fn().mockResolvedValue({ allowed: false }),
        isCandidateExtractionApplicable: vi.fn(() => false),
        ensureCandidateScan,
      }),
    );

    await expect(port.load({ reason: "mount" })).resolves.toMatchObject({
      liveEntries: [],
    });
    await port.load({ reason: "tray-open" });
    expect(ensureCandidateScan).not.toHaveBeenCalled();
  });

  it("omits the open surface when review is unavailable", async () => {
    const model = await createWorkLayerLivePort(
      dependencies({ structureReviewAvailable: vi.fn(() => false) }),
    ).load({ reason: "mount" });

    expect(entry(model, "codex-candidates")).toEqual({
      id: "codex-candidates",
      status: "ready",
      count: 2,
    });
    expect(entry(model, "stale-proposals")).not.toHaveProperty("open");
  });

  it.each<CandidateCountSnapshot>([
    { status: "not-counted" },
    { status: "unavailable" },
  ])("preserves candidate state %o without a zero count", async (snapshot) => {
    const model = await createWorkLayerLivePort(
      dependencies({ readCandidateCount: vi.fn(() => snapshot) }),
    ).load({ reason: "mount" });

    expect(entry(model, "codex-candidates")).toMatchObject({
      status: snapshot.status,
      count: null,
    });
  });

  it("marks a thrown read unavailable without rejecting load", async () => {
    const model = await createWorkLayerLivePort(
      dependencies({
        readStaleProposalCount: vi.fn().mockRejectedValue(new Error("read")),
        readCandidateCount: vi.fn(() => {
          throw new Error("count");
        }),
      }),
    ).load({ reason: "mount" });

    expect(model.liveEntries).toEqual([
      {
        id: "codex-candidates",
        status: "unavailable",
        count: null,
        open: { surface: "structure-extract-review" },
      },
      { id: "stale-proposals", status: "unavailable", count: null },
    ]);
  });

  it("starts a candidate scan only on tray open", async () => {
    const deps = dependencies();
    const port = createWorkLayerLivePort(deps);

    await port.load({ reason: "mount" });
    expect(deps.ensureCandidateScan).not.toHaveBeenCalled();
    await port.load({ reason: "tray-open" });
    expect(deps.ensureCandidateScan).toHaveBeenCalledTimes(1);
  });

  it("marks a rejected candidate scan unavailable without rejecting load", async () => {
    const model = await createWorkLayerLivePort(
      dependencies({
        ensureCandidateScan: vi.fn().mockRejectedValue(new Error("scan")),
      }),
    ).load({ reason: "tray-open" });

    expect(entry(model, "codex-candidates")).toMatchObject({
      status: "unavailable",
      count: null,
    });
  });

  it("marks a timed out scan unavailable, then publishes its later count", async () => {
    vi.useFakeTimers();
    const scan = deferred<void>();
    let snapshot: CandidateCountSnapshot = { status: "not-counted" };
    const deps = dependencies({
      displayWaitLimitMs: 10,
      readCandidateCount: vi.fn(() => snapshot),
      ensureCandidateScan: vi.fn(() => scan.promise),
    });
    const port = createWorkLayerLivePort(deps);
    const updates: WorkLayerModel[] = [];
    const unsubscribe = port.subscribe((model) => updates.push(model));

    const loading = port.load({ reason: "tray-open" });
    await vi.advanceTimersByTimeAsync(10);
    const timedOut = await loading;
    expect(entry(timedOut, "codex-candidates")).toMatchObject({
      status: "unavailable",
      count: null,
    });

    snapshot = { status: "ready", count: 4 };
    scan.resolve();
    await scan.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(entry(updates.at(-1)!, "codex-candidates")).toMatchObject({
      status: "ready",
      count: 4,
    });
    unsubscribe();
  });

  it("single-flights matching reasons and lets tray open supersede mount only after it", async () => {
    const mountRead = deferred<
      | { readonly allowed: false }
      | { readonly allowed: true; readonly count: number }
    >();
    const scan = deferred<void>();
    const readStaleProposalCount = vi
      .fn()
      .mockReturnValueOnce(mountRead.promise)
      .mockResolvedValue({ allowed: true, count: 5 });
    const deps = dependencies({
      readStaleProposalCount,
      ensureCandidateScan: vi.fn(() => scan.promise),
    });
    const port = createWorkLayerLivePort(deps);

    const mount = port.load({ reason: "mount" });
    expect(port.load({ reason: "mount" })).toBe(mount);
    const tray = port.load({ reason: "tray-open" });
    expect(port.load({ reason: "tray-open" })).toBe(tray);
    expect(deps.ensureCandidateScan).not.toHaveBeenCalled();

    mountRead.resolve({ allowed: true, count: 1 });
    await mount;
    await Promise.resolve();
    expect(deps.ensureCandidateScan).toHaveBeenCalledTimes(1);
    scan.resolve();
    await tray;
    expect(readStaleProposalCount).toHaveBeenCalledTimes(2);
    expect(deps.readCandidateCount).toHaveBeenCalled();
  });

  it("shares an active tray-open result with mount and repeated opens", async () => {
    const scan = deferred<void>();
    const deps = dependencies({
      ensureCandidateScan: vi.fn(() => scan.promise),
    });
    const port = createWorkLayerLivePort(deps);
    const tray = port.load({ reason: "tray-open" });

    expect(port.load({ reason: "mount" })).toBe(tray);
    expect(port.load({ reason: "tray-open" })).toBe(tray);
    scan.resolve();
    await tray;
  });

  it("subscribes only while subscribed and discards results after disposal", async () => {
    const read = deferred<
      | { readonly allowed: false }
      | { readonly allowed: true; readonly count: number }
    >();
    const cleanup = vi.fn();
    const deps = dependencies({
      readStaleProposalCount: vi.fn(() => read.promise),
      subscribeCandidateCount: vi.fn(() => cleanup),
    });
    const port = createWorkLayerLivePort(deps);
    const unsubscribe = port.subscribe(vi.fn());
    expect(deps.subscribeCandidateCount).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(cleanup).toHaveBeenCalledTimes(1);

    const loading = port.load({ reason: "mount" });
    port.dispose();
    await expect(loading).resolves.toMatchObject({
      scopeId: "p1",
      liveEntries: [],
    });
    read.resolve({ allowed: true, count: 9 });
    await expect(port.load({ reason: "mount" })).resolves.toMatchObject({
      liveEntries: [],
    });
    expect(deps.readStaleProposalCount).toHaveBeenCalledTimes(1);
  });

  it("rebuilds only the candidate row when its shared source changes", async () => {
    let notify!: () => void;
    let snapshot: CandidateCountSnapshot = { status: "not-counted" };
    const deps = dependencies({
      readCandidateCount: vi.fn(() => snapshot),
      subscribeCandidateCount: vi.fn((listener) => {
        notify = listener;
        return vi.fn();
      }),
    });
    const port = createWorkLayerLivePort(deps);
    const updates: WorkLayerModel[] = [];
    const unsubscribe = port.subscribe((model) => updates.push(model));
    expect(deps.subscribeCandidateCount).toHaveBeenCalledTimes(1);

    const initial = await port.load({ reason: "mount" });
    snapshot = { status: "ready", count: 6 };
    notify();

    expect(entry(updates.at(-1)!, "codex-candidates")).toMatchObject({
      status: "ready",
      count: 6,
    });
    expect(entry(updates.at(-1)!, "stale-proposals")).toEqual(
      entry(initial, "stale-proposals"),
    );
    expect("attentionDelta" in updates.at(-1)!).toBe(false);
    unsubscribe();
  });

  it("refreshes the mount snapshot after a concurrent candidate update", async () => {
    const staleRead = deferred<
      | { readonly allowed: false }
      | { readonly allowed: true; readonly count: number }
    >();
    let notify!: () => void;
    let snapshot: CandidateCountSnapshot = { status: "ready", count: 1 };
    const port = createWorkLayerLivePort(
      dependencies({
        readStaleProposalCount: vi.fn(() => staleRead.promise),
        readCandidateCount: vi.fn(() => snapshot),
        subscribeCandidateCount: vi.fn((listener) => {
          notify = listener;
          return vi.fn();
        }),
      }),
    );
    const unsubscribe = port.subscribe(vi.fn());
    const loading = port.load({ reason: "mount" });

    snapshot = { status: "ready", count: 7 };
    notify();
    staleRead.resolve({ allowed: true, count: 3 });

    const model = await loading;
    expect(entry(model, "codex-candidates")).toMatchObject({ count: 7 });
    unsubscribe();
  });
});
