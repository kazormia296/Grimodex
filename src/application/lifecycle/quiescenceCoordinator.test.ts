import { describe, expect, it, vi } from "vitest";
import {
  StrictQuiescenceError,
  flushStrictQuiescence,
  type QuiescenceDependencies,
} from "./quiescenceCoordinator";
import {
  awaitPendingIpcActualTasks,
  enqueueIpc,
  resetIpcQueueForTests,
} from "@/lib/ipcQueue";
import {
  LIFECYCLE_TRACE_OPT_IN_KEY,
  beginLifecycleTransition,
  subscribeLifecycleTrace,
  type LifecycleTraceEvent,
} from "./lifecycleTrace";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function dependencies(
  overrides: Partial<QuiescenceDependencies> = {},
): QuiescenceDependencies {
  return {
    awaitAiExecutions: vi.fn(async () => {}),
    flushAutoSaves: vi.fn(async () => {}),
    flushParticipants: vi.fn(async () => {}),
    flushExternalWriteBacks: vi.fn(async () => {}),
    awaitEditorWrites: vi.fn(async () => {}),
    awaitScopedMutations: vi.fn(async () => {}),
    awaitSceneWrites: vi.fn(async () => {}),
    hasUnresolvedEditorChanges: vi.fn(() => false),
    flushTimelapse: vi.fn(async () => {}),
    awaitIpcActualTasks: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("flushStrictQuiescence", () => {
  it("attempts every stage and reports all failures", async () => {
    const lateNativeFailure = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("late native write failed"))
      .mockResolvedValue(undefined);
    const deps = dependencies({
      flushAutoSaves: vi.fn(async () => {
        throw new Error("disk full");
      }),
      awaitSceneWrites: vi.fn(async () => {
        throw new Error("scene write failed");
      }),
      hasUnresolvedEditorChanges: vi.fn(() => true),
      awaitIpcActualTasks: lateNativeFailure,
    });

    const error = await flushStrictQuiescence(deps).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StrictQuiescenceError);
    expect(
      (error as StrictQuiescenceError).failures.map((f) => f.stage),
    ).toEqual([
      "autosave",
      "scene-writes",
      "unresolved-editor",
      "ipc-actual-tasks",
    ]);
    expect(deps.flushTimelapse).toHaveBeenCalledOnce();
  });

  it("resolves only after every persistence stage succeeds", async () => {
    const deps = dependencies();
    await expect(flushStrictQuiescence(deps)).resolves.toBeUndefined();
  });

  it("waits audited executions before flushing writes they may produce", async () => {
    const order: string[] = [];
    const deps = dependencies({
      awaitAiExecutions: vi.fn(async () => {
        order.push("ai-executions");
      }),
      flushAutoSaves: vi.fn(async () => {
        order.push("autosave");
      }),
      flushParticipants: vi.fn(async () => {
        order.push("participants");
      }),
    });

    await flushStrictQuiescence(deps);

    expect(order).toEqual(["ai-executions", "autosave", "participants"]);
  });

  it("converges persistence producers through IPC, Timelapse, then IPC", async () => {
    const order: string[] = [];
    const deps = dependencies({
      flushTimelapse: vi.fn(async () => {
        order.push("timelapse");
      }),
      awaitIpcActualTasks: vi.fn(async () => {
        order.push("ipc-actual-tasks");
      }),
    });

    await flushStrictQuiescence(deps);

    expect(order).toEqual([
      "ipc-actual-tasks",
      "timelapse",
      "ipc-actual-tasks",
    ]);
  });

  it("activates the lease transition before flushing persistence", async () => {
    Object.assign(globalThis, {
      [LIFECYCLE_TRACE_OPT_IN_KEY]: true,
    });
    const order: string[] = [];
    const events: LifecycleTraceEvent[] = [];
    const unsubscribe = subscribeLifecycleTrace((event) => {
      events.push(event);
      order.push(event.phase);
    });
    const transition = beginLifecycleTransition({
      kind: "project",
      from: {
        workspacePath: "/novel",
        workspaceOpenRevision: 1,
        projectId: "project-a",
      },
      to: {
        workspacePath: "/novel",
        workspaceOpenRevision: 1,
        projectId: "project-b",
      },
    });
    let ipcDrain = 0;
    const deps = dependencies({
      flushAutoSaves: vi.fn(async () => {
        order.push("autosave-complete");
      }),
      awaitIpcActualTasks: vi.fn(async () => {
        ipcDrain += 1;
        order.push(`ipc-${ipcDrain}-complete`);
      }),
      flushTimelapse: vi.fn(async () => {
        order.push("timelapse-complete");
      }),
    });

    try {
      await flushStrictQuiescence(deps, { transition });

      expect(events.map((event) => event.phase)).toEqual([
        "switch-requested",
        "quiescence-started",
      ]);
      expect(order.indexOf("quiescence-started")).toBeLessThan(
        order.indexOf("autosave-complete"),
      );
      expect(order).toContain("ipc-1-complete");
      expect(order).toContain("timelapse-complete");
      expect(order).toContain("ipc-2-complete");
    } finally {
      unsubscribe();
      Reflect.deleteProperty(globalThis, LIFECYCLE_TRACE_OPT_IN_KEY);
    }
  });

  it("flushes an event produced by a delayed IPC caller before resolving", async () => {
    resetIpcQueueForTests();
    const nativeMutation = deferred<void>();
    const bufferedEvents: string[] = [];
    const flushedEvents: string[] = [];
    let mutationStarted = false;
    const order: string[] = [];

    const caller = enqueueIpc(
      "late-event-producing-mutation",
      async () => {
        mutationStarted = true;
        await nativeMutation.promise;
      },
      null,
      "mutation",
    ).then(() => {
      bufferedEvents.push("late-event");
    });

    const deps = dependencies({
      awaitIpcActualTasks: vi.fn(async () => {
        order.push("ipc-actual-tasks");
        await awaitPendingIpcActualTasks();
      }),
      flushTimelapse: vi.fn(async () => {
        order.push("timelapse");
        flushedEvents.push(...bufferedEvents.splice(0));
      }),
    });

    try {
      const flush = flushStrictQuiescence(deps);
      await vi.waitFor(() => expect(mutationStarted).toBe(true));
      nativeMutation.resolve();

      await flush;
      await caller;

      expect(order).toEqual([
        "ipc-actual-tasks",
        "timelapse",
        "ipc-actual-tasks",
      ]);
      expect(flushedEvents).toEqual(["late-event"]);
      expect(bufferedEvents).toEqual([]);
    } finally {
      resetIpcQueueForTests();
    }
  });
});
