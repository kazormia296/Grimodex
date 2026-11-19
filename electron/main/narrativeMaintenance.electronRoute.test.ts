import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NarrativeMaintenanceCiSeam } from "./narrativeMaintenanceCiSeam.js";
import { bootstrapNarrativeMaintenance } from "./narrativeMaintenanceBootstrap.js";
import type { NarrativeMaintenanceBackendLike } from "./narrativeMaintenance.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: vi.fn() },
}));

const { registerEventBus } = await import("./events.js");

const binding = { authorityId: "authority-electron", generation: 7 };

function productionSeam(): Extract<
  NarrativeMaintenanceCiSeam,
  { active: false }
> {
  return { active: false };
}

function workFor(
  reason: "workspace-opened" | "restore-completed" | "semantic-epoch-rotated",
) {
  return {
    projectId: "project-electron-route",
    runKind: reason === "workspace-opened" ? "backfill" : "dependency-verify",
    workKey: `maintenance:${reason}`,
    semanticEpochId:
      reason === "workspace-opened" ? null : "epoch-electron-route",
    reasons: [reason],
  };
}

function createBackend(work: ReturnType<typeof workFor>) {
  const discoverNarrativeMaintenanceWork = vi
    .fn()
    .mockResolvedValueOnce(
      JSON.stringify({
        workspaceBinding: binding,
        pages: [{ work: [work] }],
      }),
    )
    .mockResolvedValueOnce(
      JSON.stringify({ workspaceBinding: binding, pages: [] }),
    );
  const runNarrativeMaintenanceCycle = vi
    .fn()
    .mockResolvedValueOnce(
      JSON.stringify({ status: "accepted", hasMore: true }),
    )
    .mockResolvedValueOnce(
      JSON.stringify({ status: "accepted", hasMore: false }),
    );
  let onEvent: ((channel: unknown, payload: unknown) => void) | null = null;
  const backend = {
    getNarrativeMaintenanceWorkspaceBinding: vi.fn(() =>
      JSON.stringify(binding),
    ),
    discoverNarrativeMaintenanceWork,
    runNarrativeMaintenanceCycle,
    onEvent(callback: (channel: unknown, payload: unknown) => void) {
      onEvent = callback;
    },
  } as unknown as NarrativeMaintenanceBackendLike &
    NapiBackendLike & {
      emit(channel: unknown, payload: unknown): void;
    };
  Object.defineProperty(backend, "emit", {
    value: (channel: unknown, payload: unknown) => onEvent?.(channel, payload),
  });
  return {
    backend,
    discoverNarrativeMaintenanceWork,
    runNarrativeMaintenanceCycle,
  };
}

describe("Electron main narrative maintenance route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["workspace-opened", {}, "workspace-opened"],
    [
      "restore-completed",
      { reason: "restore", path: "/not-forwarded" },
      "restore-completed",
    ],
    [
      "semantic-epoch-rotated",
      { projectId: "project-electron-route", ...binding },
      "semantic-epoch-rotated",
    ],
  ] as const)(
    "routes the %s main wake through N-API discovery and an accepted hasMore follow-up",
    async (_name, payload, expectedReason) => {
      const fixture = createBackend(workFor(expectedReason));
      const runtime = bootstrapNarrativeMaintenance(
        fixture.backend,
        productionSeam(),
      );

      registerEventBus(fixture.backend, (channel, eventPayload) => {
        runtime.coordinator?.handleBackendEvent(channel, eventPayload);
      });
      fixture.backend.emit(
        expectedReason === "semantic-epoch-rotated"
          ? "narrative-maintenance:epoch-rotated"
          : "workspace:opened",
        payload,
      );
      await vi.runAllTimersAsync();

      expect(fixture.discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
        expectedReason,
      );
      expect(fixture.runNarrativeMaintenanceCycle).toHaveBeenNthCalledWith(1, {
        work: [
          {
            projectId: "project-electron-route",
            runKind:
              expectedReason === "workspace-opened"
                ? "backfill"
                : "dependency-verify",
            workKey: `maintenance:${expectedReason}`,
            semanticEpochId:
              expectedReason === "workspace-opened"
                ? null
                : "epoch-electron-route",
            reasons: [expectedReason],
          },
        ],
        wakeProjectIds: [],
        workspaceBinding: binding,
      });
      expect(fixture.runNarrativeMaintenanceCycle).toHaveBeenNthCalledWith(2, {
        work: [],
        wakeProjectIds: ["project-electron-route"],
        workspaceBinding: binding,
      });
      expect(fixture.runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(fixture.discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
        expectedReason,
      );

      runtime.coordinator?.dispose();
      runtime.scheduler?.dispose();
    },
  );
});

