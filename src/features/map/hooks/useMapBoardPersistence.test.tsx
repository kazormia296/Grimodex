// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHOW } from "../types";
import { useMapStore } from "../mapStore";
import {
  clearBoardHydrating,
  markBoardHydrating,
  syncBoardPersistenceSnapshot,
  useMapBoardPersistence,
} from "./useMapBoardPersistence";
import {
  _resetMapPersistenceWritesForTests,
  flushMapPersistenceWritesStrict,
} from "./mapPersistenceWriteQueue";

const h = vi.hoisted(() => ({
  currentProjectId: "project-a",
  updateMapBoardSettings: vi.fn(),
  updateFrame: vi.fn(),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => h.currentProjectId,
  useCurrentProjectId: () => h.currentProjectId,
}));

vi.mock("../mapApi", () => ({
  parseShowConfig: (value: string) => JSON.parse(value),
  serializeShowConfig: (value: unknown) => JSON.stringify(value),
  updateMapBoardSettings: h.updateMapBoardSettings,
  updateFrame: h.updateFrame,
}));

beforeEach(() => {
  vi.useFakeTimers();
  _resetMapPersistenceWritesForTests();
  h.currentProjectId = "project-a";
  h.updateMapBoardSettings.mockReset();
  h.updateMapBoardSettings.mockResolvedValue(undefined);
  h.updateFrame.mockReset();
  h.updateFrame.mockResolvedValue(undefined);
  useMapStore.setState({
    activeBoardId: "board-a",
    mode: "free",
    viewport: { x: 0, y: 0, zoom: 1 },
    show: { ...DEFAULT_SHOW },
    colorBy: "none",
  });
  syncBoardPersistenceSnapshot();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useMapBoardPersistence lifecycle", () => {
  it("forces the latest board snapshot on unmount instead of dropping it", async () => {
    const { unmount } = renderHook(() => useMapBoardPersistence());

    act(() => {
      useMapStore.getState().setMode("theme");
      useMapStore.getState().setViewport({ x: 120, y: -40, zoom: 1.75 });
      useMapStore.getState().setShow({ frames: false });
      useMapStore.getState().setColorBy("status");
    });
    unmount();
    await flushMapPersistenceWritesStrict();

    expect(h.updateMapBoardSettings).toHaveBeenCalledOnce();
    expect(h.updateMapBoardSettings).toHaveBeenCalledWith("board-a", {
      mode: "theme",
      viewportX: 120,
      viewportY: -40,
      viewportZoom: 1.75,
      showConfig: JSON.stringify({ ...DEFAULT_SHOW, frames: false }),
      colorBy: "status",
    });
  });

  it("keeps an old board write while ignoring pre-hydrate state for the new board", async () => {
    renderHook(() => useMapBoardPersistence());

    act(() => {
      useMapStore.getState().setMode("theme");
      useMapStore.getState().setViewport({ x: 20, y: 30, zoom: 1.25 });
    });
    act(() => {
      useMapStore.getState().setActiveBoardId("board-b");
    });
    markBoardHydrating();
    act(() => {
      useMapStore.setState({
        mode: "free",
        viewport: { x: 900, y: 800, zoom: 0.5 },
        show: { ...DEFAULT_SHOW, codex: false },
        colorBy: "stickyColor",
      });
      syncBoardPersistenceSnapshot();
    });
    clearBoardHydrating();
    await act(async () => {
      await Promise.resolve();
    });

    await flushMapPersistenceWritesStrict();

    expect(h.updateMapBoardSettings).toHaveBeenCalledTimes(1);
    expect(h.updateMapBoardSettings).toHaveBeenCalledWith("board-a", {
      mode: "theme",
      viewportX: 20,
      viewportY: 30,
      viewportZoom: 1.25,
      showConfig: JSON.stringify(DEFAULT_SHOW),
      colorBy: "none",
    });
  });
});
