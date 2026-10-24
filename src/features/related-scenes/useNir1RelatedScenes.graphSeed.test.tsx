// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

// S-5..S-7 (DR-CP3B-3, DR-CP3B-5): the production `run()` reads the seed and
// passes it to the fetch only while the Graph UI is on.
const h = vi.hoisted(() => ({
  tree: { activeSceneId: "s2", nodes: [] },
  fetch: vi.fn(),
  seed: vi.fn(),
  // `undefined` runs the real availability (the shipped default).
  enabled: undefined as boolean | undefined,
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (select: (state: typeof h.tree) => unknown) => select(h.tree),
}));
vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: (select: (state: unknown) => unknown) =>
    select({ resolutionMode: "reading" }),
}));
vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: (select: (state: unknown) => unknown) =>
    select({ currentProjectId: "p" }),
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (select: (state: unknown) => unknown) =>
    select({ activeWorkspacePath: "/workspace", workspaceOpenRevision: 1 }),
}));
vi.mock("./fetchRelatedScenes", () => ({ fetchRelatedPastScenes: h.fetch }));
vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesIndexReady: vi.fn(async () => () => {}),
  listenRelatedScenesGraphReady: vi.fn(async () => () => {}),
}));
vi.mock("./nir1EvidenceNavigation", () => ({
  observeNir1RelatedScenesQuery: vi.fn(),
}));
vi.mock("./nir1GraphSeed", () => ({ selectNir1GraphSeed: h.seed }));
vi.mock("./nir1GraphAvailability", async (original) => {
  const real = await original<typeof import("./nir1GraphAvailability")>();
  return {
    ...real,
    isNir1GraphUiEnabled: () => h.enabled ?? real.isNir1GraphUiEnabled(),
  };
});
import { useNir1RelatedScenes } from "./useNir1RelatedScenes";

function result(): Nir1RelatedScenesFetchResult {
  return {
    status: "completed",
    rawStatus: "completed",
    origin: null,
    queryBinding: "query",
    initialSnapshot: null,
    completion: null,
    rawScenes: [],
    result: { kind: "raw", scenes: [], ir: { status: "empty" } },
    session: null,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 12 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.tree.activeSceneId = "s2";
  h.enabled = undefined;
  h.fetch.mockResolvedValue(result());
  h.seed.mockResolvedValue("entity-1");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const optionKeys = (call: number) =>
  Object.keys(h.fetch.mock.calls[call][1]).sort();

describe("Related Scenes Graph seed wiring (CP-3b S1)", () => {
  it("with the real default no pin is read and begin carries no graphSeedEntityId", async () => {
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.seed).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    // Exactly the options before CP-3b: `fetchRelatedPastScenes` then sends
    // begin's five keys only (fetchRelatedScenes.nir1.test.ts, CP-3a).
    expect(optionKeys(0)).toEqual(
      ["isCurrent", "mode", "queryGeneration", "signal"].sort(),
    );
    expect(h.fetch.mock.calls[0][0]).toBe("s2");
  });

  it("passes the selected seed to the production fetch when the UI is enabled", async () => {
    h.enabled = true;
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.seed).toHaveBeenCalledExactlyOnceWith("p", "s2");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][1].graphSeedEntityId).toBe("entity-1");
    expect(h.fetch.mock.calls[0][1].isCurrent()).toBe(true);
  });

  it("sends no seed key when the scene has no usable pin", async () => {
    h.enabled = true;
    h.seed.mockResolvedValue(null);
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][1]).not.toHaveProperty("graphSeedEntityId");
  });

  it("a seed read that resolves after the scene changed starts nothing", async () => {
    h.enabled = true;
    const first = deferred<string | null>();
    h.seed.mockReturnValueOnce(first.promise);
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.seed).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
    h.tree.activeSceneId = "s3";
    view.rerender();
    await advance(0);
    first.resolve("entity-old");
    await advance(0);
    expect(h.fetch).not.toHaveBeenCalled();
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][0]).toBe("s3");
    expect(h.fetch.mock.calls[0][1].graphSeedEntityId).toBe("entity-1");
  });

  it("a seed read that resolves after unmount starts nothing", async () => {
    h.enabled = true;
    const first = deferred<string | null>();
    h.seed.mockReturnValueOnce(first.promise);
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    view.unmount();
    first.resolve("entity-1");
    await advance(1000);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("a failed seed read runs the unseeded query", async () => {
    h.enabled = true;
    h.seed.mockRejectedValue(new Error("private db detail"));
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][1]).not.toHaveProperty("graphSeedEntityId");
    expect(view.result.current.fetch).not.toBeNull();
  });

  it("a Raw-only recovery reads no seed", async () => {
    h.enabled = true;
    let invalidate: (() => void) | undefined;
    h.fetch.mockResolvedValueOnce({
      ...result(),
      session: {
        release: vi.fn(),
        subscribeInvalidation: (listener: () => void) => {
          invalidate = listener;
          return () => {};
        },
      },
    });
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.seed).toHaveBeenCalledTimes(1);
    act(() => invalidate?.());
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls[1][1].rawOnly).toBe(true);
    expect(h.fetch.mock.calls[1][1]).not.toHaveProperty("graphSeedEntityId");
    expect(h.seed).toHaveBeenCalledTimes(1);
  });
});
