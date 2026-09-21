import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  parseNarrativeMaintenanceCiSeam,
  type NarrativeMaintenanceCiSeam,
} from "./narrativeMaintenanceCiSeam.js";
import { bootstrapNarrativeMaintenance } from "./narrativeMaintenanceBootstrap.js";
import {
  canonicalNarrativeMaintenanceWorkKey,
  NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS,
  type NarrativeMaintenanceBackendLike,
  type NarrativeMaintenanceCycleRequest,
  type NarrativeMaintenanceRequest,
} from "./narrativeMaintenance.js";

function activeSeam(
  overrides: Partial<
    Extract<NarrativeMaintenanceCiSeam, { active: true }>
  > = {},
): Extract<NarrativeMaintenanceCiSeam, { active: true }> {
  return {
    active: true,
    ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    nonce: "test-nonce",
    fault: null,
    trigger: null,
    setup: null,
    freshness: null,
    freshnessHoldProjectId: null,
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
    requestBeforeCutoverPreparation: vi.fn(),
    requestRediscovery: vi.fn(),
    drainWakeOutbox: vi.fn(async () => {}),
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
      {
        name: "setup",
        seam: activeSeam({ setup: "disabled" }),
        expected: false,
      },
      { name: "normal", seam: activeSeam(), expected: true },
      {
        name: "inactive",
        seam: parseNarrativeMaintenanceCiSeam({ CI: "false" }),
        expected: true,
      },
      {
        name: "packaged",
        seam: parseNarrativeMaintenanceCiSeam(
          {
            CI: "true",
            [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]:
              NARRATIVE_MAINTENANCE_OWNER_TOKEN,
          },
          { isPackaged: true },
        ),
        expected: true,
      },
      {
        name: "wrong-owner",
        seam: parseNarrativeMaintenanceCiSeam({
          CI: "true",
          [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: "other-owner",
        }),
        expected: true,
      },
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

      expect(
        createScheduler,
        `${name} scheduler factory`,
      ).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(
        createCoordinator,
        `${name} coordinator factory`,
      ).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(scheduler.start, `${name} scheduler start`).toHaveBeenCalledTimes(
        expected ? 1 : 0,
      );
      expect(
        coordinator.handleBackendEvent,
        `${name} synthetic startup discovery`,
      ).toHaveBeenCalledTimes(0);
      if (expected) {
        expect(runtime.scheduler).toBe(scheduler);
        expect(runtime.coordinator).toBe(coordinator);
      } else {
        expect(runtime).toEqual({ scheduler: null, coordinator: null });
      }
    }
  });

  it("does not wire maintenance or scheduler observations into CI evidence", () => {
    const scheduler = fakeScheduler();
    const coordinator = fakeCoordinator();
    const createScheduler = vi.fn(
      (_backend: unknown, _options?: unknown) => scheduler,
    );
    const createCoordinator = vi.fn(
      (_backend: unknown, _scheduler: unknown, _options?: unknown) =>
        coordinator,
    );

    bootstrapNarrativeMaintenance(null, activeSeam(), {
      createScheduler: createScheduler as never,
      createCoordinator: createCoordinator as never,
    });

    const schedulerOptions = createScheduler.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const coordinatorOptions = createCoordinator.mock.calls[0]?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(schedulerOptions).not.toHaveProperty("onCycleSettled");
    expect(schedulerOptions).not.toHaveProperty("runtimeStateReader");
    expect(coordinatorOptions).toBeUndefined();
  });
});

