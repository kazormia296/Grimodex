import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectLifecycleRegistry,
  type ProjectLifecycleParticipant,
  type ProjectLifecycleTimingEvent,
} from "./ProjectLifecycleRegistry";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
  canScheduleQuiescenceMutation,
} from "@/application/lifecycle/quiescenceLease";

describe("ProjectLifecycleRegistry", () => {
  afterEach(() => {
    _resetQuiescenceLeasesForTests();
  });

  it("resets once and completes critical hydration before optional work", async () => {
    const events: string[] = [];
    const participants: ProjectLifecycleParticipant[] = [
      {
        id: "first",
        reset: () => {
          events.push("first.reset");
        },
        prepareCritical: async () => {
          events.push("first.prepare.start");
          await Promise.resolve();
          events.push("first.prepare.end");
          return () => {
            events.push("first.commit");
          };
        },
      },
      {
        id: "second",
        reset: () => {
          events.push("second.reset");
        },
        hydrateOptional: () => {
          events.push("second.optional");
        },
      },
      {
        id: "activation",
        activate: () => {
          events.push("activation");
        },
      },
    ];

    await createProjectLifecycleRegistry(participants).reload(
      {
        projectId: "project-a",
      },
      {
        afterCommit: () => events.push("afterCommit"),
      },
    );

    expect(events).toEqual([
      "first.prepare.start",
      "first.prepare.end",
      "first.reset",
      "second.reset",
      "first.commit",
      "afterCommit",
      "second.optional",
      "activation",
    ]);
  });

  it("leaves existing state untouched when critical preparation fails", async () => {
    const reset = vi.fn();
    const commit = vi.fn();
    const beforeCommit = vi.fn();
    const registry = createProjectLifecycleRegistry([
      {
        id: "state",
        reset,
        prepareCritical: async () => {
          throw new Error("tree unavailable");
        },
        commitCritical: commit,
      },
    ]);

    await expect(
      registry.reload(
        { projectId: "project-b" },
        {
          beforeCommit,
        },
      ),
    ).rejects.toThrow("tree unavailable");
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("authorizes the synchronous authority commit inside a lifecycle lease", async () => {
    const lease = acquireQuiescenceLease("project-load");
    const schedulingStates: boolean[] = [];
    const registry = createProjectLifecycleRegistry([
      {
        id: "chat-reset",
        reset: () => {
          schedulingStates.push(canScheduleQuiescenceMutation());
        },
        commitCritical: () => {
          schedulingStates.push(canScheduleQuiescenceMutation());
        },
      },
    ]);

    expect(canScheduleQuiescenceMutation()).toBe(false);
    await registry.reload({ projectId: "project-b" });
    expect(schedulingStates).toEqual([true, true]);
    expect(canScheduleQuiescenceMutation()).toBe(false);
    lease.release();
  });

  it("keeps optional hydration best effort and reports failures", async () => {
    const failure = new Error("optional failed");
    const onOptionalFailure = vi.fn();
    const loaded: string[] = [];
    const participants: ProjectLifecycleParticipant[] = [
      {
        id: "failed",
        hydrateOptional: async () => {
          throw failure;
        },
      },
      {
        id: "loaded",
        hydrateOptional: () => {
          loaded.push("loaded");
        },
      },
    ];

    const result = await createProjectLifecycleRegistry(participants, {
      onOptionalFailure,
    }).reload({ projectId: "project-b" });

    expect(loaded).toEqual(["loaded"]);
    expect(onOptionalFailure).toHaveBeenCalledWith(participants[0], failure);
    expect(result.degraded).toEqual([
      { participantId: "failed", error: failure },
    ]);
  });

  it("reports closed timing spans for successful and failed participant work", async () => {
    let clock = 0;
    const events: ProjectLifecycleTimingEvent[] = [];
    const optionalFailure = new Error("optional unavailable");
    const activationFailure = new Error("activation unavailable");
    const result = await createProjectLifecycleRegistry([
      {
        id: "prepared-state",
        prepareCritical: async () => undefined,
      },
      {
        id: "critical-state",
        hydrateCritical: async () => undefined,
      },
      {
        id: "optional-state",
        hydrateOptional: async () => {
          throw optionalFailure;
        },
      },
      {
        id: "activation-state",
        activate: async () => {
          throw activationFailure;
        },
      },
    ]).reload(
      { projectId: "project-timed" },
      {
        lifecycleTiming: {
          now: () => {
            clock += 5;
            return clock;
          },
          onEvent: (event) => events.push(event),
        },
      },
    );

    expect(events).toEqual([
      {
        phase: "prepareCritical",
        status: "start",
        participantId: "prepared-state",
        at: 5,
      },
      {
        phase: "prepareCritical",
        status: "finish",
        participantId: "prepared-state",
        at: 10,
        durationMs: 5,
      },
      {
        phase: "hydrateCritical",
        status: "start",
        participantId: "critical-state",
        at: 15,
      },
      {
        phase: "hydrateCritical",
        status: "finish",
        participantId: "critical-state",
        at: 20,
        durationMs: 5,
      },
      {
        phase: "hydrateOptional",
        status: "start",
        participantId: "optional-state",
        at: 25,
      },
      {
        phase: "hydrateOptional",
        status: "fail",
        participantId: "optional-state",
        at: 30,
        durationMs: 5,
      },
      {
        phase: "activate",
        status: "start",
        participantId: "activation-state",
        at: 35,
      },
      {
        phase: "activate",
        status: "fail",
        participantId: "activation-state",
        at: 40,
        durationMs: 5,
      },
    ]);
    expect(result.degraded).toEqual([
      { participantId: "optional-state", error: optionalFailure },
      { participantId: "activation-state", error: activationFailure },
    ]);
    expect(events.every((event) => !("error" in event))).toBe(true);
  });

  it("closes a failed preparation span before preserving the rejection", async () => {
    const events: ProjectLifecycleTimingEvent[] = [];
    const failure = new Error("preparation unavailable");

    await expect(
      createProjectLifecycleRegistry([
        {
          id: "prepared-state",
          prepareCritical: async () => {
            throw failure;
          },
        },
      ]).reload(
        { projectId: "project-timed" },
        {
          lifecycleTiming: {
            now: vi.fn().mockReturnValueOnce(11).mockReturnValueOnce(17),
            onEvent: (event) => events.push(event),
          },
        },
      ),
    ).rejects.toBe(failure);

    expect(events).toEqual([
      {
        phase: "prepareCritical",
        status: "start",
        participantId: "prepared-state",
        at: 11,
      },
      {
        phase: "prepareCritical",
        status: "fail",
        participantId: "prepared-state",
        at: 17,
        durationMs: 6,
      },
    ]);
  });

  it("keeps optional batch concurrency and phase ordering with timing enabled", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let releaseThird!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const third = new Promise<void>((resolve) => {
      releaseThird = resolve;
    });
    const reload = createProjectLifecycleRegistry(
      [
        {
          id: "first",
          hydrateOptional: () => {
            events.push("first.run");
            return first;
          },
        },
        {
          id: "second",
          hydrateOptional: () => {
            events.push("second.run");
            return second;
          },
        },
        {
          id: "third",
          hydrateOptional: () => {
            events.push("third.run");
            return third;
          },
        },
        {
          id: "activation",
          activate: () => {
            events.push("activation.run");
          },
        },
      ],
      { optionalConcurrency: 2 },
    ).reload(
      { projectId: "project-batched" },
      {
        lifecycleTiming: {
          now: () => 0,
          onEvent: (event) =>
            events.push(`${event.participantId}.${event.status}`),
        },
      },
    );

    expect(events).toEqual([
      "first.start",
      "first.run",
      "second.start",
      "second.run",
    ]);

    releaseSecond();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).not.toContain("third.run");

    releaseFirst();
    await vi.waitFor(() => expect(events).toContain("third.run"));
    expect(events.slice(0, 8)).toEqual([
      "first.start",
      "first.run",
      "second.start",
      "second.run",
      "second.finish",
      "first.finish",
      "third.start",
      "third.run",
    ]);

    releaseThird();
    await reload;
    expect(events.slice(-3)).toEqual([
      "activation.start",
      "activation.run",
      "activation.finish",
    ]);
  });

  it("does not let timing observer failures affect lifecycle work", async () => {
    const hydrate = vi.fn();
    const result = await createProjectLifecycleRegistry([
      {
        id: "critical-state",
        hydrateCritical: hydrate,
      },
    ]).reload(
      { projectId: "project-observer-failure" },
      {
        lifecycleTiming: {
          now: () => {
            throw new Error("clock failed");
          },
          onEvent: () => {
            throw new Error("observer failed");
          },
        },
      },
    );

    expect(hydrate).toHaveBeenCalledOnce();
    expect(result).toEqual({ cancelled: false, degraded: [] });
  });

  it("rejects duplicate participant ids before any work starts", () => {
    expect(() =>
      createProjectLifecycleRegistry([
        { id: "duplicate" },
        { id: "duplicate" },
      ]),
    ).toThrow("Duplicate project lifecycle participant: duplicate");
  });
});
