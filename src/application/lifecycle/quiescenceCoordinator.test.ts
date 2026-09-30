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
  createQuiescenceProviderId,
  QuiescenceProviderStageError,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
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
  it("preserves the exact message for one ordinary Error failure", () => {
    const failure = new Error("single persistence failure");
    const error = new StrictQuiescenceError([
      {
        stage: "autosave",
        error: failure,
        originalError: failure,
      },
    ]);

    expect(error.message).toBe("single persistence failure");
  });

  it("falls back to the generic message for empty, throwing, proxy, and non-Error values", () => {
    const throwingMessage = new Error();
    Object.defineProperty(throwingMessage, "message", {
      configurable: true,
      get() {
        throw new Error("message getter must not escape");
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const cases: unknown[] = [
      new Error(),
      throwingMessage,
      revoked.proxy,
      "not an Error",
    ];

    for (const originalError of cases) {
      const error = new StrictQuiescenceError([
        {
          stage: "autosave",
          error: originalError,
          originalError,
        },
      ]);
      expect(error.message).toBe("Document lifecycle did not reach quiescence");
    }
  });

  it("uses the generic message when multiple failures are present", () => {
    const first = new Error("first");
    const second = new Error("second");
    const error = new StrictQuiescenceError([
      { stage: "autosave", error: first, originalError: first },
      { stage: "timelapse", error: second, originalError: second },
    ]);

    expect(error.message).toBe("Document lifecycle did not reach quiescence");
  });

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

  it("retains provider identities and original reasons while later stages still run", async () => {
    const first = new Error("first provider failed");
    const second = { kind: "non-error rejection" };
    const deps = dependencies({
      awaitScopedMutations: vi.fn(async () => {
        throw new QuiescenceProviderStageError([
          {
            stage: "scoped-mutations",
            providerId: createQuiescenceProviderId("coordinator-first"),
            originalError: first,
          },
          {
            stage: "scoped-mutations",
            providerId: createQuiescenceProviderId("coordinator-second"),
            originalError: second,
          },
        ]);
      }),
    });

    const caught = await flushStrictQuiescence(deps).catch(
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(StrictQuiescenceError);
    const error = caught as StrictQuiescenceError;
    expect(error.providerFailures).toEqual([
      {
        stage: "scoped-mutations",
        providerId: "coordinator-first",
        originalError: first,
      },
      {
        stage: "scoped-mutations",
        providerId: "coordinator-second",
        originalError: second,
      },
    ]);
    expect(error.failures.map((failure) => failure.originalError)).toEqual([
      first,
      second,
    ]);
    expect(deps.awaitSceneWrites).toHaveBeenCalledOnce();
    expect(deps.flushTimelapse).toHaveBeenCalledOnce();
    expect(deps.awaitIpcActualTasks).toHaveBeenCalledTimes(2);
  });

  it("retains a revoked rejection and continues every later stage", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const deps = dependencies({
      awaitScopedMutations: vi.fn(async () => {
        throw revoked.proxy;
      }),
    });

    const caught = await flushStrictQuiescence(deps).catch(
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(StrictQuiescenceError);
    const error = caught as StrictQuiescenceError;
    expect(error.failures).toHaveLength(1);
    expect(error.failures[0]?.error).toBe(revoked.proxy);
    expect(error.failures[0]?.originalError).toBe(revoked.proxy);
    expect(deps.awaitSceneWrites).toHaveBeenCalledOnce();
    expect(deps.flushTimelapse).toHaveBeenCalledOnce();
    expect(deps.awaitIpcActualTasks).toHaveBeenCalledTimes(2);
  });

  it("resolves only after every persistence stage succeeds", async () => {
    const deps = dependencies();
    await expect(flushStrictQuiescence(deps)).resolves.toBeUndefined();
  });

  it("passes a preexisting permit to scoped provider drains", async () => {
    let received: { preexistingDraft?: boolean } | undefined;
    const unregister = registerQuiescenceProvider({
      id: createQuiescenceProviderId("coordinator-preexisting-draft"),
      stage: "scoped-mutations",
      flush: async (options) => {
        received = options;
      },
    });

    try {
      await flushStrictQuiescence();
    } finally {
      unregister();
    }

    expect(received).toEqual({ preexistingDraft: true });
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
