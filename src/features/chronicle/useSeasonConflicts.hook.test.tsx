// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeDocumentKey } from "@/features/editor/document/documentKey";
import {
  clearExternalDocumentReloadRegistry,
  publishExternalDocumentReload,
} from "@/lib/externalDocumentReloadRegistry";
import {
  _resetSceneBodyCommitRegistryForTests,
  publishSceneBodyCommit,
} from "@/lib/sceneBodyCommitRegistry";
import type { ChronicleCalendar } from "./chronicleTime";
import type { ChronicleScope } from "./chronicleScope";
import { ProjectCalendarVersionConflictError } from "./calendarOcc";

const mocks = vi.hoisted(() => ({
  loadSceneContents: vi.fn(),
  getProjectCalendar: vi.fn(),
  upsertProjectCalendar: vi.fn(),
}));

vi.mock("@/features/tree/api", () => ({
  loadSceneContents: mocks.loadSceneContents,
}));
vi.mock("./api", () => ({
  getProjectCalendar: mocks.getProjectCalendar,
  upsertProjectCalendar: mocks.upsertProjectCalendar,
  calendarFromRow: (row: ChronicleCalendar) => row,
}));

import { useSeasonConflicts } from "./useSeasonConflicts";

const calendar: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [
    { name: "春", startDayOfYear: 0 },
    { name: "夏", startDayOfYear: 90 },
    { name: "秋", startDayOfYear: 180 },
    { name: "冬", startDayOfYear: 270 },
  ],
};

const summerScene = new Map([
  [
    "scene-1",
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "蝉が鳴いていた" }],
        },
      ],
    }),
  ],
]);
const winterScene = new Map([
  [
    "scene-1",
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "雪が降っていた" }],
        },
      ],
    }),
  ],
]);

function scope(
  workspacePath = "/workspace/a",
  openRevision = 1,
  projectId = "project-1",
): ChronicleScope {
  return { workspacePath, openRevision, projectId };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function useConflictHarness(
  currentScope: ChronicleScope | null,
  enabled = true,
) {
  return useSeasonConflicts({
    scope: currentScope,
    enabled,
    events: [
      {
        id: "event-1",
        startTime: 300,
        primaryCodexId: null,
        kind: "generic",
      },
    ],
    links: [{ sceneId: "scene-1", eventId: "event-1" }],
  });
}

async function settleCalendarAndCheck(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearExternalDocumentReloadRegistry();
  _resetSceneBodyCommitRegistryForTests();
  mocks.getProjectCalendar.mockResolvedValue({ ...calendar, version: 4 });
  mocks.upsertProjectCalendar.mockImplementation(
    async (
      data: ChronicleCalendar,
      options: { baseVersion: number | null },
    ) => ({
      ...data,
      version: options.baseVersion === null ? 0 : options.baseVersion + 1,
    }),
  );
  mocks.loadSceneContents.mockResolvedValue(summerScene);
});

afterEach(() => {
  vi.useRealTimers();
  clearExternalDocumentReloadRegistry();
  _resetSceneBodyCommitRegistryForTests();
});

