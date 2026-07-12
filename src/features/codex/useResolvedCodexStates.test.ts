// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSceneTimeIndex } from "./context/sceneTimeIndex";

vi.mock("./phaseApi", () => ({
  listPhasesByEntry: vi.fn().mockResolvedValue([]),
  listDetailOverridesByPhaseIds: vi.fn().mockResolvedValue([]),
  createPhase: vi.fn(),
  updatePhase: vi.fn(),
  deletePhase: vi.fn(),
  upsertDetailOverride: vi.fn(),
  deleteDetailOverride: vi.fn(),
}));

import * as phaseApi from "./phaseApi";
import { usePhaseStore } from "./phaseStore";
import { useResolvedCodexStates } from "./useResolvedCodexStates";

describe("useResolvedCodexStates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePhaseStore.setState({
      projectEpoch: 0,
      phasesByEntry: {},
      detailOverrides: {},
      globalSceneOrder: new Map(),
      sceneTimeIndex: buildSceneTimeIndex([]),
      resolvedStates: {},
      resolutionMode: "reading",
      cachedNodes: [],
    });
  });

  it("same entry id でも Project epoch が変われば Phase を再ロードする", async () => {
    renderHook(() => useResolvedCodexStates(["shared-entry"]));

    await waitFor(() => {
      expect(phaseApi.listPhasesByEntry).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(usePhaseStore.getState().phasesByEntry["shared-entry"]).toEqual(
        [],
      );
    });

    act(() => {
      usePhaseStore.getState().resetForProject();
    });

    await waitFor(() => {
      expect(phaseApi.listPhasesByEntry).toHaveBeenCalledTimes(2);
    });
  });
});
