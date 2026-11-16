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

  it("an accepted demand-wake cycle asks a live discovery chain for one more rediscovery, as every accepted cycle does (bootstrap's onCycleAccepted)", async () => {
    async function run(withDemand: boolean) {
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
      // The chain is alive with its first discovery in flight.
      emit("workspace:opened", {});
      await vi.advanceTimersByTimeAsync(0);
      expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();
      if (withDemand) {
        emit(
          "narrative-maintenance:graph-index-demand",
          '{"projectId":"project-electron-route"}',
        );
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

    // The demand's cycle is accepted like any other, so the bootstrap asks the
    // coordinator for a rediscovery (one attempt of its budget of three) while
    // the chain is alive; with the chain ended that request is a no-op. This
    // coupling is the existing wiring, which a Graph Index wake (W1 or W2)
    // joins (DR-PUBG-5-14 reviews it).
    expect(await run(false)).toBe(1);
    expect(await run(true)).toBe(2);
  });
});
