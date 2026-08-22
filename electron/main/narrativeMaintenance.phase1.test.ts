import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcMain: { on: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock("electron", () => electronMocks);

import type { NapiBackendLike } from "../shared/ipcContract.js";
import {
  createNarrativeMaintenanceTriggerCoordinator,
  type NarrativeMaintenanceWakeReason,
} from "./narrativeMaintenanceTriggers.js";
import {
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS,
  type NarrativeMaintenanceRequest,
  type NarrativeMaintenanceScheduler,
} from "./narrativeMaintenance.js";

const { registerEventBus } = await import("./events.js");
await import("../preload/index.js");

function makeScheduler() {
  return {
    requestManyWithBinding: vi.fn(),
  } as unknown as NarrativeMaintenanceScheduler & {
    requestManyWithBinding: ReturnType<typeof vi.fn>;
  };
}

function discovery(reason: NarrativeMaintenanceWakeReason) {
  return JSON.stringify({
    workspaceBinding: { authorityId: `authority-${reason}`, generation: 1 },
    pages: [],
  });
}

function backfill(reason = "workspace-open"): NarrativeMaintenanceRequest {
  return {
    projectId: "phase1-project",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    reason,
  };
}

describe("C2-5B main-only runtime integration contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electronMocks.ipcMain.on.mockClear();
    electronMocks.ipcRenderer.on.mockClear();
    electronMocks.ipcRenderer.invoke.mockClear();
    electronMocks.ipcRenderer.send.mockClear();
    electronMocks.BrowserWindow.getAllWindows.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("routes the real workspace:opened observer to main discovery for open and restore", async () => {
    let nativeObserver:
      | ((channel: unknown, payload: unknown) => void)
      | undefined;
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockResolvedValueOnce(discovery("workspace-opened"))
      .mockResolvedValueOnce(discovery("restore-completed"));
    const backend = {
      onEvent(callback: (channel: unknown, payload: unknown) => void) {
        nativeObserver = callback;
      },
      discoverNarrativeMaintenanceWork,
    } as unknown as NapiBackendLike & {
      discoverNarrativeMaintenanceWork: typeof discoverNarrativeMaintenanceWork;
    };
    const scheduler = makeScheduler();
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      backend,
      scheduler,
    );

    registerEventBus(backend, coordinator.handleBackendEvent);
    nativeObserver?.("workspace:opened", JSON.stringify({ path: "/open" }));
    await vi.runAllTimersAsync();
    nativeObserver?.(
      "workspace:opened",
      JSON.stringify({ path: "/restore", reason: "restore" }),
    );
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      1,
      "workspace-opened",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      2,
      "restore-completed",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("does not expose a maintenance symbol through the preload bridge", () => {
    const exposed = electronMocks.contextBridge.exposeInMainWorld.mock
      .calls[0];
    expect(exposed?.[0]).toBe("grimodex");
    const bridge = exposed?.[1] as Record<string, unknown> | undefined;
    expect(bridge).toBeDefined();
    expect(Object.keys(bridge ?? {})).not.toEqual(
      expect.arrayContaining([
        "narrativeMaintenance",
        "discoverNarrativeMaintenanceWork",
        "runNarrativeMaintenanceCycle",
      ]),
    );
    expect(JSON.stringify(bridge)).not.toMatch(/narrativeMaintenance/i);
  });
});

describe("C2-5B Phase 1 main-only integration behavior", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers an automatic workspace wake as a typed main cycle", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue({ status: "accepted", hasMore: false });
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(backfill());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledWith({
      work: [
        {
          projectId: "phase1-project",
          runKind: "backfill",
          workKey: "legacy-dependency-backfill:v2",
          semanticEpochId: null,
          reasons: ["workspace-open"],
        },
      ],
      wakeProjectIds: [],
    });
    scheduler.dispose();
  });

  it("rejects a human-only Repair wake at the executable scheduler boundary", () => {
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle: vi.fn(),
    });

    expect(() =>
      scheduler.request({
        ...backfill("must-not-repair"),
        runKind: "dependency-repair" as NarrativeMaintenanceRequest["runKind"],
      }),
    ).toThrow(/automatic|Repair|runKind/i);
    scheduler.dispose();
  });
});
