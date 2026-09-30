import { describe, expect, it, vi } from "vitest";
import type { ChronicleCommandPorts } from "./chronicleCommands";
import {
  clearChronicleDate,
  createChronicleEvent,
  deleteChronicleItem,
  patchChronicleItem,
} from "./chronicleCommands";

function ports(): ChronicleCommandPorts {
  return {
    event: {
      create: vi.fn().mockResolvedValue({ id: "e1", title: "event" }),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue({ version: 0 }),
      addRelation: vi.fn().mockResolvedValue(undefined),
      removeRelation: vi.fn().mockResolvedValue(undefined),
      setParticipants: vi.fn().mockResolvedValue(undefined),
      linkScene: vi.fn().mockResolvedValue(undefined),
      unlinkScene: vi.fn().mockResolvedValue(undefined),
    },
    scene: {
      updateTitle: vi.fn().mockResolvedValue(undefined),
      updateSynopsis: vi.fn().mockResolvedValue(undefined),
      updatePov: vi.fn().mockResolvedValue(undefined),
      updateLocation: vi.fn().mockResolvedValue(undefined),
      updateDate: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("chronicle commands", () => {
  it("routes scene patches to scene fields and the date patch", async () => {
    const commandPorts = ports();
    await patchChronicleItem(
      { kind: "scene", id: "scene-1" },
      {
        title: "new title",
        note: "synopsis",
        primaryCodexId: "codex-1",
        locationCodexId: "loc-1",
        startTime: 10,
        startGranularity: "day",
        precision: "approx",
      },
      commandPorts,
    );

    expect(commandPorts.scene.updateTitle).toHaveBeenCalledWith(
      "scene-1",
      "new title",
    );
    expect(commandPorts.scene.updateSynopsis).toHaveBeenCalledWith(
      "scene-1",
      "synopsis",
    );
    expect(commandPorts.scene.updatePov).toHaveBeenCalledWith(
      "scene-1",
      "codex-1",
    );
    expect(commandPorts.scene.updateLocation).toHaveBeenCalledWith(
      "scene-1",
      "loc-1",
    );
    expect(commandPorts.scene.updateDate).toHaveBeenCalledWith("scene-1", {
      chronicleStartTime: 10,
      chronicleStartGranularity: "day",
      chroniclePrecision: "approx",
    });
    expect(commandPorts.event.update).not.toHaveBeenCalled();
  });

  it("keeps real event patches on the tracked event port", async () => {
    const commandPorts = ports();
    await patchChronicleItem(
      { kind: "event", id: "event-1" },
      { title: "new title", startTime: 20 },
      commandPorts,
    );
    expect(commandPorts.event.update).toHaveBeenCalledWith({
      eventId: "event-1",
      title: "new title",
      startTime: 20,
    });
    expect(commandPorts.scene.updateDate).not.toHaveBeenCalled();
  });

  it("passes the version loaded by the editing surface to an event patch", async () => {
    const commandPorts = ports();

    await patchChronicleItem(
      { kind: "event", id: "event-1" },
      { detail: "new detail" },
      commandPorts,
      { baseVersion: 7 },
    );

    expect(commandPorts.event.update).toHaveBeenCalledWith({
      eventId: "event-1",
      detail: "new detail",
      baseVersion: 7,
    });
  });

  it("carries the preexisting-draft permit only for an explicit real-event save", async () => {
    const commandPorts = ports();

    await patchChronicleItem(
      { kind: "event", id: "event-1" },
      { detail: "queued detail" },
      commandPorts,
      { baseVersion: 7, preexistingDraft: true },
    );

    expect(commandPorts.event.update).toHaveBeenCalledWith(
      {
        eventId: "event-1",
        detail: "queued detail",
        baseVersion: 7,
      },
      { preexistingDraft: true },
    );
  });

  it("carries the preexisting-draft permit through a scene synopsis save", async () => {
    const commandPorts = ports();

    await patchChronicleItem(
      { kind: "scene", id: "scene-1" },
      { note: "queued synopsis" },
      commandPorts,
      { preexistingDraft: true },
    );

    expect(commandPorts.scene.updateSynopsis).toHaveBeenCalledWith(
      "scene-1",
      "queued synopsis",
      { preexistingDraft: true },
    );
    expect(commandPorts.event.update).not.toHaveBeenCalled();
  });

  it("clears scene dates instead of deleting the scene", async () => {
    const commandPorts = ports();
    await deleteChronicleItem({ kind: "scene", id: "scene-1" }, commandPorts);
    expect(commandPorts.event.delete).not.toHaveBeenCalled();
    expect(commandPorts.scene.updateDate).toHaveBeenCalledWith("scene-1", {
      chronicleStartTime: null,
      chronicleStartMinute: null,
      chronicleStartGranularity: "none",
      chronicleEndTime: null,
      chronicleEndMinute: null,
      chronicleEndGranularity: "none",
    });
  });

  it("preserves create result and routes real event deletion", async () => {
    const commandPorts = ports();
    await expect(
      createChronicleEvent({ title: "created" }, commandPorts),
    ).resolves.toEqual({ id: "e1", title: "event" });
    await deleteChronicleItem({ kind: "event", id: "event-1" }, commandPorts);
    expect(commandPorts.event.delete).toHaveBeenCalledWith("event-1");
  });

  it("passes the selected Event version to deletion", async () => {
    const commandPorts = ports();
    await deleteChronicleItem({ kind: "event", id: "event-1" }, commandPorts, {
      baseVersion: 9,
    });
    expect(commandPorts.event.delete).toHaveBeenCalledWith("event-1", {
      baseVersion: 9,
    });
  });

  it("uses the same empty date patch for explicit clear operations", async () => {
    const commandPorts = ports();
    await clearChronicleDate("scene-2", commandPorts);
    expect(commandPorts.scene.updateDate).toHaveBeenCalledWith("scene-2", {
      chronicleStartTime: null,
      chronicleStartMinute: null,
      chronicleStartGranularity: "none",
      chronicleEndTime: null,
      chronicleEndMinute: null,
      chronicleEndGranularity: "none",
    });
  });
});