describe("C2-5B interrupted phase continuation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rediscovers before-cutover Rebuild after Verify succeeds but follow-up discovery is preempted", async () => {
    const binding = { authorityId: "cutover-authority", generation: 1 };
    const verify: NarrativeMaintenanceRequest = {
      projectId: "cutover-project",
      runKind: "dependency-verify",
      workKey: "dependency-verify:epoch-1",
      semanticEpochId: "epoch-1",
      reason: "before-cutover",
    };
    const rebuild: NarrativeMaintenanceRequest = {
      ...verify,
      runKind: "semantic-index-rebuild",
      workKey: "dependency-rebuild:epoch-1",
    };
    const requests: NarrativeMaintenanceCycleRequest[] = [];
    const events: string[] = [];
    let rebuilt = false;
    const discoverNarrativeMaintenanceWork = vi.fn(async () => {
      events.push("discover");
      // BeforeCutover starts a current Verify until its internal follow-up
      // has completed Rebuild; an ordinary durable wake alone finds no work.
      const work = rebuilt ? [] : [verify];
      return {
        workspaceBinding: binding,
        pages: [
          {
            work: work.map(({ reason, ...item }) => ({
              ...item,
              reasons: [reason],
            })),
          },
        ],
      };
    });
    const runNarrativeMaintenanceCycle = vi.fn(
      async (request: NarrativeMaintenanceCycleRequest) => {
        requests.push(request);
        events.push(request.work[0]?.runKind ?? "wake");
        if (requests.length === 1) {
          return { status: "accepted", hasMore: true, preempted: true };
        }
        rebuilt ||= request.work.some(
          (item) => item.runKind === "dependency-verify",
        );
        return { status: "accepted", hasMore: false };
      },
    );
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      discoverNarrativeMaintenanceWork,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt: (attemptId, receivedBinding) => ({
        status: "open",
        attemptId,
        ...receivedBinding,
      }),
      cancelNarrativeMaintenanceAttempt: (attemptId) => {
        const request = requests.find((item) => item.attemptId === attemptId)!;
        const interrupted = request === requests[0];
        events.push("receipt");
        return {
          schemaVersion: 1,
          attemptId,
          state: interrupted ? "interrupted" : "succeeded",
          stopReason: null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: interrupted ? null : binding.generation,
          works: [...request.work, ...(rebuilt ? [rebuild] : [])].map(
            (item) => ({
              workKey: canonicalNarrativeMaintenanceWorkKey(item),
              status: "succeeded",
            }),
          ),
          cleanup: { status: "clean" },
          connectionReusable: true,
        };
      },
      ackNarrativeMaintenanceDelivery: () => {
        events.push("ack");
        return { status: "retired" };
      },
    } satisfies NarrativeMaintenanceBackendLike & {
      discoverNarrativeMaintenanceWork: typeof discoverNarrativeMaintenanceWork;
    };
    const runtime = bootstrapNarrativeMaintenance(backend, activeSeam());

    try {
      runtime.coordinator!.requestBeforeCutoverPreparation();
      await vi.runAllTimersAsync();

      expect(rebuilt).toBe(true);
      expect(
        requests.map((request) => request.work.map((item) => item.runKind)),
      ).toEqual([["dependency-verify"], [], ["dependency-verify"]]);
      expect(requests[0]?.wakeProjectIds).toEqual([]);
      expect(requests[1]).toMatchObject({
        wakeProjectIds: [verify.projectId],
        workspaceBinding: binding,
      });
      expect(discoverNarrativeMaintenanceWork.mock.calls).toEqual([
        ["before-cutover"],
        ["before-cutover"],
        ["before-cutover"],
      ]);
      expect(events.slice(0, 6)).toEqual([
        "discover",
        "dependency-verify",
        "receipt",
        "ack",
        "wake",
        "receipt",
      ]);
      expect(requests[2]?.deliverySequence).toBeGreaterThan(
        requests[0]!.deliverySequence!,
      );
    } finally {
      await runtime.coordinator!.dispose();
      await runtime.scheduler!.dispose();
    }
  });

  it("keeps a preempted continuation quiesced and rejects its old binding after a workspace swap", async () => {
    const originalBinding = {
      authorityId: "original-authority",
      generation: 1,
    };
    let currentBinding = originalBinding;
    const verify: NarrativeMaintenanceRequest = {
      projectId: "original-project",
      runKind: "dependency-verify",
      workKey: "dependency-verify:epoch-1",
      semanticEpochId: "epoch-1",
      reason: "before-cutover",
    };
    const events: string[] = [];
    const discoverNarrativeMaintenanceWork = vi.fn(async () => {
      events.push("discover");
      const { reason, ...work } = verify;
      return {
        workspaceBinding: currentBinding,
        pages: [
          {
            work:
              currentBinding === originalBinding
                ? [{ ...work, reasons: [reason] }]
                : [],
          },
        ],
      };
    });
    const runNarrativeMaintenanceCycle = vi.fn(async () => ({
      status: "accepted",
      hasMore: true,
      preempted: true,
    }));
    const beginNarrativeMaintenanceAttempt = vi.fn(
      (attemptId: string, receivedBinding: typeof originalBinding) => {
        if (receivedBinding.authorityId !== currentBinding.authorityId) {
          events.push("binding-mismatch");
          throw new Error("NEX_MAINTENANCE_ATTEMPT_BINDING_MISMATCH");
        }
        return { status: "open", attemptId, ...receivedBinding };
      },
    );
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
      discoverNarrativeMaintenanceWork,
      runNarrativeMaintenanceCycle,
      beginNarrativeMaintenanceAttempt,
      cancelNarrativeMaintenanceAttempt: (attemptId: string) => ({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: null,
        generation: originalBinding.generation,
        workspaceBinding: originalBinding,
        publishedGeneration: null,
        works: [
          {
            workKey: canonicalNarrativeMaintenanceWorkKey(verify),
            status: "succeeded",
          },
        ],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
      ackNarrativeMaintenanceDelivery: () => ({ status: "retired" }),
    };
    const runtime = bootstrapNarrativeMaintenance(backend, activeSeam());

    try {
      runtime.coordinator!.requestBeforeCutoverPreparation();
      await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      const lease = await runtime.scheduler!.quiesceForWorkspaceSwitch!();
      currentBinding = { authorityId: "replacement-authority", generation: 2 };
      await vi.advanceTimersByTimeAsync(1_000);
      expect(beginNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
      expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();

      lease!.resume();
      await vi.runAllTimersAsync();
      expect(beginNarrativeMaintenanceAttempt).toHaveBeenCalledTimes(2);
      expect(beginNarrativeMaintenanceAttempt.mock.calls[1]?.[1]).toEqual(
        originalBinding,
      );
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(events).toEqual(["discover", "binding-mismatch", "discover"]);
    } finally {
      await runtime.coordinator!.dispose();
      await runtime.scheduler!.dispose();
    }
  });
});
