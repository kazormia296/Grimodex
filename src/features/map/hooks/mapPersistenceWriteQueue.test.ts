import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import {
  flushQuiescenceProviderStage,
  QuiescenceProviderStageError,
} from "@/lib/quiescenceProviders";
import {
  _resetMapPersistenceWritesForTests,
  flushMapPersistenceWritesStrict,
  MAP_FRAME_RESIZE_DEBOUNCE_MS,
  scheduleMapBoardSettingsWrite,
  scheduleMapFrameResizeWrite,
  type MapBoardSettingsSnapshot,
} from "./mapPersistenceWriteQueue";

const h = vi.hoisted(() => ({
  currentProjectId: "project-a",
  updateMapBoardSettings: vi.fn(),
  updateFrame: vi.fn(),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => h.currentProjectId,
}));

vi.mock("../mapApi", () => ({
  updateMapBoardSettings: h.updateMapBoardSettings,
  updateFrame: h.updateFrame,
}));

function boardSettings(
  overrides: Partial<MapBoardSettingsSnapshot> = {},
): MapBoardSettingsSnapshot {
  return {
    mode: "free",
    viewportX: 0,
    viewportY: 0,
    viewportZoom: 1,
    showConfig: "{}",
    colorBy: "none",
    ...overrides,
  };
}

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

function expectProviderFailure(
  rejection: unknown,
  providerId: string,
  message: string,
): void {
  expect(rejection).toBeInstanceOf(QuiescenceProviderStageError);
  const stageError = rejection as QuiescenceProviderStageError;
  const providerFailure = stageError.providerFailures.find(
    (failure) => failure.providerId === providerId,
  );
  expect(providerFailure).toBeDefined();
  expect(providerFailure?.originalError).toMatchObject({ message });
  expect((providerFailure?.originalError as AggregateError).errors).toEqual([
    expect.objectContaining({ message }),
  ]);
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetQuiescenceLeasesForTests();
  _resetMapPersistenceWritesForTests();
  h.currentProjectId = "project-a";
  h.updateMapBoardSettings.mockReset();
  h.updateMapBoardSettings.mockResolvedValue(undefined);
  h.updateFrame.mockReset();
  h.updateFrame.mockResolvedValue(undefined);
});

describe("Map Project-DB persistence quiescence", () => {
  it("forces the board debounce and waits for the real write", async () => {
    const write = deferred<undefined>();
    h.updateMapBoardSettings.mockReturnValueOnce(write.promise);
    scheduleMapBoardSettingsWrite({
      projectId: "project-a",
      boardId: "board-a",
      settings: boardSettings({ mode: "theme", viewportX: 42 }),
    });

    let settled = false;
    const flush = flushQuiescenceProviderStage("scoped-mutations").then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(h.updateMapBoardSettings).toHaveBeenCalledWith("board-a", {
      mode: "theme",
      viewportX: 42,
      viewportY: 0,
      viewportZoom: 1,
      showConfig: "{}",
      colorBy: "none",
    });
    expect(settled).toBe(false);

    write.resolve(undefined);
    await flush;
    expect(settled).toBe(true);
  });

  it("coalesces board settings to the latest complete snapshot", async () => {
    scheduleMapBoardSettingsWrite({
      projectId: "project-a",
      boardId: "board-a",
      settings: boardSettings({ viewportZoom: 1.5 }),
    });
    scheduleMapBoardSettingsWrite({
      projectId: "project-a",
      boardId: "board-a",
      settings: boardSettings({
        mode: "theme",
        viewportZoom: 2,
        colorBy: "status",
      }),
    });

    await flushMapPersistenceWritesStrict();

    expect(h.updateMapBoardSettings).toHaveBeenCalledTimes(1);
    expect(h.updateMapBoardSettings).toHaveBeenCalledWith(
      "board-a",
      boardSettings({
        mode: "theme",
        viewportZoom: 2,
        colorBy: "status",
      }),
    );
  });

  it("serializes each frame and publishes only the latest queued size", async () => {
    const first = deferred<undefined>();
    h.updateFrame
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined);
    const firstPersisted = vi.fn();
    const latestPersisted = vi.fn();

    scheduleMapFrameResizeWrite({
      projectId: "project-a",
      boardId: "board-a",
      frameId: "frame-a",
      width: 500,
      height: 300,
      onPersist: firstPersisted,
    });
    await vi.advanceTimersByTimeAsync(MAP_FRAME_RESIZE_DEBOUNCE_MS);
    expect(h.updateFrame).toHaveBeenCalledTimes(1);

    scheduleMapFrameResizeWrite({
      projectId: "project-a",
      boardId: "board-a",
      frameId: "frame-a",
      width: 640,
      height: 480,
      onPersist: latestPersisted,
    });
    const flush = flushMapPersistenceWritesStrict();
    await Promise.resolve();
    expect(h.updateFrame).toHaveBeenCalledTimes(1);

    first.resolve(undefined);
    await flush;

    expect(h.updateFrame.mock.calls).toEqual([
      ["frame-a", { width: 500, height: 300 }],
      ["frame-a", { width: 640, height: 480 }],
    ]);
    expect(firstPersisted).not.toHaveBeenCalled();
    expect(latestPersisted).toHaveBeenCalledOnce();
  });

  it("retains a failed snapshot, reports it to strict flush, and retries", async () => {
    h.updateMapBoardSettings
      .mockRejectedValueOnce(new Error("map database full"))
      .mockResolvedValueOnce(undefined);
    scheduleMapBoardSettingsWrite({
      projectId: "project-a",
      boardId: "board-a",
      settings: boardSettings({ mode: "theme" }),
    });

    const rejection = await flushQuiescenceProviderStage(
      "scoped-mutations",
    ).catch((error: unknown) => error);
    expectProviderFailure(
      rejection,
      "map-project-db-writes",
      "map database full",
    );
    await expect(
      flushQuiescenceProviderStage("scoped-mutations"),
    ).resolves.toBeUndefined();
    expect(h.updateMapBoardSettings).toHaveBeenCalledTimes(2);
  });

  it("preserves the frame background failure callback while retaining strict failure", async () => {
    const reportError = vi.fn();
    h.updateFrame.mockRejectedValue(new Error("frame write failed"));
    scheduleMapFrameResizeWrite({
      projectId: "project-a",
      boardId: "board-a",
      frameId: "frame-a",
      width: 600,
      height: 400,
      onBackgroundError: reportError,
    });

    await vi.advanceTimersByTimeAsync(MAP_FRAME_RESIZE_DEBOUNCE_MS);
    expect(reportError).toHaveBeenCalledOnce();
    await expect(flushMapPersistenceWritesStrict()).rejects.toThrow(
      "frame write failed",
    );
  });

  it("fails closed if Project authority changes before the debounce drains", async () => {
    scheduleMapBoardSettingsWrite({
      projectId: "project-a",
      boardId: "board-a",
      settings: boardSettings({ mode: "theme" }),
    });
    h.currentProjectId = "project-b";

    await expect(flushMapPersistenceWritesStrict()).rejects.toThrow(
      "Map persistence authority changed",
    );
    expect(h.updateMapBoardSettings).not.toHaveBeenCalled();
  });

  it("does not admit a new Map write after lifecycle quiescence starts", async () => {
    const lease = acquireQuiescenceLease("project-load");
    scheduleMapFrameResizeWrite({
      projectId: "project-a",
      boardId: "board-a",
      frameId: "frame-a",
      width: 600,
      height: 400,
    });
    lease.release();

    await flushMapPersistenceWritesStrict();
    expect(h.updateFrame).not.toHaveBeenCalled();
  });
});
