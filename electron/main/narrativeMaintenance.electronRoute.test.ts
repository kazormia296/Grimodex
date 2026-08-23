import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  type NarrativeMaintenanceCiSeam,
} from "./narrativeMaintenanceCiSeam.js";
import { bootstrapNarrativeMaintenance } from "./narrativeMaintenanceBootstrap.js";
import type { NarrativeMaintenanceBackendLike } from "./narrativeMaintenance.js";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: vi.fn() },
}));

const { registerEventBus } = await import("./events.js");

const binding = { authorityId: "authority-electron", generation: 7 };

function activeSeam(): Extract<NarrativeMaintenanceCiSeam, { active: true }> {
  return {
    active: true,
    ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    fault: null,
    trigger: null,
    setup: null,
    productJourneyBarrierId: null,
    correlation: null,
  };
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
    .mockResolvedValueOnce(JSON.stringify({ status: "accepted", hasMore: true }))
    .mockResolvedValueOnce(JSON.stringify({ status: "accepted", hasMore: false }));
  let onEvent: ((channel: unknown, payload: unknown) => void) | null = null;
  const backend = {
    getNarrativeMaintenanceWorkspaceBinding: vi.fn(() => JSON.stringify(binding)),
    discoverNarrativeMaintenanceWork,
    runNarrativeMaintenanceCycle,
    onEvent(callback: (channel: unknown, payload: unknown) => void) {
      onEvent = callback;
    },
  } as unknown as NarrativeMaintenanceBackendLike & {
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
    ["restore-completed", { reason: "restore", path: "/not-forwarded" }, "restore-completed"],
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
        activeSeam(),
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
      expect(fixture.runNarrativeMaintenanceCycle).toHaveBeenNthCalledWith(
        1,
        {
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
        },
      );
      expect(fixture.runNarrativeMaintenanceCycle).toHaveBeenNthCalledWith(
        2,
        {
          work: [],
          wakeProjectIds: ["project-electron-route"],
          workspaceBinding: binding,
        },
      );
      expect(fixture.runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(fixture.discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
        expectedReason,
      );

      runtime.coordinator?.dispose();
      runtime.scheduler?.dispose();
    },
  );
});
