import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS,
  type NarrativeMaintenanceCycleResult,
  type NarrativeMaintenanceRequest,
  type NarrativeMaintenanceScheduler,
} from "./narrativeMaintenance.js";

const ERROR_RETRY_DELAY_MS = 1_000;

type WorkspaceBinding = { authorityId: string; generation: number };

type WiringScheduler = NarrativeMaintenanceScheduler & {
  requestWithBinding(
    work: NarrativeMaintenanceRequest,
    binding: WorkspaceBinding,
  ): void;
};

function backfill(projectId = "project-1"): NarrativeMaintenanceRequest {
  return {
    projectId,
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    reason: "workspace-opened",
  };
}

function accepted(): NarrativeMaintenanceCycleResult {
  return { status: "accepted", hasMore: false };
}

describe("narrative maintenance main-only wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the discovery binding instead of reacquiring a binding at enqueue time", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => ({
        authorityId: "reacquired",
        generation: 99,
      }),
      runNarrativeMaintenanceCycle,
    }) as WiringScheduler;
    const binding = { authorityId: "pinned", generation: 7 };

    scheduler.requestWithBinding(backfill(), binding);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledWith({
      work: [
        {
          projectId: "project-1",
          runKind: "backfill",
          workKey: "legacy-dependency-backfill:v2",
          semanticEpochId: null,
          reasons: ["workspace-opened"],
        },
      ],
      wakeProjectIds: [],
      workspaceBinding: binding,
    });
    scheduler.dispose();
  });

  it("allows Verify and Rebuild items to receive an accepted cycle", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const warn = vi.fn();
    const scheduler = createNarrativeMaintenanceScheduler(
      { runNarrativeMaintenanceCycle },
      { warn },
    );

    scheduler.request({
      projectId: "project-1",
      runKind: "dependency-verify",
      workKey: "dependency-verify:epoch-1",
      semanticEpochId: "epoch-1",
      reason: "restore-completed",
    });
    scheduler.request({
      projectId: "project-1",
      runKind: "semantic-index-rebuild",
      workKey: "dependency-rebuild-derived",
      semanticEpochId: "epoch-1",
      reason: "verify-required-rebuild",
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("dispatches a mixed Backfill, Verify, and Rebuild batch without parking enabled kinds", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(backfill("project-mixed"));
    scheduler.request({
      projectId: "project-mixed",
      runKind: "dependency-verify",
      workKey: "dependency-verify:epoch-mixed",
      semanticEpochId: "epoch-mixed",
      reason: "backfill-completed",
    });
    scheduler.request({
      projectId: "project-mixed",
      runKind: "semantic-index-rebuild",
      workKey: "dependency-rebuild-derived",
      semanticEpochId: "epoch-mixed",
      reason: "verify-required-rebuild",
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0].work).toHaveLength(
      3,
    );
    scheduler.dispose();
  });

  it("validates a complete exact-binding discovery batch before mutating the queue", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue(accepted());
    const scheduler = createNarrativeMaintenanceScheduler({
      runNarrativeMaintenanceCycle,
    });
    const binding = { authorityId: "pinned", generation: 7 };

    expect(() =>
      scheduler.requestManyWithBinding(
        [
          backfill("project-atomic"),
          {
            projectId: "project-atomic",
            runKind: "repair" as never,
            workKey: "repair",
            semanticEpochId: null,
            reason: "forged",
          },
        ],
        binding,
      ),
    ).toThrow();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).not.toHaveBeenCalled();
    expect(() =>
      scheduler.requestWithBinding(backfill("project-null"), null as never),
    ).toThrow();
    scheduler.dispose();
  });

  it("notifies the coordinator to rediscover after an authority mismatch without consuming retry budget", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "workspace-unavailable",
      reason: "maintenance-workspace-binding-mismatch",
    });
    const onWorkspaceBindingMismatch = vi.fn();
    const scheduler = createNarrativeMaintenanceScheduler(
      { runNarrativeMaintenanceCycle },
      { onWorkspaceBindingMismatch, warn: vi.fn() } as never,
    );

    scheduler.request(backfill());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);

    expect(onWorkspaceBindingMismatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    scheduler.dispose();
  });
});
