import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalNarrativeMaintenanceWorkKey,
  coalesceNarrativeMaintenanceWork,
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_MAX_RETRIES,
  scheduleNarrativeMaintenanceProcessInterruption,
  type NarrativeMaintenanceCycleResult,
  type NarrativeMaintenanceRequest,
  type NarrativeMaintenanceSchedulerOptions,
} from "./narrativeMaintenance.js";

const INITIAL_DELAY_MS = 250;
const IDLE_POLL_INTERVAL_MS = 1_000;
const BACKLOG_DELAY_MS = 10;
const ERROR_RETRY_DELAY_MS = 1_000;

function work(
  projectId: string,
  runKind: NarrativeMaintenanceRequest["runKind"],
  workKey: string,
  reason: string,
): NarrativeMaintenanceRequest {
  return { projectId, runKind, workKey, reason };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function acceptedCycle(hasMore = false): NarrativeMaintenanceCycleResult {
  return { status: "accepted", hasMore };
}

function renderedWarnings(warn: ReturnType<typeof vi.fn>): string[] {
  return warn.mock.calls.map((args) => args.map(String).join(" "));
}

describe("narrative maintenance scheduler", () => {
  const schedulers: Array<{ dispose(): void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createScheduler(
    backend: unknown,
    warn = vi.fn(),
    options: Omit<NarrativeMaintenanceSchedulerOptions, "warn"> = {},
  ) {
    const scheduler = createNarrativeMaintenanceScheduler(
      backend as Parameters<typeof createNarrativeMaintenanceScheduler>[0],
      { warn, ...options },
    );
    schedulers.push(scheduler);
    return { scheduler, warn };
  }

  it("schedules interruption exit only for an authorized exact live binding", () => {
    const expectedBinding = { authorityId: "authority-1", generation: 7 };
    let currentBinding = expectedBinding;
    const ack: Parameters<typeof scheduleNarrativeMaintenanceProcessInterruption>[1] = {
      status: "ci-process-interruption-pending",
      fault: "process-interruption",
      runId: "run-1",
      authorityId: expectedBinding.authorityId,
      generation: expectedBinding.generation,
    };
    const scheduled: Array<() => void> = [];
    const exit = vi.fn();
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
    };

    expect(
      scheduleNarrativeMaintenanceProcessInterruption(
        backend,
        ack,
        expectedBinding,
        () => false,
        (callback) => {
          scheduled.push(callback);
        },
        exit,
      ),
    ).toBe(false);
    expect(scheduled).toHaveLength(0);

    expect(
      scheduleNarrativeMaintenanceProcessInterruption(
        backend,
        ack,
        expectedBinding,
        () => true,
        (callback) => {
          scheduled.push(callback);
        },
        exit,
      ),
    ).toBe(true);
    expect(scheduled).toHaveLength(1);
    currentBinding = { authorityId: "rotated", generation: 8 };
    scheduled[0]?.();
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    ["false", () => false],
    ["throw", () => {
      throw new Error("scheduler rejected");
    }],
  ])(
    "retains a process-interruption batch for retry when the main owner returns %s",
    async (_label, onCiProcessInterruption) => {
      const binding = { authorityId: "authority-1", generation: 7 };
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce({
          status: "ci-process-interruption-pending",
          fault: "process-interruption",
          runId: "run-1",
          authorityId: binding.authorityId,
          generation: binding.generation,
        })
        .mockResolvedValue(acceptedCycle());
      const { scheduler } = createScheduler(
        {
          getNarrativeMaintenanceWorkspaceBinding: () => binding,
          runNarrativeMaintenanceCycle,
        },
        vi.fn(),
        { onCiProcessInterruption },
      );

      scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    },
  );

  it("does not handle a terminal ACK when its binding cannot prove the durable Run", async () => {
    const binding = { authorityId: "authority-1", generation: 7 };
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ci-terminal-fault-handled",
        fault: "contract-violation",
        runId: "run-1",
        authorityId: "forged-authority",
        generation: binding.generation,
      })
      .mockResolvedValue(acceptedCycle());
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("does not retry a terminal ACK whose exact binding is proven", async () => {
    const binding = { authorityId: "authority-1", generation: 7 };
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue({
      status: "ci-terminal-fault-handled",
      fault: "contract-violation",
      runId: "run-1",
      authorityId: binding.authorityId,
      generation: binding.generation,
    });
    const { scheduler } = createScheduler({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
  });

  it("canonical key includes project, run kind, and work key", () => {
    const backfill = work("project-1", "backfill", "same", "open");
    const verify = work("project-1", "dependency-verify", "same", "verify");
    const rebuildEpoch1 = {
      ...work("project-1", "semantic-index-rebuild", "same", "rebuild"),
      semanticEpochId: "epoch-1",
    };
    const rebuildEpoch2 = {
      ...rebuildEpoch1,
      semanticEpochId: "epoch-2",
    };
    expect(canonicalNarrativeMaintenanceWorkKey(backfill)).not.toBe(
      canonicalNarrativeMaintenanceWorkKey(verify),
    );
    expect(canonicalNarrativeMaintenanceWorkKey(rebuildEpoch1)).not.toBe(
      canonicalNarrativeMaintenanceWorkKey(rebuildEpoch2),
    );
  });

  it("rejects path separators and non-automatic run kinds at the runtime boundary", () => {
    expect(() =>
      canonicalNarrativeMaintenanceWorkKey(
        work("project/one", "backfill", "work", "open"),
      ),
    ).toThrow(/slash|separator|must not/i);

    const { scheduler } = createScheduler({
      runNarrativeMaintenanceCycle: vi.fn().mockResolvedValue(acceptedCycle()),
    });
    expect(() =>
      scheduler.request({
        projectId: "project-1",
        runKind: "dependency-repair" as NarrativeMaintenanceRequest["runKind"],
        workKey: "repair",
        reason: "must-never-run",
      }),
    ).toThrow(/runKind|automatic|Repair/i);
  });

  it("same project and kind/key coalesce reasons while different kinds remain distinct", () => {
    const entries = coalesceNarrativeMaintenanceWork([
      work("project-1", "backfill", "backfill:v2", "workspace-open"),
      work("project-1", "backfill", "backfill:v2", "retry"),
      work("project-1", "dependency-verify", "verify:epoch-1", "backfill-done"),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.reasons).toEqual(["workspace-open", "retry"]);
    expect(entries[1]?.reasons).toEqual(["backfill-done"]);

    const epochEntries = coalesceNarrativeMaintenanceWork([
      {
        ...work("project-1", "semantic-index-rebuild", "rebuild", "epoch-1"),
        semanticEpochId: "epoch-1",
      },
      {
        ...work("project-1", "semantic-index-rebuild", "rebuild", "epoch-2"),
        semanticEpochId: "epoch-2",
      },
    ]);
    expect(epochEntries).toHaveLength(2);
  });

  it("one in-flight main cycle serializes cross-kind work for a project", async () => {
    const first = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(acceptedCycle());
    const { scheduler } = createScheduler({ runNarrativeMaintenanceCycle });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open"],
        },
      ],
      wakeProjectIds: [],
    });

    scheduler.request(
      work("project-1", "dependency-verify", "verify:epoch-1", "backfill-done"),
    );
    scheduler.request(
      work("project-1", "semantic-index-rebuild", "rebuild", "derived-invalid"),
    );
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    first.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "dependency-verify",
          workKey: "verify:epoch-1",
          semanticEpochId: null,
          reasons: ["backfill-done"],
        },
        {
          projectId: "project-1",
          runKind: "semantic-index-rebuild",
          workKey: "rebuild",
          semanticEpochId: null,
          reasons: ["derived-invalid"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it("pending work is coalesced before the first cycle", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue(acceptedCycle());
    const { scheduler } = createScheduler({ runNarrativeMaintenanceCycle });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.request(
      work("project-1", "backfill", "backfill:v2", "manual-retry"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open", "manual-retry"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it.each([
    ["legacy null", null],
    ["explicit unavailable status", { status: "workspace-unavailable" }],
  ])(
    "%s requeues the claimed batch until the backend accepts it",
    async (_label, unavailableResponse) => {
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce(unavailableResponse)
        .mockResolvedValueOnce(acceptedCycle());
      const { scheduler, warn } = createScheduler({
        runNarrativeMaintenanceCycle,
      });
      const originalWork = work(
        "project-1",
        "backfill",
        "backfill:v2",
        "workspace-open",
      );

      scheduler.request(originalWork);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual(
        runNarrativeMaintenanceCycle.mock.calls[0]?.[0],
      );
    },
  );

  it("keeps an unavailable-workspace trigger beyond the bounded error budget", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue({ status: "workspace-unavailable" });
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(
      work("project-1", "backfill", "backfill:v2", "workspace-open"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (
      let retry = 0;
      retry < NARRATIVE_MAINTENANCE_MAX_RETRIES + 1;
      retry += 1
    ) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 2,
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).toLowerCase().includes("retry exhausted"),
      ),
    ).toBe(false);
  });

  it("retains a project-scoped durable wake when its workspace is unavailable", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce(acceptedCycle(true))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(acceptedCycle());
    const { scheduler } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(
      work("project-1", "backfill", "backfill:v2", "workspace-open"),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [],
      wakeProjectIds: ["project-1"],
    });

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle.mock.calls[2]?.[0]).toEqual({
      work: [],
      wakeProjectIds: ["project-1"],
    });
  });

  it("hasMore keeps a durable backlog wake and invokes the next cycle with an empty batch", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce(acceptedCycle(true))
      .mockResolvedValueOnce(acceptedCycle());
    const { scheduler } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [],
      wakeProjectIds: ["project-1"],
    });
  });

  it("scopes an empty hasMore wake to its project and leaves another project independent", async () => {
    const p1Wake = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce(acceptedCycle(true))
      .mockReturnValueOnce(p1Wake.promise)
      .mockResolvedValue(acceptedCycle());
    const backend = { runNarrativeMaintenanceCycle };
    const { scheduler: firstScheduler } = createScheduler(backend);
    const { scheduler: sameProjectScheduler } = createScheduler(backend);
    const { scheduler: otherProjectScheduler } = createScheduler(backend);

    firstScheduler.request(
      work("project-1", "backfill", "backfill:v2", "open"),
    );
    firstScheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [],
      wakeProjectIds: ["project-1"],
    });

    sameProjectScheduler.request(
      work("project-1", "dependency-verify", "verify:epoch-1", "verify"),
    );
    sameProjectScheduler.start();
    otherProjectScheduler.request(
      work("project-2", "backfill", "backfill:v2", "open"),
    );
    otherProjectScheduler.start();

    // The same project is still claimed by the empty wake.  Its scheduler
    // waits for release instead of spinning a timer; project-2 can proceed.
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(3);
    expect(runNarrativeMaintenanceCycle.mock.calls[2]?.[0]).toEqual({
      work: [
        {
          projectId: "project-2",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open"],
        },
      ],
      wakeProjectIds: [],
    });

    p1Wake.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(4);
    expect(runNarrativeMaintenanceCycle.mock.calls[3]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "dependency-verify",
          workKey: "verify:epoch-1",
          semanticEpochId: null,
          reasons: ["verify"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it("cycle failure warns and retries only the pending work", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValueOnce(new Error("native unavailable"))
      .mockResolvedValue(acceptedCycle());
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(warn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("renders a requeued transient failure as a bounded non-error warning", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("NEX_MAINTENANCE_TRANSIENT: injected maintenance fault"),
      )
      .mockResolvedValue(acceptedCycle());
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    const rendered = renderedWarnings(warn).join("\n");
    expect(rendered).toContain("NEX_MAINTENANCE_TRANSIENT");
    expect(rendered).toMatch(/retry scheduled/i);
    expect(rendered).not.toMatch(
      /\b(?:error|errors|failed|failure|fatal|panic|uncaught|unhandled|crash)\b/i,
    );

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
  });

  it("keeps error-class diagnostics when a transient failure exhausts retries", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValue(
        new Error("NEX_MAINTENANCE_TRANSIENT: injected maintenance fault"),
      );
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    const rendered = renderedWarnings(warn).join("\n");
    expect(rendered).toMatch(/retry exhausted/i);
    expect(rendered).toMatch(/\b(?:error|errors|failed|failure)\b/i);
  });

  it("malformed native cycle JSON is retried instead of being treated as a successful drain", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValueOnce("{not-json")
      .mockResolvedValueOnce(acceptedCycle());
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it.each([
    "{}",
    "[]",
    "0",
    '"ok"',
    "null",
    '{"hasMore":1}',
    '{"other":false}',
  ])(
    "retries valid JSON with an invalid cycle shape (%s)",
    async (malformedResponse) => {
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce(malformedResponse)
        .mockResolvedValueOnce(acceptedCycle());
      const { scheduler, warn } = createScheduler({
        runNarrativeMaintenanceCycle,
      });

      scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
        work: [
          {
            projectId: "project-1",
            runKind: "backfill",
            workKey: "backfill:v2",
            semanticEpochId: null,
            reasons: ["open"],
          },
        ],
        wakeProjectIds: [],
      });
    },
  );

  it.each([
    ["object", { hasMore: false }],
    ["JSON string", '{"hasMore":false}'],
  ])(
    "retries status-less hasMore response (%s) instead of ACKing it",
    async (_label, malformedResponse) => {
      const runNarrativeMaintenanceCycle = vi
        .fn()
        .mockResolvedValueOnce(malformedResponse)
        .mockResolvedValueOnce(acceptedCycle());
      const { scheduler, warn } = createScheduler({
        runNarrativeMaintenanceCycle,
      });

      scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    },
  );

  it("bounds retries for valid JSON with an invalid cycle shape", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue("{}");
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).toLowerCase().includes("retry exhausted"),
      ),
    ).toBe(true);
  });

  it("bounds retries for malformed native responses before declaring exhaustion", async () => {
    const runNarrativeMaintenanceCycle = vi.fn().mockResolvedValue("{not-json");
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).toLowerCase().includes("retry exhausted"),
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
  });

  it("bounds retries to three per canonical key and stops after exhaustion", async () => {
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockRejectedValue(new Error("database is locked"));
    const { scheduler, warn } = createScheduler({
      runNarrativeMaintenanceCycle,
    });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    for (let retry = 0; retry < NARRATIVE_MAINTENANCE_MAX_RETRIES; retry += 1) {
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
    }
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).toLowerCase().includes("retry exhausted"),
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(
      NARRATIVE_MAINTENANCE_MAX_RETRIES + 1,
    );
  });

  it.each([
    ["backendがnull", null],
    ["future bindingにmethodがない", {}],
  ])("%s場合はfail-softで停止する", async (_label, backend) => {
    const { scheduler, warn } = createScheduler(backend);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + IDLE_POLL_INTERVAL_MS);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("disposeはin-flight完了後の再scheduleを抑止する", async () => {
    const first = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi.fn().mockReturnValue(first.promise);
    const { scheduler } = createScheduler({ runNarrativeMaintenanceCycle });

    scheduler.request(work("project-1", "backfill", "backfill:v2", "open"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    scheduler.dispose();
    first.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
  });

  it("複数schedulerで同一projectを共有single-flightし、dispose後に解放する", async () => {
    const first = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(acceptedCycle());
    const backend = { runNarrativeMaintenanceCycle };
    const { scheduler: firstScheduler } = createScheduler(backend);
    const { scheduler: secondScheduler } = createScheduler(backend);

    firstScheduler.request(
      work("project-1", "backfill", "backfill:v2", "open"),
    );
    secondScheduler.request(
      work("project-1", "dependency-verify", "verify:epoch-1", "backfill-done"),
    );
    firstScheduler.start();
    secondScheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    firstScheduler.dispose();
    first.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS * 2);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "dependency-verify",
          workKey: "verify:epoch-1",
          semanticEpochId: null,
          reasons: ["backfill-done"],
        },
      ],
      wakeProjectIds: [],
    });
  });

  it("partial claim rechecks a project released before blocked-wait registration", async () => {
    const firstProject = deferred<NarrativeMaintenanceCycleResult>();
    const partialClaim = deferred<NarrativeMaintenanceCycleResult>();
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockReturnValueOnce(firstProject.promise)
      .mockReturnValueOnce(partialClaim.promise)
      .mockResolvedValue(acceptedCycle());
    const backend = { runNarrativeMaintenanceCycle };
    const { scheduler: owner } = createScheduler(backend);
    const { scheduler: partial } = createScheduler(backend);

    owner.request(work("project-1", "backfill", "backfill:v2", "open"));
    owner.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();

    partial.request(
      work("project-1", "dependency-verify", "verify:epoch-1", "verify"),
    );
    partial.request(work("project-2", "backfill", "backfill:v2", "open"));
    partial.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runNarrativeMaintenanceCycle.mock.calls[1]?.[0]).toEqual({
      work: [
        {
          projectId: "project-2",
          runKind: "backfill",
          workKey: "backfill:v2",
          semanticEpochId: null,
          reasons: ["open"],
        },
      ],
      wakeProjectIds: [],
    });

    // Release project-1 before the partial scheduler reaches its finally
    // block.  Its subsequent wait registration must notice that the project
    // is already free and schedule the pending verify work.
    firstProject.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    partialClaim.resolve(acceptedCycle());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);

    expect(runNarrativeMaintenanceCycle).toHaveBeenCalledTimes(3);
    expect(runNarrativeMaintenanceCycle.mock.calls[2]?.[0]).toEqual({
      work: [
        {
          projectId: "project-1",
          runKind: "dependency-verify",
          workKey: "verify:epoch-1",
          semanticEpochId: null,
          reasons: ["verify"],
        },
      ],
      wakeProjectIds: [],
    });
  });
});
