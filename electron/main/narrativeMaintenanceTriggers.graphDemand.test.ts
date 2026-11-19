import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceTriggerCoordinator,
  narrativeMaintenanceGraphDemandIntervalMs,
  NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_INTERVAL_MS,
  NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_KEYS,
  NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_PROJECT_ID_LENGTH,
  type NarrativeMaintenanceTriggerCoordinator,
} from "./narrativeMaintenanceTriggers.js";
import type {
  NarrativeMaintenanceScheduler,
  NarrativeMaintenanceWorkspaceBinding,
} from "./narrativeMaintenance.js";

/**
 * DR-PUBG-5-14: Native's Graph owner raises `narrative-maintenance:graph-index-demand`
 * ({ projectId }) when a Graph demand met a refused registration. The
 * coordinator turns it into one Graph Index build wake per (binding, project),
 * spaced 2 s .. 60 s, outside the discovery chain.
 */

const DEMAND = "narrative-maintenance:graph-index-demand";
const FIRST: NarrativeMaintenanceWorkspaceBinding = {
  authorityId: "authority-demand",
  generation: 1,
};

function setup(
  options: {
    accept?: boolean;
    wakes?: boolean;
    binding?: NarrativeMaintenanceWorkspaceBinding | null;
  } = {},
) {
  const state = {
    binding: options.binding === undefined ? FIRST : options.binding,
    // A transition answers WORKSPACE_SWITCHING (the getter throws).
    switching: false,
  };
  const requestGraphIndexBuildWakesWithBinding = vi.fn();
  const requestManyWithBinding = vi.fn();
  const scheduler = {
    requestManyWithBinding,
    ...(options.wakes === false
      ? {}
      : { requestGraphIndexBuildWakesWithBinding }),
  } as unknown as NarrativeMaintenanceScheduler;
  const discoverNarrativeMaintenanceWork = vi.fn();
  const warn = vi.fn();
  const coordinator = createNarrativeMaintenanceTriggerCoordinator(
    {
      getNarrativeMaintenanceWorkspaceBinding: () => {
        if (state.switching) {
          throw new Error("WORKSPACE_SWITCHING: workspace is switching");
        }
        return state.binding;
      },
      discoverNarrativeMaintenanceWork,
    },
    scheduler,
    {
      warn,
      ...(options.accept === false ? {} : { acceptGraphIndexBuildWakes: true }),
    },
  );
  return {
    state,
    coordinator,
    wakes: requestGraphIndexBuildWakesWithBinding,
    requestManyWithBinding,
    discoverNarrativeMaintenanceWork,
    warn,
    demand: (projectId: unknown) =>
      coordinator.handleBackendEvent(DEMAND, { projectId }),
  };
}

