// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "./api";

const apiMocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
  listSceneEvents: vi.fn(),
  listEventRelations: vi.fn(),
  listEventParticipantsForProject: vi.fn(),
}));
vi.mock("./api", () => apiMocks);

import { useChronicleQuery } from "./useChronicleQuery";

function event(id: string, projectId: string): EventRow {
  return {
    id,
    projectId,
    title: id,
    note: null,
    detail: null,
    ordinal: "a0",
    primaryCodexId: null,
    locationCodexId: null,
    startTime: null,
    endTime: null,
    startMinute: null,
    endMinute: null,
    startGranularity: "none",
    endGranularity: "none",
    precision: "exact",
    kind: "generic",
    secret: false,
    revealSceneId: null,
    laneGroup: null,
    version: 0,
    createdAt: "now",
    updatedAt: "now",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listSceneEvents.mockResolvedValue([]);
  apiMocks.listEventRelations.mockResolvedValue([]);
  apiMocks.listEventParticipantsForProject.mockResolvedValue([]);
});

describe("useChronicleQuery", () => {
  it("project 切替の未読込中は前 project の snapshot を返さない", async () => {
    let resolveB: (rows: EventRow[]) => void = () => {};
    apiMocks.listEvents.mockImplementation((projectId: string) => {
      if (projectId === "a") {
        return Promise.resolve([event("a-event", "a")]);
      }
      return new Promise<EventRow[]>((resolve) => {
        resolveB = resolve;
      });
    });

    let projectId: string | null = "a";
    const { result, rerender } = renderHook(() =>
      useChronicleQuery({ projectId, reloadKey: 0, revisionCounter: 0 }),
    );
    await waitFor(() => expect(result.current.events[0]?.id).toBe("a-event"));
    expect(result.current.snapshotProjectId).toBe("a");

    projectId = "b";
    rerender();
    expect(result.current.events).toEqual([]);
    expect(result.current.snapshotProjectId).toBeNull();

    await act(async () => {
      resolveB([event("b-event", "b")]);
    });
    await waitFor(() => expect(result.current.events[0]?.id).toBe("b-event"));
    expect(result.current.snapshotProjectId).toBe("b");
  });

  it("project 切替後の取得失敗は snapshot 到着済みにしない", async () => {
    apiMocks.listEvents.mockImplementation((projectId: string) =>
      projectId === "a"
        ? Promise.resolve([event("a-event", "a")])
        : Promise.reject(new Error("read failed")),
    );

    let projectId: string | null = "a";
    const { result, rerender } = renderHook(() =>
      useChronicleQuery({ projectId, reloadKey: 0, revisionCounter: 0 }),
    );
    await waitFor(() => expect(result.current.snapshotProjectId).toBe("a"));

    projectId = "b";
    rerender();
    await waitFor(() => expect(apiMocks.listEvents).toHaveBeenCalledWith("b"));

    expect(result.current.events).toEqual([]);
    expect(result.current.snapshotProjectId).toBeNull();
  });

  it("同一 project の再取得失敗でも直前の snapshot を準備済みとして残さない", async () => {
    apiMocks.listEvents
      .mockResolvedValueOnce([event("a-event", "a")])
      .mockRejectedValueOnce(new Error("reload failed"));

    let revisionCounter = 0;
    const { result, rerender } = renderHook(() =>
      useChronicleQuery({
        projectId: "a",
        reloadKey: 0,
        revisionCounter,
      }),
    );
    await waitFor(() => expect(result.current.snapshotProjectId).toBe("a"));

    revisionCounter = 1;
    rerender();
    expect(result.current.snapshotProjectId).toBeNull();
    await waitFor(() => expect(apiMocks.listEvents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.events).toEqual([]));
    expect(result.current.snapshotProjectId).toBeNull();
  });

  it("does not let a late project A response overwrite project B", async () => {
    let resolveA: (rows: EventRow[]) => void = () => {};
    let resolveB: (rows: EventRow[]) => void = () => {};
    apiMocks.listEvents.mockImplementation((projectId: string) => {
      if (projectId === "a") {
        return new Promise<EventRow[]>((resolve) => {
          resolveA = resolve;
        });
      }
      return new Promise<EventRow[]>((resolve) => {
        resolveB = resolve;
      });
    });

    let projectId: string | null = "a";
    const { result, rerender } = renderHook(() =>
      useChronicleQuery({ projectId, reloadKey: 0, revisionCounter: 0 }),
    );

    projectId = "b";
    rerender();
    await act(async () => {
      resolveB([event("b-event", "b")]);
    });
    await waitFor(() => expect(result.current.events[0]?.id).toBe("b-event"));

    await act(async () => {
      resolveA([event("a-event", "a")]);
    });
    expect(result.current.events.map((row) => row.id)).toEqual(["b-event"]);
  });

  it("resets once at project boundary and only announces the first load", async () => {
    const onProjectChanged = vi.fn();
    const onProjectLoaded = vi.fn();
    apiMocks.listEvents.mockResolvedValue([event("e1", "p1")]);

    const { rerender } = renderHook(
      ({
        reloadKey,
        revisionCounter,
      }: {
        reloadKey: number;
        revisionCounter: number;
      }) =>
        useChronicleQuery({
          projectId: "p1",
          reloadKey,
          revisionCounter,
          onProjectChanged,
          onProjectLoaded,
        }),
      { initialProps: { reloadKey: 0, revisionCounter: 0 } },
    );

    await waitFor(() => expect(onProjectLoaded).toHaveBeenCalledWith(1));
    rerender({ reloadKey: 1, revisionCounter: 0 });
    await waitFor(() => expect(apiMocks.listEvents).toHaveBeenCalledTimes(2));
    expect(onProjectChanged).toHaveBeenCalledTimes(1);
    expect(onProjectLoaded).toHaveBeenCalledTimes(1);
  });
});
