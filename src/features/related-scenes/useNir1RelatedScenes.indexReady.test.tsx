// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Nir1RelatedScenesFetchOptions,
  Nir1RelatedScenesFetchResult,
} from "./nir1RelatedScenesFetchTypes";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";

// LP-A1（DR-WF-9〜11）：`index-ready` は、begin を送る世代でまだ送っていないなら
// 取り消さない（通常の 400 ms の timer の待ちは張り直す）。begin を送った後、
// begin を送らない世代（rawOnly、listener-unavailable）、表示済み、ほかの timer の
// 待ちは今どおり取り直す。`graph-ready` の経路と契機の印には干渉しない。

const h = vi.hoisted(() => ({
  tree: { activeSceneId: "s2", nodes: [] as unknown[] },
  fetch: vi.fn(),
  seed: vi.fn(),
  enabled: false,
  graphReady: undefined as ((projectId: string) => void) | undefined,
  indexReady: undefined as ((projectId: string) => void) | undefined,
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
  listenRelatedScenesIndexReady: async (receive: (id: string) => void) => {
    h.indexReady = receive;
    return () => {};
  },
  listenRelatedScenesGraphReady: async (receive: (id: string) => void) => {
    h.graphReady = receive;
    return () => {};
  },
}));
vi.mock("./nir1EvidenceNavigation", () => ({
  observeNir1RelatedScenesQuery: vi.fn(),
}));
vi.mock("./nir1GraphSeed", () => ({ selectNir1GraphSeed: h.seed }));
vi.mock("./nir1GraphAvailability", async (original) => {
  const real = await original<typeof import("./nir1GraphAvailability")>();
  return { ...real, isNir1GraphUiEnabled: () => h.enabled };
});
import { useNir1RelatedScenes } from "./useNir1RelatedScenes";

type Observer = (reason: string) => void;
function session() {
  const observers = new Set<Observer>();
  const value = {
    release: vi.fn(),
    subscribeInvalidation: vi.fn((observer: Observer) => {
      observers.add(observer);
      return () => observers.delete(observer);
    }),
  };
  return {
    session: value as unknown as Nir1RelatedScenesSession,
    invalidate: () =>
      [...observers].forEach((observer) => observer("invalidated")),
  };
}