describe("Graph Index demand wakes (DR-PUBG-5-14)", () => {
  let live: NarrativeMaintenanceTriggerCoordinator | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  });

  afterEach(async () => {
    await live?.dispose();
    live = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function harness(options?: Parameters<typeof setup>[0]) {
    const built = setup(options);
    live = built.coordinator;
    return built;
  }

  it("spaces the wakes of one run: 2 s, 4 s, 8 s, 16 s, 32 s, then 60 s", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7, 40].map(narrativeMaintenanceGraphDemandIntervalMs),
    ).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it("registers one wake for the project, directly with the scheduler and its bound binding", async () => {
    const h = harness();
    h.demand("project-a");
    expect(h.wakes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledExactlyOnceWith(
      ["project-a"],
      FIRST,
      "demand",
    );
    // It is not a discovery: no discovery call, no work, and the wake chain
    // has no reason to rediscover.
    expect(h.discoverNarrativeMaintenanceWork).not.toHaveBeenCalled();
    expect(h.requestManyWithBinding).not.toHaveBeenCalled();
    h.coordinator.requestRediscovery();
    await vi.runAllTimersAsync();
    expect(h.discoverNarrativeMaintenanceWork).not.toHaveBeenCalled();
  });

  it("joins every demand of a pending pair into the one wake and arms no second timer", async () => {
    const h = harness();
    h.demand("project-a");
    h.demand("project-a");
    h.demand("project-a");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledTimes(1);

    // Inside the spacing the demand joins one timer at the end of the spacing
    // (it is not dropped, and a second demand does not add a second wake).
    await vi.advanceTimersByTimeAsync(500);
    h.demand("project-a");
    h.demand("project-a");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(h.wakes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.wakes).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lengthens the spacing with each wake of a run and starts a new run after 60 s of quiet", async () => {
    const h = harness();
    const fireTimes: number[] = [];
    h.wakes.mockImplementation(() => fireTimes.push(Date.now()));
    const start = Date.now();
    // Sustained demand: one every second for 5 minutes.
    for (let second = 0; second < 300; second += 1) {
      h.demand("project-a");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const offsets = fireTimes.map((time) => time - start);
    // 0, +2 s, +4 s, +8 s, +16 s, +32 s, then every 60 s.
    expect(offsets.slice(0, 7)).toEqual([
      0, 2_000, 6_000, 14_000, 30_000, 62_000, 122_000,
    ]);
    for (let index = 6; index < offsets.length - 1; index += 1) {
      expect(offsets[index + 1]! - offsets[index]!).toBe(60_000);
    }

    // 60 s without a demand (after the wake that was still waiting): the next
    // demand fires at once, and the run restarts at 2 s.
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(
      NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_INTERVAL_MS,
    );
    fireTimes.length = 0;
    const quietEnd = Date.now();
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(fireTimes).toEqual([quietEnd]);
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fireTimes).toEqual([quietEnd, quietEnd + 2_000]);
  });

  it("keeps the pairs independent", async () => {
    const h = harness();
    h.demand("project-a");
    h.demand("project-b");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes.mock.calls.map((call) => call[0])).toEqual([
      ["project-a"],
      ["project-b"],
    ]);
  });

  it("tracks at most 8 pairs and drops a ninth instead of evicting: the table frees itself after 60 s of quiet", async () => {
    const h = harness();
    const keys = NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_KEYS;
    expect(keys).toBe(8);
    for (let index = 0; index < keys; index += 1) h.demand(`project-${index}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledTimes(keys);

    // The table is full: a new pair is dropped, and an old pair keeps its spacing.
    h.demand("project-new");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.wakes).toHaveBeenCalledTimes(keys);
    h.demand("project-0");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.wakes).toHaveBeenCalledTimes(keys + 1);

    // After the longest spacing of quiet, the unused pairs are forgotten.
    await vi.advanceTimersByTimeAsync(
      NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_INTERVAL_MS,
    );
    h.demand("project-new");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenLastCalledWith(
      ["project-new"],
      FIRST,
      "demand",
    );
  });

  it("drops the demand when the binding changed before the wake fires, and never wakes the replacement workspace for the old project", async () => {
    const h = harness();
    h.demand("project-a");
    h.state.binding = { authorityId: "authority-demand", generation: 2 };
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.wakes).not.toHaveBeenCalled();
    // The new binding is its own pair.
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledExactlyOnceWith(
      ["project-a"],
      { authorityId: "authority-demand", generation: 2 },
      "demand",
    );
  });

  it("ignores a demand when no workspace binding is available", async () => {
    const h = harness({ binding: null });
    h.demand("project-a");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.wakes).not.toHaveBeenCalled();
  });

  it("a new workspace (or a restore) clears every pending demand and forgets the old pairs", async () => {
    const h = harness();
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(0);
    h.demand("project-a"); // pending: inside the spacing
    expect(vi.getTimerCount()).toBe(1);
    h.coordinator.handleBackendEvent("workspace:opened", { reason: "restore" });
    // The discovery chain's own timer is armed by the event; the demand's is gone.
    expect(h.coordinator.getQuiescenceState?.().timerScheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const afterOpen = h.wakes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.wakes).toHaveBeenCalledTimes(afterOpen);
    // The same pair starts a new run (the table was cleared).
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledTimes(afterOpen + 1);
  });

  // DR-PUBG-5-18 (R-B). Native emits a demand (E1) before `workspace:opened`
  // (E2) of a switch, because the callers of the Suspended branches hold a
  // workspace participant that the switch has to wait for. The event carries no
  // binding, so main binds it to the live binding when it handles it.
  const REPLACEMENT: NarrativeMaintenanceWorkspaceBinding = {
    authorityId: "authority-replacement",
    generation: 1,
  };

  it("DR-PUBG-5-18: a demand handled once the replacement is Ready, in the same drain as workspace:opened, wakes nothing", async () => {
    const h = harness();
    // The queue holds E1 then E2 when main gets to them: the getter already
    // answers the replacement's binding, and both events run before any timer.
    h.state.binding = REPLACEMENT;
    h.demand("project-a");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.coordinator.handleBackendEvent("workspace:opened", {
      path: "/replacement",
      restoreOnly: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.wakes).not.toHaveBeenCalled();
  });

  it("DR-PUBG-5-18: a demand that meets a switching workspace is dropped without a timer, and the next demand after the switch is its own", async () => {
    const h = harness();
    h.state.switching = true;
    h.demand("project-a");
    expect(vi.getTimerCount()).toBe(0);
    expect(h.warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.wakes).not.toHaveBeenCalled();
    h.state.switching = false;
    h.state.binding = REPLACEMENT;
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledExactlyOnceWith(
      ["project-a"],
      REPLACEMENT,
    );
  });

  it("DR-PUBG-5-18: the residual the DR accepts: a demand that reaches main after workspace:opened is bound to the replacement and wakes it once", async () => {
    const h = harness();
    h.state.binding = REPLACEMENT;
    h.coordinator.handleBackendEvent("workspace:opened", {
      path: "/replacement",
      restoreOnly: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    const afterOpen = h.wakes.mock.calls.length;
    // Native does not emit this order in a switch (the E1 of a participant
    // holder is queued first); only a thread that stalled across the whole
    // switch could. The event cannot tell, so it is the replacement's demand.
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledTimes(afterOpen + 1);
    expect(h.wakes).toHaveBeenLastCalledWith(["project-a"], REPLACEMENT);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.wakes).toHaveBeenCalledTimes(afterOpen + 1);
  });

  it("dispose clears the timer and a disposed coordinator accepts nothing", async () => {
    const h = harness();
    h.demand("project-a");
    expect(vi.getTimerCount()).toBe(1);
    await h.coordinator.dispose();
    expect(vi.getTimerCount()).toBe(0);
    h.demand("project-a");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.wakes).not.toHaveBeenCalled();
  });

  it("is inert without the acceptance option or without the scheduler's wake capability", async () => {
    for (const options of [{ accept: false }, { wakes: false }]) {
      const h = harness(options);
      h.demand("project-a");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.wakes).not.toHaveBeenCalled();
      await h.coordinator.dispose();
    }
  });

  it("drops a payload that is not exactly a project, with a fixed warning that names no ID", async () => {
    const h = harness();
    const secret = "never-logged-project-id";
    const tooLong = "p".repeat(
      NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_PROJECT_ID_LENGTH + 1,
    );
    for (const payload of [
      null,
      "project-a",
      [],
      {},
      { projectId: "" },
      { projectId: 7 },
      { projectId: " padded" },
      { projectId: "nul\u0000byte" },
      { projectId: tooLong },
      { projectId: secret, extra: true },
      { project: secret },
    ]) {
      h.coordinator.handleBackendEvent(DEMAND, payload);
    }
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.wakes).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledTimes(11);
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain(secret);
    // The longest ID that is allowed passes.
    h.demand(
      "p".repeat(NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_PROJECT_ID_LENGTH),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed wake: the next demand after the spacing asks again", async () => {
    const h = harness();
    h.wakes.mockImplementationOnce(() => {
      throw new Error("scheduler refused");
    });
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.wakes).toHaveBeenCalledTimes(1);
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledTimes(2);
  });

  it("re-anchors the spacing when the wall clock moves backwards", async () => {
    const h = harness();
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() - 10 * 60_000);
    h.demand("project-a");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.wakes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.wakes).toHaveBeenCalledTimes(2);
  });

  it("frees a full table after a backwards clock step once 60 s of real quiet have passed", async () => {
    const h = harness();
    for (
      let index = 0;
      index < NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_KEYS;
      index += 1
    ) {
      h.demand(`project-${index}`);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_KEYS,
    );
    vi.setSystemTime(Date.now() - 10 * 60_000);
    // Still full: the new pair is dropped (and the old ones are re-anchored).
    h.demand("project-new");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(
      NARRATIVE_MAINTENANCE_GRAPH_DEMAND_MAX_INTERVAL_MS,
    );
    h.demand("project-new");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakes).toHaveBeenLastCalledWith(
      ["project-new"],
      FIRST,
      "demand",
    );
  });

  it("shows a waiting demand to the quiescence writer and settles when it fires", async () => {
    const h = harness();
    const before = h.coordinator.getQuiescenceState?.();
    expect(before?.timerScheduled).toBe(false);
    h.demand("project-a");
    const waiting = h.coordinator.getQuiescenceState?.();
    expect(waiting?.timerScheduled).toBe(true);
    expect(waiting!.mutationRevision).toBeGreaterThan(before!.mutationRevision);
    // The demand is not a discovery chain.
    expect(waiting?.discoveryInFlight).toBe(false);
    expect(waiting?.pendingEvent).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    const settled = h.coordinator.getQuiescenceState?.();
    expect(settled?.timerScheduled).toBe(false);
    expect(settled!.mutationRevision).toBeGreaterThan(
      waiting!.mutationRevision,
    );
  });
});