/**
 * DR-PUBG-5-14: the production launch (no CI seam) accepts Native's Graph Index
 * build wakes. Native raises them only behind its const gate
 * (`PRODUCT_GRAPH_PUBLISHED`, false until PUB-G), so a launch of today's product
 * never sees one; these tests fix what main does when Native does.
 */
describe("Electron main Graph Index build wakes in a production launch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createWakeBackend(discovery: unknown) {
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockResolvedValue(JSON.stringify(discovery));
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ status: "accepted", hasMore: false }),
      );
    let onEvent: ((channel: unknown, payload: unknown) => void) | null = null;
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: vi.fn(() =>
        JSON.stringify(binding),
      ),
      discoverNarrativeMaintenanceWork,
      runNarrativeMaintenanceCycle,
      onEvent(callback: (channel: unknown, payload: unknown) => void) {
        onEvent = callback;
      },
    } as unknown as NarrativeMaintenanceBackendLike &
      NapiBackendLike & { emit(channel: unknown, payload: unknown): void };
    Object.defineProperty(backend, "emit", {
      value: (channel: unknown, payload: unknown) =>
        onEvent?.(channel, payload),
    });
    return {
      backend,
      discoverNarrativeMaintenanceWork,
      runNarrativeMaintenanceCycle,
    };
  }

  it("turns the Graph owner's demand into a wake cycle of that project, with no discovery", async () => {
    const fixture = createWakeBackend({
      workspaceBinding: binding,
      pages: [],
    });
    const runtime = bootstrapNarrativeMaintenance(
      fixture.backend,
      productionSeam(),
    );
    registerEventBus(fixture.backend, (channel, eventPayload) => {
      runtime.coordinator?.handleBackendEvent(channel, eventPayload);
    });
    // Native's EventQueue delivers the payload as JSON text.
    fixture.backend.emit(
      "narrative-maintenance:graph-index-demand",
      '{"projectId":"project-electron-route"}',
    );
    await vi.runAllTimersAsync();

    expect(
      fixture.runNarrativeMaintenanceCycle,
    ).toHaveBeenCalledExactlyOnceWith({
      work: [],
      wakeProjectIds: ["project-electron-route"],
      workspaceBinding: binding,
    });
    expect(fixture.discoverNarrativeMaintenanceWork).not.toHaveBeenCalled();

    runtime.coordinator?.dispose();
    runtime.scheduler?.dispose();
  });

  it("accepts a discovery that names a project for the Graph Index build and runs its wake cycle", async () => {
    const fixture = createWakeBackend({
      workspaceBinding: binding,
      pages: [],
      wakeProjectIds: ["project-electron-route"],
    });
    const runtime = bootstrapNarrativeMaintenance(
      fixture.backend,
      productionSeam(),
    );
    registerEventBus(fixture.backend, (channel, eventPayload) => {
      runtime.coordinator?.handleBackendEvent(channel, eventPayload);
    });
    fixture.backend.emit("workspace:opened", {});
    await vi.runAllTimersAsync();

    expect(fixture.discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();
    expect(
      fixture.runNarrativeMaintenanceCycle,
    ).toHaveBeenCalledExactlyOnceWith({
      work: [],
      wakeProjectIds: ["project-electron-route"],
      workspaceBinding: binding,
    });

    runtime.coordinator?.dispose();
    runtime.scheduler?.dispose();
  });

  /**
   * The attempt lifecycle a production backend has: each accepted cycle ends
   * with a Native terminal receipt. DR-PUBG-5-17 trusts a wake-only cycle to be
   * demand-only only on that receipt, so a backend without it never skips.
   */
  function lifecycleMethods(
    receiptWorks: readonly { workKey: string; status: "succeeded" | "failed" }[] = [],
  ) {
    return {
      ackNarrativeMaintenanceDelivery: vi
        .fn()
        .mockResolvedValue({ status: "retired" }),
      beginNarrativeMaintenanceAttempt: vi.fn(
        (attemptId: string, received: typeof binding) =>
          JSON.stringify({
            status: "open",
            attemptId,
            authorityId: received.authorityId,
            generation: received.generation,
          }),
      ),
      cancelNarrativeMaintenanceAttempt: vi.fn((attemptId: string) =>
        JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: "succeeded",
          stopReason: null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: binding.generation,
          works: receiptWorks,
          cleanup: { status: "clean" },
          connectionReusable: true,
        }),
      ),
    };
  }

  /**
   * DR-PUBG-5-17. The chain is alive (its first discovery is in flight) while a
   * wake cycle is accepted. The number of discoveries counts the rediscoveries
   * that cycle asked for: a rediscovery queued behind the in-flight discovery
   * runs once more after it, while with no request the chain ends.
   */
  async function discoveriesWithWakeDuringLiveChain(
    wake: "none" | "demand-event" | "demand" | "discovery" | "mixed",
    receiptWorks: readonly { workKey: string; status: "succeeded" | "failed" }[] = [],
  ) {
    let releaseFirst: (value: string) => void = () => {};
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue(
        JSON.stringify({ workspaceBinding: binding, pages: [] }),
      );
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ status: "accepted", hasMore: false }),
      );
    let onEvent: ((channel: unknown, payload: unknown) => void) | null = null;
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: vi.fn(() =>
        JSON.stringify(binding),
      ),
      discoverNarrativeMaintenanceWork,
      runNarrativeMaintenanceCycle,
      ...lifecycleMethods(receiptWorks),
      onEvent(callback: (channel: unknown, payload: unknown) => void) {
        onEvent = callback;
      },
    } as unknown as NarrativeMaintenanceBackendLike & NapiBackendLike;
    const emit = (channel: unknown, payload: unknown) =>
      onEvent?.(channel, payload);
    const runtime = bootstrapNarrativeMaintenance(backend, productionSeam());
    registerEventBus(backend, (channel, eventPayload) => {
      runtime.coordinator?.handleBackendEvent(channel, eventPayload);
    });
    const requestWakes = runtime.scheduler?.requestGraphIndexBuildWakesWithBinding?.bind(
      runtime.scheduler,
    );
    // The chain is alive with its first discovery in flight.
    emit("workspace:opened", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();
    if (wake === "demand-event") {
      emit(
        "narrative-maintenance:graph-index-demand",
        '{"projectId":"project-electron-route"}',
      );
    } else if (wake === "demand") {
      requestWakes?.(["project-electron-route"], binding, "demand");
    } else if (wake === "discovery") {
      requestWakes?.(["project-electron-route"], binding);
    } else if (wake === "mixed") {
      requestWakes?.(["project-electron-route"], binding, "demand");
      requestWakes?.(["project-electron-route"], binding, "discovery");
    }
    if (wake !== "none") {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    }
    releaseFirst(JSON.stringify({ workspaceBinding: binding, pages: [] }));
    await vi.runAllTimersAsync();
    const discoveries = discoverNarrativeMaintenanceWork.mock.calls.length;
    runtime.coordinator?.dispose();
    runtime.scheduler?.dispose();
    return discoveries;
  }

  it("an accepted demand-wake cycle does not ask a live discovery chain for a rediscovery (DR-PUBG-5-17), where a discovery wake's cycle still does", async () => {
    expect(await discoveriesWithWakeDuringLiveChain("none")).toBe(1);
    // The demand's cycle is accepted, but it was a demand-only cycle.
    expect(await discoveriesWithWakeDuringLiveChain("demand-event")).toBe(1);
    expect(await discoveriesWithWakeDuringLiveChain("demand")).toBe(1);
    // The same demand cycle, when Native says it advanced the durable chain
    // (a Verify), still asks for the rediscovery that chain needs ...
    const verifyWork = [
      {
        workKey:
          "narrative-maintenance:v1/dependency-verify/project-electron-route/verify:v1",
        status: "succeeded" as const,
      },
    ];
    expect(await discoveriesWithWakeDuringLiveChain("demand", verifyWork)).toBe(
      2,
    );
    // ... while a cycle that only built the Graph Index does not.
    const buildWork = [
      {
        workKey:
          "narrative-maintenance:v1/nir1-graph-index-build/project-electron-route/nir1-graph-index-build/epoch/epoch-1",
        status: "succeeded" as const,
      },
    ];
    expect(await discoveriesWithWakeDuringLiveChain("demand", buildWork)).toBe(
      1,
    );
    // W1 and the seam's B wake register with the default origin: unchanged.
    expect(await discoveriesWithWakeDuringLiveChain("discovery")).toBe(2);
    // The same key asked for by both origins is a discovery wake.
    expect(await discoveriesWithWakeDuringLiveChain("mixed")).toBe(2);
  });

  /**
   * The chain's rediscovery budget is three. The planner keeps returning the
   * same work, so the chain does 1 + 3 discoveries and then stops. Wakes that
   * ride along must not change that count when they are demand, and must
   * (the control) use it up when they are not.
   */
  async function chainDiscoveries(
    injected: "none" | "demand" | "discovery",
    injections: number,
    receiptWorks: readonly { workKey: string; status: "succeeded" | "failed" }[] = [],
  ) {
    const discoverNarrativeMaintenanceWork = vi.fn().mockImplementation(
      async () =>
        JSON.stringify({
          workspaceBinding: binding,
          pages: [{ work: [workFor("workspace-opened")] }],
        }),
    );
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ status: "accepted", hasMore: false }),
      );
    let onEvent: ((channel: unknown, payload: unknown) => void) | null = null;
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: vi.fn(() =>
        JSON.stringify(binding),
      ),
      discoverNarrativeMaintenanceWork,
      runNarrativeMaintenanceCycle,
      ...lifecycleMethods(receiptWorks),
      onEvent(callback: (channel: unknown, payload: unknown) => void) {
        onEvent = callback;
      },
    } as unknown as NarrativeMaintenanceBackendLike & NapiBackendLike;
    const emit = (channel: unknown, payload: unknown) =>
      onEvent?.(channel, payload);
    const runtime = bootstrapNarrativeMaintenance(backend, productionSeam());
    registerEventBus(backend, (channel, eventPayload) => {
      runtime.coordinator?.handleBackendEvent(channel, eventPayload);
    });
    const requestRediscovery = vi.spyOn(
      runtime.coordinator!,
      "requestRediscovery",
    );
    emit("workspace:opened", {});
    for (let i = 0; i < injections && injected !== "none"; i += 1) {
      await vi.advanceTimersByTimeAsync(40);
      runtime.scheduler?.requestGraphIndexBuildWakesWithBinding?.(
        [`project-wake-${i}`],
        binding,
        injected === "demand" ? "demand" : undefined,
      );
    }
    await vi.runAllTimersAsync();
    const result = {
      discoveries: discoverNarrativeMaintenanceWork.mock.calls.length,
      rediscoveries: requestRediscovery.mock.calls.length,
      cycles: runNarrativeMaintenanceCycle.mock.calls.length,
    };
    runtime.coordinator?.dispose();
    runtime.scheduler?.dispose();
    return result;
  }

  it("demand wake cycles do not use up the chain's rediscovery budget of three; discovery wake cycles do", async () => {
    const baseline = await chainDiscoveries("none", 0);
    // 1 discovery, then 3 rediscoveries (the budget), each after an accepted
    // work cycle.
    expect(baseline.discoveries).toBe(4);
    expect(baseline.rediscoveries).toBe(baseline.cycles);

    const demand = await chainDiscoveries("demand", 6);
    expect(demand.cycles).toBeGreaterThan(baseline.cycles);
    expect(demand.discoveries).toBe(4);
    expect(demand.rediscoveries).toBe(baseline.rediscoveries);

    // A demand cycle whose only durable work failed advanced nothing, so it
    // does not use the budget either (a planner that keeps returning the same
    // work must not be spent down by demand).
    const failedVerify = [
      {
        workKey:
          "narrative-maintenance:v1/dependency-verify/project-wake-0/verify:v1",
        status: "failed" as const,
      },
    ];
    const failed = await chainDiscoveries("demand", 6, failedVerify);
    expect(failed.discoveries).toBe(4);
    expect(failed.rediscoveries).toBe(baseline.rediscoveries);

    // Residual (DR-PUBG-5-17 addendum 1-C): a demand cycle that Native says
    // completed durable chain work is not demand-only and takes the
    // rediscovery that chain needs, so a long run of such cycles does draw on
    // the budget.
    const advancing = await chainDiscoveries("demand", 6, [
      { ...failedVerify[0]!, status: "succeeded" as const },
    ]);
    expect(advancing.rediscoveries).toBeGreaterThan(baseline.rediscoveries);

    // Control: the same wakes as discovery wakes take rediscoveries too.
    const discovery = await chainDiscoveries("discovery", 6);
    expect(discovery.rediscoveries).toBeGreaterThan(baseline.rediscoveries);
  });
});
