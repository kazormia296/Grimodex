import { describe, expect, it, vi } from "vitest";

import {
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  type NarrativeMaintenanceCiSeam,
} from "./narrativeMaintenanceCiSeam.js";
import { bootstrapNarrativeMaintenance } from "./narrativeMaintenanceBootstrap.js";

function activeSeam(
  overrides: Partial<Extract<NarrativeMaintenanceCiSeam, { active: true }>> = {},
): Extract<NarrativeMaintenanceCiSeam, { active: true }> {
  return {
    active: true,
    ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    fault: null,
    trigger: null,
    setup: null,
    productJourneyBarrierId: null,
    correlation: null,
    ...overrides,
  };
}

function fakeScheduler() {
  return {
    start: vi.fn(),
    request: vi.fn(),
    enqueue: vi.fn(),
    requestWithBinding: vi.fn(),
    requestManyWithBinding: vi.fn(),
    dispose: vi.fn(),
  };
}

function fakeCoordinator() {
  return {
    handleBackendEvent: vi.fn(),
    requestRediscovery: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("C2-5B production maintenance bootstrap", () => {
  it("injects factories while asserting setup and ordinary startup reachability", () => {
    const cases: Array<{
      name: string;
      seam: NarrativeMaintenanceCiSeam;
      expected: boolean;
    }> = [
      { name: "setup", seam: activeSeam({ setup: "disabled" }), expected: false },
      { name: "normal", seam: activeSeam(), expected: true },
      { name: "inactive", seam: { active: false }, expected: true },
      { name: "packaged", seam: { active: false }, expected: true },
      { name: "wrong-owner", seam: { active: false }, expected: true },
    ];

    for (const { name, seam, expected } of cases) {
      const scheduler = fakeScheduler();
      const coordinator = fakeCoordinator();
      const createScheduler = vi.fn(() => scheduler);
      const createCoordinator = vi.fn(() => coordinator);

      const runtime = bootstrapNarrativeMaintenance(null, seam, {
        createScheduler,
        createCoordinator,
      });

      expect(createScheduler, `${name} scheduler factory`).toHaveBeenCalledTimes(
        expected ? 1 : 0,
      );
      expect(createCoordinator, `${name} coordinator factory`).toHaveBeenCalledTimes(
        expected ? 1 : 0,
      );
      expect(scheduler.start, `${name} scheduler start`).toHaveBeenCalledTimes(
        expected ? 1 : 0,
      );
      expect(
        coordinator.handleBackendEvent,
        `${name} startup discovery`,
      ).toHaveBeenCalledTimes(expected ? 1 : 0);
      if (expected) {
        expect(coordinator.handleBackendEvent).toHaveBeenCalledWith(
          "workspace:opened",
          undefined,
        );
        expect(runtime.scheduler).toBe(scheduler);
        expect(runtime.coordinator).toBe(coordinator);
      } else {
        expect(runtime).toEqual({ scheduler: null, coordinator: null });
      }
    }
  });
});