function result(
  overrides: Partial<Nir1RelatedScenesFetchResult> = {},
  timeout = false,
): Nir1RelatedScenesFetchResult {
  return {
    status: "completed",
    rawStatus: "completed",
    origin: null,
    queryBinding: "query",
    initialSnapshot: null,
    completion: null,
    rawScenes: [],
    result: {
      kind: "raw",
      scenes: [],
      ir: timeout
        ? { status: "unavailable", reason: "timeout" }
        : { status: "empty" },
    },
    session: session().session,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 12 },
    ...overrides,
  };
}
const late = () => result({ graphOutcome: "graph-late" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A fetch that stays in flight; `begin()` stands in for the begin decision. */
function heldFetch() {
  const done = deferred<Nir1RelatedScenesFetchResult>();
  let options!: Nir1RelatedScenesFetchOptions;
  h.fetch.mockImplementationOnce(
    (_scene: string, given: Nir1RelatedScenesFetchOptions) => {
      options = given;
      return done.promise;
    },
  );
  return {
    decide: (sendsBegin: boolean) => options.onBeginDecision?.(sendsBegin),
    finish: (value: Nir1RelatedScenesFetchResult) =>
      act(async () => {
        done.resolve(value);
      }),
    aborted: () => options.signal?.aborted === true,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.tree.activeSceneId = "s2";
  h.tree.nodes = [];
  h.enabled = false;
  h.graphReady = undefined;
  h.indexReady = undefined;
  h.fetch.mockReset();
  h.fetch.mockResolvedValue(result());
  h.seed.mockReset();
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
const indexReady = () =>
  act(async () => {
    h.indexReady?.("p");
  });
const optionsOf = (call: number) =>
  h.fetch.mock.calls[call]?.[1] as Nir1RelatedScenesFetchOptions | undefined;

describe("index-ready と begin を送る前の世代（LP-A1）", () => {
  it("通知が seed の読取の解決より先でも、その世代は取り消されず begin まで進む", async () => {
    h.enabled = true;
    const seed = deferred<string | null>();
    h.seed.mockReturnValueOnce(seed.promise);
    const held = heldFetch();
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.seed).toHaveBeenCalledOnce();
    expect(h.fetch).not.toHaveBeenCalled();
    // timer の発火の後、seed の読取の待ちの間に通知（調査の (乙)）。
    await indexReady();
    await act(async () => {
      seed.resolve("entity-1");
    });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(optionsOf(0)?.graphSeedEntityId).toBe("entity-1");
    held.decide(true);
    expect(held.aborted()).toBe(false);
    const value = result();
    await held.finish(value);
    expect(view.result.current.fetch).toBe(value);
    await advance(2000);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("seed の読取が先に解決し、fetch の呼出しの後・begin の前に通知が来ても取り消されない", async () => {
    h.enabled = true;
    const held = heldFetch();
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledOnce();
    await indexReady();
    expect(held.aborted()).toBe(false);
    held.decide(true);
    const value = result();
    await held.finish(value);
    expect(view.result.current.fetch).toBe(value);
    await advance(2000);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("通知と旧 timer の発火が同じ描画の前に重なっても（調査の (甲)）、その timer を張り直す", async () => {
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(399);
    // act の中では描画が commit されない：listener の判定が描画を通すと、旧 timer が
    // 発火して始まった run が commit で取り消される。
    await act(async () => {
      h.indexReady?.("p");
      vi.advanceTimersByTime(1);
    });
    expect(h.fetch).not.toHaveBeenCalled();
    // 張り直した timer は通知（399 ms）から 400 ms 後。
    await advance(398);
    expect(h.fetch).not.toHaveBeenCalled();
    await advance(1);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(optionsOf(0)?.signal?.aborted).toBe(false);
    expect(optionsOf(0)?.refreshTrigger).toBeUndefined();
  });

  it("通常の 400 ms の待ちに来た通知は 400 ms を張り直す（counted query の時刻の形）", async () => {
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(200);
    await indexReady();
    await advance(200);
    expect(h.fetch).not.toHaveBeenCalled();
    await advance(199);
    expect(h.fetch).not.toHaveBeenCalled();
    await advance(1);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(optionsOf(0)?.refreshTrigger).toBeUndefined();
  });
});

describe("index-ready で今どおり取り直す世代（LP-A1）", () => {
  it("begin を送った後に来た通知は、その世代を取り消して 400 ms 後に取り直す", async () => {
    const held = heldFetch();
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    held.decide(true);
    await indexReady();
    expect(held.aborted()).toBe(true);
    await advance(399);
    expect(h.fetch).toHaveBeenCalledOnce();
    await advance(1);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(optionsOf(1)?.rawOnly).toBeUndefined();
  });

  it("表示済み（idle）の通知は今どおり一覧を下げて取り直す", async () => {
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(view.result.current.fetch).not.toBeNull();
    await indexReady();
    expect(view.result.current.fetch).toBeNull();
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(optionsOf(1)?.refreshTrigger).toBeUndefined();
  });

  it("listener-unavailable で begin を送らない世代は、その時点で通知を使って full の run で取り直す", async () => {
    const held = heldFetch();
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await indexReady();
    expect(held.aborted()).toBe(false);
    await act(async () => {
      held.decide(false);
    });
    expect(held.aborted()).toBe(true);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(optionsOf(1)?.rawOnly).toBeUndefined();
  });

  it("begin を送らないと決まった後の通知も今どおり取り直す", async () => {
    const held = heldFetch();
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    held.decide(false);
    await indexReady();
    expect(held.aborted()).toBe(true);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("通知を受けた世代が begin を送らずに終われば、公開せずに取り直す（安全網）", async () => {
    const held = heldFetch();
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await indexReady();
    await held.finish(result());
    expect(view.result.current.fetch).toBeNull();
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("Raw の取り直し（recoverRaw）の timer の待ちの通知は、full の run で IR を戻す", async () => {
    const owned = session();
    h.fetch.mockResolvedValueOnce(result({ session: owned.session }));
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await act(async () => {
      owned.invalidate();
    });
    await advance(200);
    await indexReady();
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(optionsOf(1)?.rawOnly).toBeUndefined();
  });

  it("in-flight の Raw の取り直し（rawOnly）の通知は、その場で取り消して full の run で IR を戻す", async () => {
    const owned = session();
    h.fetch.mockResolvedValueOnce(result({ session: owned.session }));
    const raw = heldFetch();
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await act(async () => {
      owned.invalidate();
    });
    await advance(400);
    expect(optionsOf(1)?.rawOnly).toBe(true);
    await indexReady();
    expect(raw.aborted()).toBe(true);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(optionsOf(2)?.rawOnly).toBeUndefined();
  });

  it("IR の timeout の再試行の待ちに来た通知は今どおり新しい effect（一覧を下げる）", async () => {
    h.fetch.mockResolvedValueOnce(result({}, true));
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(view.result.current.fetch).not.toBeNull();
    await advance(200);
    await indexReady();
    expect(view.result.current.fetch).toBeNull();
    await advance(200);
    expect(h.fetch).toHaveBeenCalledOnce();
    await advance(200);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("index-ready は graph-ready の経路に干渉しない（LP-A1、DR-WF-3・8）", () => {
  it("子の 0 ms の timer の待ちに来た通知は、契機の印の無い 400 ms の query に落ちる", async () => {
    h.fetch.mockResolvedValueOnce(late());
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await act(async () => {
      h.graphReady?.("p");
    });
    // 子の timer（0 ms）は未発火のまま通知。
    await indexReady();
    await advance(0);
    expect(h.fetch).toHaveBeenCalledOnce();
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(optionsOf(1)?.refreshTrigger).toBeUndefined();
    await advance(2000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("連鎖の 400 ms の timer の待ちに来た通知も、印の無い query に落ちる", async () => {
    h.fetch.mockResolvedValueOnce(late()).mockResolvedValueOnce(late());
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await act(async () => {
      h.graphReady?.("p");
    });
    await advance(0);
    expect(optionsOf(1)?.refreshTrigger).toBe("graph-ready");
    await act(async () => {
      h.graphReady?.("p");
    });
    await advance(200);
    await indexReady();
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(optionsOf(2)?.refreshTrigger).toBeUndefined();
  });

  it("子の in-flight の begin の前の通知は子を取り消さず、印は子のまま", async () => {
    h.fetch.mockResolvedValueOnce(late());
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    const child = heldFetch();
    await act(async () => {
      h.graphReady?.("p");
    });
    await advance(0);
    expect(optionsOf(1)?.refreshTrigger).toBe("graph-ready");
    await indexReady();
    child.decide(true);
    expect(child.aborted()).toBe(false);
    await child.finish(result({ graphOutcome: "graph-ready" }));
    await advance(2000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["index-ready が先", ["index", "graph"]],
    ["graph-ready が先", ["graph", "index"]],
  ] as const)(
    "表示済みで 2 つの通知が 1 回の描画にまとまると子になる（DR-WF-8 (a)、%s）",
    async (_label, order) => {
      h.fetch.mockResolvedValueOnce(late());
      renderHook(() => useNir1RelatedScenes(true));
      await advance(0);
      await advance(400);
      await act(async () => {
        for (const notice of order)
          (notice === "index" ? h.indexReady : h.graphReady)?.("p");
      });
      await advance(0);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(optionsOf(1)?.refreshTrigger).toBe("graph-ready");
    },
  );
});