describe("useSeasonConflicts persisted-body invalidation", () => {
  it("passes the loaded Calendar version through consecutive CAS saves", async () => {
    const currentScope = scope();
    const { result } = renderHook(() => useConflictHarness(currentScope));
    await settleCalendarAndCheck();

    await act(async () => {
      await result.current.saveCalendar(calendar);
      await result.current.saveCalendar(calendar);
    });

    expect(mocks.upsertProjectCalendar.mock.calls[0]?.[1]).toEqual({
      baseVersion: 4,
    });
    expect(mocks.upsertProjectCalendar.mock.calls[1]?.[1]).toEqual({
      baseVersion: 5,
    });
    expect(result.current.calendarSaveError).toBeNull();
  });

  it("does not let a stale initial load overwrite a successfully saved version", async () => {
    const initialLoad = deferred<ChronicleCalendar & { version: number }>();
    mocks.getProjectCalendar
      .mockReturnValueOnce(initialLoad.promise)
      .mockResolvedValueOnce({ ...calendar, version: 4 });
    const currentScope = scope();
    const { result } = renderHook(() => useConflictHarness(currentScope));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.saveCalendar({ ...calendar, daysPerYear: 400 });
    });
    await act(async () => {
      initialLoad.resolve({ ...calendar, daysPerYear: 360, version: 4 });
      await initialLoad.promise;
    });
    await act(async () => {
      await result.current.saveCalendar({ ...calendar, daysPerYear: 401 });
    });

    expect(mocks.upsertProjectCalendar.mock.calls[0]?.[1]).toEqual({
      baseVersion: 4,
    });
    expect(mocks.upsertProjectCalendar.mock.calls[1]?.[1]).toEqual({
      baseVersion: 5,
    });
    expect(result.current.calendar?.daysPerYear).toBe(401);
  });

  it("rejects a Calendar OCC conflict, publishes it, and reloads the current scope", async () => {
    const currentScope = scope();
    const { result } = renderHook(() => useConflictHarness(currentScope));
    await settleCalendarAndCheck();

    mocks.upsertProjectCalendar.mockRejectedValueOnce(
      new ProjectCalendarVersionConflictError("project-1"),
    );
    mocks.getProjectCalendar.mockResolvedValueOnce({ ...calendar, version: 9 });

    await act(async () => {
      await expect(
        result.current.saveCalendar(calendar),
      ).rejects.toBeInstanceOf(ProjectCalendarVersionConflictError);
      await Promise.resolve();
    });

    expect(result.current.calendarSaveError).toBeInstanceOf(
      ProjectCalendarVersionConflictError,
    );
    expect(mocks.getProjectCalendar).toHaveBeenCalledTimes(2);
  });

  it("does no calendar or body work while disabled, then performs one current-scope load", async () => {
    let enabled = false;
    const currentScope = scope();
    const { result, rerender } = renderHook(() =>
      useConflictHarness(currentScope, enabled),
    );

    expect(result.current.conflictStatus).toBe("disabled");
    expect(mocks.getProjectCalendar).not.toHaveBeenCalled();
    expect(mocks.loadSceneContents).not.toHaveBeenCalled();

    enabled = true;
    rerender();
    await settleCalendarAndCheck();

    expect(result.current.conflictStatus).toBe("ready");
    expect(mocks.getProjectCalendar).toHaveBeenCalledOnce();
    expect(mocks.loadSceneContents).toHaveBeenCalledOnce();
    expect(result.current.conflicts).toHaveLength(1);
  });

  it("debounces matching exact-scope editor commits and ignores other scopes", async () => {
    const currentScope = scope();
    const { result } = renderHook(() => useConflictHarness(currentScope));
    await settleCalendarAndCheck();
    expect(result.current.conflicts).toHaveLength(1);

    mocks.loadSceneContents.mockResolvedValue(winterScene);
    act(() => {
      publishSceneBodyCommit({
        workspacePath: "/workspace/other",
        openRevision: 1,
        projectId: "project-1",
        sceneId: "scene-1",
        contentVersion: 2,
      });
      for (let contentVersion = 2; contentVersion <= 4; contentVersion += 1) {
        publishSceneBodyCommit({
          workspacePath: currentScope.workspacePath,
          openRevision: currentScope.openRevision,
          projectId: currentScope.projectId,
          sceneId: "scene-1",
          contentVersion,
        });
      }
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(mocks.loadSceneContents).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.conflicts).toEqual([]);
    expect(mocks.loadSceneContents).toHaveBeenCalledTimes(2);
  });

  it("rechecks after the canonical external-import reload publication", async () => {
    const currentScope = scope();
    const { result } = renderHook(() => useConflictHarness(currentScope));
    await settleCalendarAndCheck();
    expect(result.current.conflicts).toHaveLength(1);

    mocks.loadSceneContents.mockResolvedValue(winterScene);
    act(() => {
      publishExternalDocumentReload(
        encodeDocumentKey({
          kind: "tree",
          id: "scene-1",
          storage: "file",
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(result.current.conflicts).toEqual([]);
    expect(mocks.loadSceneContents).toHaveBeenCalledTimes(2);
  });

  it("retains same-scope last-good conflicts when a body reload fails", async () => {
    const currentScope = scope();
    const { result } = renderHook(() => useConflictHarness(currentScope));
    await settleCalendarAndCheck();
    expect(result.current.conflicts).toHaveLength(1);

    mocks.loadSceneContents.mockRejectedValueOnce(new Error("bridge failed"));
    act(() => {
      publishSceneBodyCommit({
        workspacePath: currentScope.workspacePath,
        openRevision: currentScope.openRevision,
        projectId: currentScope.projectId,
        sceneId: "scene-1",
        contentVersion: 2,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(result.current.conflictStatus).toBe("error");
    expect(result.current.conflictLoadError?.message).toBe("bridge failed");
    expect(result.current.conflicts).toHaveLength(1);
  });

  it("never publishes a late result into another workspace with the same project id", async () => {
    const oldLoad = deferred<Map<string, string>>();
    mocks.loadSceneContents
      .mockImplementationOnce(() => oldLoad.promise)
      .mockResolvedValueOnce(winterScene);

    let currentScope = scope("/workspace/a", 1);
    const { result, rerender } = renderHook(() =>
      useConflictHarness(currentScope),
    );
    await settleCalendarAndCheck();
    expect(result.current.conflictStatus).toBe("loading");

    currentScope = scope("/workspace/b", 2);
    rerender();
    expect(result.current.conflicts).toEqual([]);
    await settleCalendarAndCheck();
    expect(result.current.conflictStatus).toBe("ready");
    expect(result.current.conflicts).toEqual([]);

    oldLoad.resolve(summerScene);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.conflicts).toEqual([]);
    expect(result.current.conflictStatus).toBe("ready");
  });
});
