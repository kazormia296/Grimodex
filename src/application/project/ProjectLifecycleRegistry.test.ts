import { describe, expect, it, vi } from "vitest";
import {
  createProjectLifecycleRegistry,
  type ProjectLifecycleParticipant,
} from "./ProjectLifecycleRegistry";

describe("ProjectLifecycleRegistry", () => {
  it("resets once and completes critical hydration before optional work", async () => {
    const events: string[] = [];
    const participants: ProjectLifecycleParticipant[] = [
      {
        id: "first",
        reset: () => {
          events.push("first.reset");
        },
        hydrateCritical: async () => {
          events.push("first.critical.start");
          await Promise.resolve();
          events.push("first.critical.end");
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

    await createProjectLifecycleRegistry(participants).reload({
      projectId: "project-a",
    });

    expect(events).toEqual([
      "first.reset",
      "second.reset",
      "first.critical.start",
      "first.critical.end",
      "second.optional",
      "activation",
    ]);
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

    await createProjectLifecycleRegistry(participants, {
      onOptionalFailure,
    }).reload({ projectId: "project-b" });

    expect(loaded).toEqual(["loaded"]);
    expect(onOptionalFailure).toHaveBeenCalledWith(participants[0], failure);
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
