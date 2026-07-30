import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectLifecycleRegistry,
  type ProjectLifecycleParticipant,
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

  it("rejects duplicate participant ids before any work starts", () => {
    expect(() =>
      createProjectLifecycleRegistry([
        { id: "duplicate" },
        { id: "duplicate" },
      ]),
    ).toThrow("Duplicate project lifecycle participant: duplicate");
  });
});
