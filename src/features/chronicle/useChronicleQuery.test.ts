// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRelationRow, EventRow, ParticipantRow } from "./api";
import type { ChronicleScope } from "./chronicleScope";

const apiMocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
  listSceneEvents: vi.fn(),
  listEventRelations: vi.fn(),
  listEventParticipantsForProject: vi.fn(),
}));
vi.mock("./api", () => apiMocks);

import { useChronicleQuery } from "./useChronicleQuery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function scope(
  workspacePath: string,
  openRevision: number,
  projectId = "project",
): ChronicleScope {
  return { workspacePath, openRevision, projectId };
}

function event(id: string, projectId = "project"): EventRow {
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

function relation(id: string): EventRelationRow {
  return {
    causeId: id,
    effectId: "other",
  };
}

function participant(eventId: string): ParticipantRow {
  return {
    eventId,
    codexEntryId: "codex",
    role: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listEvents.mockResolvedValue([]);
  apiMocks.listSceneEvents.mockResolvedValue([]);
  apiMocks.listEventRelations.mockResolvedValue([]);
  apiMocks.listEventParticipantsForProject.mockResolvedValue([]);
});

describe("useChronicleQuery", () => {
  it("synchronously discards workspace A when workspace B has the same project id", async () => {
    const bEvents = deferred<EventRow[]>();
    apiMocks.listEvents
      .mockResolvedValueOnce([event("workspace-a")])
      .mockImplementationOnce(() => bEvents.promise);

    let currentScope = scope("/workspace/a", 1);
    const { result, rerender } = renderHook(() =>
      useChronicleQuery({
        scope: currentScope,
        enabled: true,
        reloadKey: 0,
        revisionCounter: 0,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.events[0]?.id).toBe("workspace-a");

    currentScope = scope("/workspace/b", 2);
    rerender();

    expect(result.current.events).toEqual([]);
    expect(result.current.snapshotScopeKey).toBeNull();
    expect(result.current.isSnapshotFresh).toBe(false);
    expect(result.current.status).toBe("loading");

    bEvents.resolve([event("workspace-b")]);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.events[0]?.id).toBe("workspace-b");
  });

  it("treats a same-path reopen as a new scope and ignores the old late generation", async () => {
    const oldEvents = deferred<EventRow[]>();
    apiMocks.listEvents
      .mockImplementationOnce(() => oldEvents.promise)
      .mockResolvedValueOnce([event("revision-2")]);

    let currentScope = scope("/workspace/a", 1);
    const { result, rerender } = renderHook(() =>
      useChronicleQuery({
        scope: currentScope,
        enabled: true,
        reloadKey: 0,
        revisionCounter: 0,
      }),
    );
    await waitFor(() => expect(apiMocks.listEvents).toHaveBeenCalledTimes(1));

    currentScope = scope("/workspace/a", 2);
    rerender();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.events[0]?.id).toBe("revision-2");

    oldEvents.resolve([event("revision-1-late")]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.events[0]?.id).toBe("revision-2");
  });

  it("publishes all four collections atomically and announces only a complete snapshot", async () => {
    const links = deferred<[]>();
    const onEventsLoaded = vi.fn();
    const onScopeLoaded = vi.fn();
    apiMocks.listEvents.mockResolvedValue([event("new")]);
    apiMocks.listSceneEvents.mockImplementation(() => links.promise);
    apiMocks.listEventRelations.mockResolvedValue([relation("relation")]);
    apiMocks.listEventParticipantsForProject.mockResolvedValue([
      participant("new"),
    ]);

    const { result } = renderHook(() =>
      useChronicleQuery({
        scope: scope("/workspace", 1),
        enabled: true,
        reloadKey: 0,
        revisionCounter: 0,
        onEventsLoaded,
        onScopeLoaded,
      }),
    );

    await waitFor(() => expect(apiMocks.listSceneEvents).toHaveBeenCalled());
    expect(result.current.events).toEqual([]);
    expect(result.current.relations).toEqual([]);
    expect(result.current.participants).toEqual([]);
    expect(onEventsLoaded).not.toHaveBeenCalled();
    expect(onScopeLoaded).not.toHaveBeenCalled();

    links.resolve([]);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.events[0]?.id).toBe("new");
    expect(result.current.relations[0]?.causeId).toBe("relation");
    expect(result.current.participants[0]?.eventId).toBe("new");
    expect(onEventsLoaded).toHaveBeenCalledWith([event("new")]);
    expect(onScopeLoaded).toHaveBeenCalledWith(1);
  });

  it("retains same-scope lastGood and reports a secondary-read refresh error", async () => {
    const onEventsLoaded = vi.fn();
    apiMocks.listEvents
      .mockResolvedValueOnce([event("last-good")])
      .mockResolvedValueOnce([event("partial-new")]);
    apiMocks.listEventRelations
      .mockResolvedValueOnce([relation("old-relation")])
      .mockRejectedValueOnce(new Error("relations failed"));

    let revisionCounter = 0;
    const { result, rerender } = renderHook(() =>
      useChronicleQuery({
        scope: scope("/workspace", 1),
        enabled: true,
        reloadKey: 0,
        revisionCounter,
        onEventsLoaded,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(onEventsLoaded).toHaveBeenCalledTimes(1);

    revisionCounter = 1;
    rerender();
    expect(result.current.status).toBe("refreshing");
    expect(result.current.events[0]?.id).toBe("last-good");
    expect(result.current.isSnapshotFresh).toBe(false);

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("relations failed");
    expect(result.current.events[0]?.id).toBe("last-good");
    expect(result.current.relations[0]?.causeId).toBe("old-relation");
    expect(result.current.snapshotScopeKey).not.toBeNull();
    expect(result.current.isSnapshotFresh).toBe(false);
    expect(onEventsLoaded).toHaveBeenCalledTimes(1);
  });

  it("reports a first-load secondary failure as an error rather than an empty success", async () => {
    apiMocks.listEvents.mockResolvedValue([event("not-published")]);
    apiMocks.listEventParticipantsForProject.mockRejectedValue(
      new Error("participants failed"),
    );

    const { result } = renderHook(() =>
      useChronicleQuery({
        scope: scope("/workspace", 1),
        enabled: true,
        reloadKey: 0,
        revisionCounter: 0,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.events).toEqual([]);
    expect(result.current.snapshotScopeKey).toBeNull();
    expect(result.current.error?.message).toBe("participants failed");
  });

  it("defers hidden loads, coalesces hidden invalidations, and loads once when enabled", async () => {
    let enabled = false;
    let revisionCounter = 0;
    const currentScope = scope("/workspace", 1);
    apiMocks.listEvents.mockResolvedValue([event("latest")]);

    const { result, rerender } = renderHook(() =>
      useChronicleQuery({
        scope: currentScope,
        enabled,
        reloadKey: 0,
        revisionCounter,
      }),
    );
    expect(result.current.status).toBe("idle");
    expect(apiMocks.listEvents).not.toHaveBeenCalled();

    revisionCounter = 1;
    rerender();
    revisionCounter = 2;
    rerender();
    expect(apiMocks.listEvents).not.toHaveBeenCalled();
    const latestHiddenGeneration = result.current.requestGeneration;

    enabled = true;
    rerender();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(apiMocks.listEvents).toHaveBeenCalledTimes(1);
    expect(result.current.events[0]?.id).toBe("latest");
    expect(result.current.requestGeneration).toBe(latestHiddenGeneration);
  });

  it("does not reload a fresh snapshot after a hide/show without invalidation", async () => {
    let enabled = true;
    const { result, rerender } = renderHook(() =>
      useChronicleQuery({
        scope: scope("/workspace", 1),
        enabled,
        reloadKey: 0,
        revisionCounter: 0,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    enabled = false;
    rerender();
    expect(result.current.status).toBe("idle");
    enabled = true;
    rerender();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(apiMocks.listEvents).toHaveBeenCalledTimes(1);
  });

  it("retries the current generation explicitly and replaces lastGood on success", async () => {
    apiMocks.listEvents
      .mockResolvedValueOnce([event("last-good")])
      .mockRejectedValueOnce(new Error("reload failed"))
      .mockResolvedValueOnce([event("recovered")]);

    let revisionCounter = 0;
    const { result, rerender } = renderHook(() =>
      useChronicleQuery({
        scope: scope("/workspace", 1),
        enabled: true,
        reloadKey: 0,
        revisionCounter,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    revisionCounter = 1;
    rerender();
    await waitFor(() => expect(result.current.status).toBe("error"));
    const failedGeneration = result.current.requestGeneration;

    act(() => result.current.retry());
    expect(result.current.requestGeneration).not.toBe(failedGeneration);
    expect(result.current.events[0]?.id).toBe("last-good");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.events[0]?.id).toBe("recovered");
    expect(result.current.error).toBeNull();
    expect(result.current.isSnapshotFresh).toBe(true);
  });

  it("announces scope changes and the first complete load once per exact scope", async () => {
    const onScopeChanged = vi.fn();
    const onScopeLoaded = vi.fn();
    let reloadKey = 0;
    let currentScope = scope("/workspace/a", 1);
    const { rerender } = renderHook(() =>
      useChronicleQuery({
        scope: currentScope,
        enabled: true,
        reloadKey,
        revisionCounter: 0,
        onScopeChanged,
        onScopeLoaded,
      }),
    );
    await waitFor(() => expect(onScopeLoaded).toHaveBeenCalledTimes(1));

    reloadKey = 1;
    rerender();
    await waitFor(() => expect(apiMocks.listEvents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onScopeLoaded).toHaveBeenCalledTimes(1));
    expect(onScopeChanged).toHaveBeenCalledTimes(1);

    currentScope = scope("/workspace/b", 2);
    rerender();
    await waitFor(() => expect(onScopeLoaded).toHaveBeenCalledTimes(2));
    expect(onScopeChanged).toHaveBeenCalledTimes(2);
    expect(onScopeChanged).toHaveBeenLastCalledWith(currentScope);
  });
});
