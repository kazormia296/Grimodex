import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RelatedScenesBeginResponse,
  RelatedScenesContinueResponse,
  RelatedScenesGraphWaitResponse,
} from "@/../electron/shared/relatedScenesSearchWire";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import type { SemanticSearchHit } from "@/features/semantic-search/api";
import type { Nir1AdmittedScene } from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";
import {
  RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS,
  RELATED_SCENES_IR_EXTRA_WAIT_MS,
} from "./relatedScenesConfig";

const h = vi.hoisted(() => ({
  load: vi.fn(),
  semantic: vi.fn(),
  sparse: vi.fn(),
  begin: vi.fn(),
  continue: vi.fn(),
  graphContinue: vi.fn(),
  graphSettle: vi.fn(),
  release: vi.fn(),
  listen: vi.fn(),
  listenReady: vi.fn(),
  unlisten: vi.fn(),
  unlistenReady: vi.fn(),
  invalidate: undefined as ((binding: string) => void) | undefined,
  ready: undefined as ((projectId: string) => void) | undefined,
  projectId: "p1",
  language: "ja",
  now: 100,
}));
vi.mock("@/features/tree/api", () => ({ loadSceneContent: h.load }));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => h.projectId,
  getCurrentProjectLanguage: () => h.language,
}));
vi.mock("@/features/semantic-search/api", () => ({
  semanticSearch: h.semantic,
}));
vi.mock("@/features/chat/semanticRecall", async (original) => ({
  ...(await original<typeof import("@/features/chat/semanticRecall")>()),
  fetchSparseSceneIds: h.sparse,
}));
vi.mock("./nir1RelatedScenesApi", () => ({
  beginRelatedScenes: h.begin,
  continueRelatedScenes: h.continue,
  continueRelatedScenesGraph: h.graphContinue,
  settleRelatedScenesGraph: h.graphSettle,
  releaseRelatedScenes: h.release,
  listenRelatedScenesInvalidations: h.listen,
  listenRelatedScenesIndexReady: h.listenReady,
}));

import { fetchRelatedPastScenes } from "./fetchRelatedScenes";
import * as fusion from "./nir1RelatedScenesFusion";

const doc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
const rawHit = (sceneId: string, score: number): SemanticSearchHit => ({
  sceneId,
  sceneTitle: `Raw ${sceneId}`,
  chunkText: `Raw excerpt ${sceneId}`,
  charStart: 0,
  charEnd: 20,
  score,
  dialogueRatio: 0,
});
const hits = [rawHit("a", 0.95), rawHit("b", 0.88)];
const admitted: Nir1AdmittedScene = {
  sceneId: "ir",
  sceneTitle: "Admitted scene",
  irCosine: 0.96,
  interpretation: {
    summary: "Admitted interpretation",
    actuality: "rumored",
    attribution: "narrator",
    narrativeFrame: "story-world",
  },
  validatedEvidence: {
    excerpt: "Display Evidence",
    navigationIdentity: "opaque-navigation",
  },
  review: "human-approved",
  freshness: "fresh",
};
const beginResponse = (): RelatedScenesBeginResponse => ({
  status: "raw-ready",
  denseHits: hits,
  snapshot: {
    queryBinding: "query-a",
    originalSnapshotUsable: true,
    supportedProfile: true,
  },
  ir: { status: "pending", operationTicket: "ticket-a" },
});
const irResponse = (): RelatedScenesContinueResponse => ({
  status: "available",
  queryBinding: "query-a",
  scenes: [admitted],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function drain() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}
const sessions: Nir1RelatedScenesSession[] = [];
function fetchHybrid(
  options: {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    queryGeneration?: number;
    graphSeedEntityId?: string;
    rawOnly?: boolean;
    refreshTrigger?: "graph-ready";
  } = {},
) {
  const response = fetchRelatedPastScenes("current", {
    mode: "hybrid",
    ...options,
  });
  void response.then((value) => {
    if (value.session) sessions.push(value.session);
  });
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.projectId = "p1";
  h.language = "ja";
  h.now = 100;
  h.invalidate = undefined;
  h.ready = undefined;
  vi.spyOn(performance, "now").mockImplementation(() => h.now);
  setCurrentWorkspaceIdentity({ path: "/workspace/one", openRevision: 1 });
  useTreeStore.setState({
    activeSceneId: "current",
    nodes: ["a", "b", "ir", "current"].map((id, i) => ({
      id,
      projectId: "p1",
      parentId: null,
      nodeType: "scene",
      sortOrder: String(i),
      storyTimeOrder: String(i),
    })),
  } as never);
  usePhaseStore.setState({ resolutionMode: "reading" });
  h.load.mockResolvedValue(doc("保存された本文"));
  h.semantic.mockResolvedValue(hits);
  h.sparse.mockResolvedValue([]);
  h.begin.mockResolvedValue(beginResponse());
  h.continue.mockResolvedValue(irResponse());
  h.release.mockResolvedValue({ status: "released" });
  h.graphSettle.mockResolvedValue({ status: "settled" });
  h.listen.mockImplementation(async (callback: (binding: string) => void) => {
    h.invalidate = callback;
    return h.unlisten;
  });
  h.listenReady.mockImplementation(
    async (callback: (projectId: string) => void) => {
      h.ready = callback;
      return h.unlistenReady;
    },
  );
});

afterEach(() => {
  for (const value of sessions.splice(0)) value.invalidate();
  setCurrentWorkspaceIdentity(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("NIR1 production fetch orchestration", () => {
  it("does not load or invoke a query already aborted at fetch entry", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await fetchHybrid({ signal: controller.signal });
    expect(h.load).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(response.status).toBe("cancelled");
    expect(response.initialSnapshot).toBeNull();
  });

  it("keeps Raw available when optional IR event registration fails before begin", async () => {
    h.listenReady.mockRejectedValue(new Error("private registration detail"));
    const response = await fetchHybrid();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.semantic).toHaveBeenCalledOnce();
    expect(response.status).toBe("completed");
    expect(response.rawStatus).toBe("completed");
    expect(response.result).toMatchObject({
      kind: "raw",
      ir: { status: "unavailable", reason: "failed" },
    });
    expect(response.result.scenes).toBe(response.rawScenes);
    expect(response.initialSnapshot).toBeNull();
  });

  it("preserves the saved-body query and uses begin dense hits without a second embedding search", async () => {
    h.load.mockResolvedValue(doc(`${"前".repeat(120)}${"後".repeat(500)}  `));
    const response = await fetchHybrid({ queryGeneration: 7 });
    expect(h.begin).toHaveBeenCalledExactlyOnceWith({
      expectedWorkspacePath: "/workspace/one",
      projectId: "p1",
      currentSceneId: "current",
      query: "後".repeat(500),
    });
    expect(h.semantic).not.toHaveBeenCalled();
    expect(h.continue).toHaveBeenCalledExactlyOnceWith("ticket-a");
    expect(response.status).toBe("completed");
    expect(response.origin).toMatchObject({
      workspacePath: "/workspace/one",
      openRevision: 1,
      projectId: "p1",
      querySceneId: "current",
      queryGeneration: 7,
    });
    expect(response.result.kind).toBe("fused");
    expect(response.result.scenes[0].sceneId).toBe("a");
    expect(response.rawScenes.map((scene) => scene.sceneId)).toEqual([
      "a",
      "b",
    ]);
    expect(response.completion).toMatchObject({
      outcome: "ir-ready",
      timeoutDenominator: true,
      timeoutNumerator: false,
    });
    expect(h.release).not.toHaveBeenCalled();
  });

  it("waits for the existing source-content read barrier before beginning inference", async () => {
    const sourceWrite = deferred<string>();
    h.load.mockReturnValue(sourceWrite.promise);
    const pending = fetchHybrid();
    await drain();
    expect(h.begin).not.toHaveBeenCalled();
    sourceWrite.resolve(doc("保存完了後の本文"));
    await pending;
    expect(h.begin.mock.calls[0][0].query).toBe("保存完了後の本文");
  });

  it("does not begin until both invalidation and readiness subscriptions have registered", async () => {
    const ready = deferred<() => void>();
    h.listenReady.mockReturnValue(ready.promise);
    const pending = fetchHybrid();
    await drain();
    expect(h.begin).not.toHaveBeenCalled();
    ready.resolve(h.unlistenReady);
    await pending;
    expect(h.begin).toHaveBeenCalledOnce();
  });

  it("does not begin after invalidations overflow while the saved source is loading", async () => {
    const source = deferred<string>();
    h.load.mockReturnValue(source.promise);
    const pending = fetchHybrid();
    await drain();
    for (let i = 0; i < 65; i++) h.invalidate?.(`other-query-${i}`);
    source.resolve(doc("保存完了後の本文"));
    const response = await pending;
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.continue).not.toHaveBeenCalled();
    expect(response.status).toBe("cancelled");
    expect(response.initialSnapshot).toBeNull();
    expect(response.session?.stopReason).toBe("invalidation-overflow");
    expect(h.unlisten).toHaveBeenCalledOnce();
    expect(h.unlistenReady).toHaveBeenCalledOnce();
  });

  it.each([
    "workspace",
    "same-path-reopen",
    "project",
    "mode",
    "generation",
  ] as const)(
    "captures the origin before the source read and rejects a changed %s",
    async (change) => {
      const source = deferred<string>();
      h.load.mockReturnValue(source.promise);
      let current = true;
      const pending = fetchHybrid({
        queryGeneration: 4,
        isCurrent: () => current,
      });
      if (change === "workspace")
        setCurrentWorkspaceIdentity({
          path: "/workspace/two",
          openRevision: 2,
        });
      if (change === "same-path-reopen")
        setCurrentWorkspaceIdentity({
          path: "/workspace/one",
          openRevision: 2,
        });
      if (change === "project") h.projectId = "p2";
      if (change === "mode")
        usePhaseStore.setState({ resolutionMode: "story" });
      if (change === "generation") current = false;
      source.resolve(doc("古い要求の本文"));
      const response = await pending;
      expect(h.begin).not.toHaveBeenCalled();
      expect(response.status).toBe("cancelled");
      expect(response.origin).toMatchObject({
        workspacePath: "/workspace/one",
        openRevision: 1,
        projectId: "p1",
        queryGeneration: 4,
      });
      expect(response.initialSnapshot).toBeNull();
    },
  );

  it("releases a late begin ticket after abort without continuing IR", async () => {
    const begin = deferred<RelatedScenesBeginResponse>();
    h.begin.mockReturnValue(begin.promise);
    const controller = new AbortController();
    const pending = fetchHybrid({ signal: controller.signal });
    await drain();
    expect(h.begin).toHaveBeenCalledOnce();
    controller.abort();
    begin.resolve(beginResponse());
    const response = await pending;
    expect(response.status).toBe("cancelled");
    expect(response.initialSnapshot).toEqual({
      indexUsable: true,
      querySupported: true,
    });
    expect(h.continue).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
  });

  it("keeps matching invalidation during begin and releases the returned ticket", async () => {
    const begin = deferred<RelatedScenesBeginResponse>();
    h.begin.mockReturnValue(begin.promise);
    const pending = fetchHybrid();
    await drain();
    h.invalidate!("query-a");
    begin.resolve(beginResponse());
    const response = await pending;
    expect(response.status).toBe("invalidated");
    expect(h.continue).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
  });

  it("starts continuation while sparse retrieval is still pending and anchors D only at actual Raw completion", async () => {
    const sparse = deferred<string[]>();
    const ir = deferred<RelatedScenesContinueResponse>();
    h.sparse.mockReturnValue(sparse.promise);
    h.continue.mockReturnValue(ir.promise);
    const pending = fetchHybrid();
    await drain();
    expect(h.continue).toHaveBeenCalledOnce();
    h.now = 200;
    sparse.resolve([]);
    await drain();
    h.now = 209;
    ir.resolve(irResponse());
    const response = await pending;
    expect(response.timing.tRawReadyMs).toBe(200);
    expect(response.completion).toMatchObject({
      outcome: "ir-ready",
      completedAtMs: 209,
      timeoutNumerator: false,
    });
  });

  it("returns exact Raw at the deadline, releases IR, and never attaches late IR", async () => {
    const ir = deferred<RelatedScenesContinueResponse>();
    h.continue.mockReturnValue(ir.promise);
    const pending = fetchHybrid();
    await drain();
    h.now = 120;
    await vi.advanceTimersByTimeAsync(20);
    const response = await pending;
    expect(response.result).toMatchObject({
      kind: "raw",
      ir: { status: "unavailable", reason: "timeout" },
    });
    expect(response.result.scenes).toBe(response.rawScenes);
    expect(response.completion).toMatchObject({
      outcome: "timeout",
      deadlineExceeded: true,
      timeoutNumerator: true,
    });
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
    const before = JSON.stringify(response.result);
    ir.resolve(irResponse());
    await drain();
    expect(JSON.stringify(response.result)).toBe(before);
    expect(h.release).toHaveBeenCalledOnce();
    expect(response.session?.isActive()).toBe(true);
  });

  it.each(["reject", "unavailable"] as const)(
    "counts late IR %s as deadline exceeded even before a delayed timer fires",
    async (kind) => {
      const ir = deferred<RelatedScenesContinueResponse>();
      h.continue.mockReturnValue(ir.promise);
      const pending = fetchHybrid();
      await drain();
      h.now = 120;
      if (kind === "reject") ir.reject(new Error("private error details"));
      else ir.resolve({ status: "unavailable", reason: "failed" });
      const response = await pending;
      expect(response.result.scenes).toBe(response.rawScenes);
      expect(response.completion).toMatchObject({
        outcome: "failed",
        deadlineExceeded: true,
        timeoutDenominator: true,
        timeoutNumerator: true,
      });
      expect(JSON.stringify(response.result)).not.toContain("private");
    },
  );

  it("checks the deadline after fusion work, not just on IPC arrival", async () => {
    const original = fusion.fuseNir1RelatedScenes;
    vi.spyOn(fusion, "fuseNir1RelatedScenes").mockImplementation((raw, ir) => {
      const result = original(raw, ir);
      if (result.kind === "fused") h.now = 120;
      return result;
    });
    const response = await fetchHybrid();
    expect(response.result.scenes).toBe(response.rawScenes);
    expect(response.completion).toMatchObject({
      outcome: "timeout",
      deadlineExceeded: true,
      timeoutNumerator: true,
    });
  });

  it("rejects an IR response bound to another query before projection or fusion", async () => {
    h.continue.mockResolvedValue({
      ...irResponse(),
      queryBinding: "wrong-query",
    });
    const response = await fetchHybrid();
    expect(response.result).toMatchObject({
      kind: "raw",
      ir: { status: "unavailable", reason: "invalid-response" },
    });
    expect(response.result.scenes).toBe(response.rawScenes);
    expect(JSON.stringify(response.result)).not.toContain(
      "Admitted interpretation",
    );
  });

  it("constructs an admitted-only renderer projection without copying extra wire fields", async () => {
    h.continue.mockResolvedValue({
      ...irResponse(),
      scenes: [
        {
          ...admitted,
          fullEnvelope: "private",
          interpretation: {
            ...admitted.interpretation,
            contextRoster: "private",
          },
          validatedEvidence: {
            ...admitted.validatedEvidence,
            privateSourceName: "private",
          },
        },
      ],
    });
    const response = await fetchHybrid();
    expect(response.result.kind).toBe("fused");
    expect(JSON.stringify(response.result)).not.toContain("private");
  });

  it("retains readiness events received during an unavailable begin for a subsequent generation", async () => {
    const begin = deferred<RelatedScenesBeginResponse>();
    h.begin.mockReturnValue(begin.promise);
    const pending = fetchHybrid();
    await drain();
    h.ready!("p1");
    begin.resolve({
      ...beginResponse(),
      snapshot: {
        queryBinding: "query-a",
        originalSnapshotUsable: false,
        supportedProfile: true,
      },
      ir: { status: "unavailable", reason: "index-unavailable" },
    });
    const response = await pending;
    expect(response.result.scenes).toBe(response.rawScenes);
    expect(response.result).toMatchObject({
      kind: "raw",
      ir: { status: "unavailable", reason: "index-unavailable" },
    });
    expect(response.session?.isActive()).toBe(true);
    const refetch = vi.fn();
    response.session?.subscribeIndexReady(refetch);
    expect(refetch).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("keeps empty admitted IR separate from unavailable IR", async () => {
    h.continue.mockResolvedValue({
      status: "available",
      queryBinding: "query-a",
      scenes: [],
    });
    const response = await fetchHybrid();
    expect(response.result).toMatchObject({
      kind: "raw",
      ir: { status: "empty" },
    });
    expect(response.result.scenes).toBe(response.rawScenes);
  });

  it.each(["source", "begin"] as const)(
    "records %s failure without fabricating a negative first snapshot",
    async (stage) => {
      if (stage === "source")
        h.load.mockRejectedValue(new Error("private source failure"));
      else h.begin.mockRejectedValue(new Error("private transport failure"));
      const response = await fetchHybrid();
      expect(response.status).toBe("failed");
      expect(response.rawStatus).toBe("failed");
      expect(response.initialSnapshot).toBeNull();
      expect(response.completion).toBeNull();
      expect(JSON.stringify(response.result)).not.toContain("private");
    },
  );
});

type GraphAvailable = Extract<
  RelatedScenesGraphWaitResponse,
  { status: "available" }
>;
const graphWire = (
  overrides: Partial<GraphAvailable> = {},
): GraphAvailable => ({
  status: "available",
  queryBinding: "query-a",
  pathAttachments: [
    {
      sceneId: "a",
      hop: 1,
      edges: [
        {
          relationType: "ally",
          directionality: "directed",
          from: { entityId: "e1", label: "Alice" },
          to: { entityId: "e2", label: "Bob" },
          evidence: [{ evidenceId: "ev1", quote: "They met." }],
        },
      ],
    },
  ],
  graphOnly: null,
  ...overrides,
});
const graphOnlyRow = {
  sceneId: "g",
  sceneTitle: "Graph scene",
  excerpt: "Graph excerpt",
  canonicalRange: { start: 0, end: 13 },
  navigationIdentity: "related-scenes-graph-scene:opaque",
  path: {
    hop: 2,
    pinEntityId: "e2",
    edges: [
      {
        relationType: "ally",
        directionality: "directed",
        from: { entityId: "e1", label: "Alice" },
        to: { entityId: "e2", label: "Bob" },
        evidence: [{ evidenceId: "ev1", quote: "They met." }],
      },
    ],
  },
};
const seeded = () => ({ graphSeedEntityId: "entity-seed" });
const pendingBegin = (): RelatedScenesBeginResponse => ({
  ...beginResponse(),
  graph: { status: "pending" },
});

describe("NIR1 Graph join wiring (CP-3a)", () => {
  it("leaves an unseeded query exactly as before: no Graph call, no Graph field", async () => {
    const response = await fetchHybrid();
    expect(h.begin.mock.calls[0][0]).not.toHaveProperty("graphSeedEntityId");
    expect(h.graphContinue).not.toHaveBeenCalled();
    expect(h.graphSettle).not.toHaveBeenCalled();
    expect(response).not.toHaveProperty("graphOutcome");
    expect(response).not.toHaveProperty("graph");
    expect(response.result.kind).toBe("fused");
  });

  it("ignores a seed for a Raw-only recovery (no begin at all)", async () => {
    h.listenReady.mockRejectedValue(new Error("no bridge"));
    await fetchHybrid({ ...seeded(), rawOnly: true });
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.graphContinue).not.toHaveBeenCalled();
  });

  it("sends the seed to begin and waits once, with the Raw R IDs, after Raw is selected", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    h.graphContinue.mockResolvedValue(graphWire());
    const response = await fetchHybrid(seeded());
    expect(h.begin.mock.calls[0][0]).toMatchObject({
      graphSeedEntityId: "entity-seed",
    });
    expect(h.graphContinue).toHaveBeenCalledExactlyOnceWith("ticket-a", [
      "a",
      "b",
    ]);
    expect(response.graphOutcome).toBe("graph-ready");
    expect(response.graph).toEqual({
      queryBinding: "query-a",
      pathAttachments: graphWire().pathAttachments,
      graphOnly: null,
    });
    // The fusion result is the R+IR one, untouched by the Graph.
    expect(response.result.kind).toBe("fused");
    expect(response.result.scenes[0].sceneId).toBe("a");
    expect(h.graphSettle).toHaveBeenCalledExactlyOnceWith("ticket-a", "used");
    expect(h.release).not.toHaveBeenCalled();
  });

  it("publishes graph-late at the deadline with R+IR and declares the ticket unused", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    const graph = deferred<RelatedScenesGraphWaitResponse>();
    h.graphContinue.mockReturnValue(graph.promise);
    const pending = fetchHybrid(seeded());
    await drain();
    h.now = 120;
    await vi.advanceTimersByTimeAsync(20);
    const response = await pending;
    expect(response.graphOutcome).toBe("graph-late");
    expect(response).not.toHaveProperty("graph");
    expect(response.result.kind).toBe("fused");
    expect(h.graphSettle).toHaveBeenCalledExactlyOnceWith("ticket-a", "unused");
    graph.resolve(graphWire());
    await drain();
    expect(response).not.toHaveProperty("graph");
    expect(h.graphSettle).toHaveBeenCalledOnce();
  });

  it("does not wait for, or add a wait to, a Graph that was unavailable at begin", async () => {
    h.begin.mockResolvedValue({
      ...beginResponse(),
      graph: { status: "unavailable", reason: "not-activated" },
    });
    // No timer is advanced: the result must not wait for the deadline.
    const response = await fetchHybrid(seeded());
    expect(h.graphContinue).not.toHaveBeenCalled();
    expect(h.graphSettle).not.toHaveBeenCalled();
    expect(response.graphOutcome).toBe("graph-unavailable:not-activated");
    expect(response.result.kind).toBe("fused");
  });

  it("reports an unavailable Graph wait with its closed reason and keeps R+IR", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    h.graphContinue.mockResolvedValue({
      status: "unavailable",
      reason: "warming",
    });
    const response = await fetchHybrid(seeded());
    expect(response.graphOutcome).toBe("graph-unavailable:warming");
    expect(response.result.kind).toBe("fused");
    expect(h.graphSettle).toHaveBeenCalledExactlyOnceWith("ticket-a", "used");
  });

  it("uses exact R and cancels the Graph ticket when IR is unavailable", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    h.continue.mockResolvedValue({ status: "unavailable", reason: "failed" });
    h.graphContinue.mockReturnValue(new Promise(() => {}));
    const response = await fetchHybrid(seeded());
    expect(response.result.scenes).toBe(response.rawScenes);
    expect(response.graphOutcome).toBe("graph-unavailable:cancelled");
    expect(response).not.toHaveProperty("graph");
    expect(h.graphSettle).toHaveBeenCalledExactlyOnceWith(
      "ticket-a",
      "cancelled",
    );
  });

  it("does not use a Graph when IR times out, and declares it unused", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    h.continue.mockReturnValue(new Promise(() => {}));
    h.graphContinue.mockReturnValue(new Promise(() => {}));
    const pending = fetchHybrid(seeded());
    await drain();
    h.now = 120;
    await vi.advanceTimersByTimeAsync(20);
    const response = await pending;
    expect(response.result).toMatchObject({
      kind: "raw",
      ir: { status: "unavailable", reason: "timeout" },
    });
    expect(response.graphOutcome).toBe("graph-late");
    expect(h.graphSettle).toHaveBeenCalledExactlyOnceWith("ticket-a", "unused");
  });

  it("does not start a Graph wait for a query that is no longer current", async () => {
    const begin = deferred<RelatedScenesBeginResponse>();
    h.begin.mockReturnValue(begin.promise);
    const controller = new AbortController();
    const pending = fetchHybrid({ ...seeded(), signal: controller.signal });
    await drain();
    controller.abort();
    begin.resolve(pendingBegin());
    const response = await pending;
    expect(response.status).toBe("cancelled");
    expect(h.graphContinue).not.toHaveBeenCalled();
    expect(h.graphSettle).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
  });

  it("projects display fields only and drops anything else the answer carries", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    h.graphContinue.mockResolvedValue({
      ...graphWire({ graphOnly: graphOnlyRow }),
      privateDigest: "private",
      graphOnly: {
        ...graphOnlyRow,
        canonicalTextDigest: "private",
        path: { ...graphOnlyRow.path, token: "private" },
      },
    } as unknown as RelatedScenesGraphWaitResponse);
    const response = await fetchHybrid(seeded());
    expect(response.graph?.graphOnly).toEqual(graphOnlyRow);
    expect(JSON.stringify(response.graph)).not.toContain("private");
  });

  it.each([
    ["a binding of another query", { queryBinding: "wrong-query" }],
    ["a malformed path", { pathAttachments: [{ sceneId: "a", hop: 1 }] }],
    ["a malformed Graph-only row", { graphOnly: { sceneId: "g" } }],
  ])("reports %s as an unavailable Graph", async (_name, patch) => {
    h.begin.mockResolvedValue(pendingBegin());
    h.graphContinue.mockResolvedValue({
      ...graphWire(),
      ...patch,
    } as unknown as RelatedScenesGraphWaitResponse);
    const response = await fetchHybrid(seeded());
    expect(response.graphOutcome).toBe("graph-unavailable:failed");
    expect(response).not.toHaveProperty("graph");
  });

  it("reports a rejected Graph wait as failed and a rejected settle does not break the result", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    h.graphContinue.mockRejectedValue(new Error("private transport"));
    h.graphSettle.mockRejectedValue(new Error("private settle"));
    const response = await fetchHybrid(seeded());
    expect(response.graphOutcome).toBe("graph-unavailable:failed");
    expect(response.status).toBe("completed");
    expect(JSON.stringify(response.result)).not.toContain("private");
  });

  describe("the Operation is released only after the Graph declaration", () => {
    const emptyIr = () =>
      h.continue.mockResolvedValue({
        status: "available",
        queryBinding: "query-a",
        scenes: [],
      });

    it("holds the Operation while a Graph-only row is held", async () => {
      h.begin.mockResolvedValue(pendingBegin());
      emptyIr();
      h.graphContinue.mockResolvedValue(graphWire({ graphOnly: graphOnlyRow }));
      const response = await fetchHybrid(seeded());
      expect(response.result.kind).toBe("raw");
      expect(response.graph?.graphOnly?.sceneId).toBe("g");
      await drain();
      expect(h.release).not.toHaveBeenCalled();
      expect(response.session?.retain()).not.toBeNull();
    });

    it("releases a raw result without a Graph-only row, after the settle reached Native", async () => {
      h.begin.mockResolvedValue(pendingBegin());
      emptyIr();
      h.graphContinue.mockResolvedValue(graphWire());
      const settle = deferred<{ status: "settled" }>();
      h.graphSettle.mockReturnValue(settle.promise);
      const response = await fetchHybrid(seeded());
      expect(response.result.kind).toBe("raw");
      await drain();
      expect(h.graphSettle).toHaveBeenCalledExactlyOnceWith("ticket-a", "used");
      expect(h.release).not.toHaveBeenCalled();
      settle.resolve({ status: "settled" });
      await drain();
      expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
      expect(h.graphSettle.mock.invocationCallOrder[0]).toBeLessThan(
        h.release.mock.invocationCallOrder[0],
      );
    });

    it("still releases after a rejected settle", async () => {
      h.begin.mockResolvedValue(pendingBegin());
      emptyIr();
      h.graphContinue.mockResolvedValue(graphWire());
      h.graphSettle.mockRejectedValue(new Error("private"));
      await fetchHybrid(seeded());
      await drain();
      expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
    });
  });
});
// K6/4 の批准 12（DR-WF-2〜4）：契機が `graph-ready` の query の合流にだけ W_f を渡し、
// 契機の印と渡した窓の値を `timing` に出す。
describe("follow-up の子の Graph の窓と timing の印（K6/4 の批准 12）", () => {
  const child = () => ({
    ...seeded(),
    refreshTrigger: "graph-ready" as const,
  });

  it("子は D の後、W_f の内に届いた Graph で公開し、印と W_f を timing に出す", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    const graph = deferred<RelatedScenesGraphWaitResponse>();
    h.graphContinue.mockReturnValue(graph.promise);
    let returned = false;
    const pending = fetchHybrid(child()).then((value) => {
      returned = true;
      return value;
    });
    await drain();
    h.now = 120;
    await vi.advanceTimersByTimeAsync(20);
    expect(returned).toBe(false);
    expect(h.graphSettle).not.toHaveBeenCalled();
    h.now = 150;
    graph.resolve(graphWire());
    const response = await pending;
    expect(response.graphOutcome).toBe("graph-ready");
    expect(response.graph?.pathAttachments).toEqual(
      graphWire().pathAttachments,
    );
    expect(response.result.kind).toBe("fused");
    expect(response.timing.refreshTrigger).toBe("graph-ready");
    expect(response.timing.graphWindowMs).toBe(
      RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS,
    );
    expect(h.graphSettle).toHaveBeenCalledExactlyOnceWith("ticket-a", "used");
  });

  it("子は W_f の満了で graph-late を公開し、その後の Graph を混ぜない", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    const graph = deferred<RelatedScenesGraphWaitResponse>();
    h.graphContinue.mockReturnValue(graph.promise);
    const pending = fetchHybrid(child());
    await drain();
    h.now = 200;
    await vi.advanceTimersByTimeAsync(200);
    const response = await pending;
    expect(response.graphOutcome).toBe("graph-late");
    expect(response).not.toHaveProperty("graph");
    expect(response.timing.graphWindowMs).toBe(
      RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS,
    );
    expect(h.graphSettle).toHaveBeenCalledExactlyOnceWith("ticket-a", "unused");
    graph.resolve(graphWire());
    await drain();
    expect(response).not.toHaveProperty("graph");
    expect(h.graphSettle).toHaveBeenCalledOnce();
  });

  it("契機の無い query は D のままで、印は null、窓は D", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    const graph = deferred<RelatedScenesGraphWaitResponse>();
    h.graphContinue.mockReturnValue(graph.promise);
    const pending = fetchHybrid(seeded());
    await drain();
    h.now = 120;
    await vi.advanceTimersByTimeAsync(20);
    const response = await pending;
    expect(response.graphOutcome).toBe("graph-late");
    expect(response.timing.refreshTrigger).toBeNull();
    expect(response.timing.graphWindowMs).toBe(RELATED_SCENES_IR_EXTRA_WAIT_MS);
  });

  it("子の IR の deadline は D のまま：IR が来なければ D で IR の timeout", async () => {
    h.begin.mockResolvedValue(pendingBegin());
    h.continue.mockReturnValue(new Promise(() => {}));
    h.graphContinue.mockReturnValue(new Promise(() => {}));
    const pending = fetchHybrid(child());
    await drain();
    h.now = 120;
    await vi.advanceTimersByTimeAsync(20);
    const response = await pending;
    expect(response.result).toMatchObject({
      kind: "raw",
      ir: { status: "unavailable", reason: "timeout" },
    });
    expect(response.completion?.outcome).toBe("timeout");
    expect(h.graphSettle).toHaveBeenCalledExactlyOnceWith("ticket-a", "unused");
  });

  it("Graph の合流が無い query は窓を null にし、印はそのまま出す（begin の unavailable は合流を通る）", async () => {
    const unseeded = await fetchHybrid({ refreshTrigger: "graph-ready" });
    expect(unseeded.timing.refreshTrigger).toBe("graph-ready");
    expect(unseeded.timing.graphWindowMs).toBeNull();
    h.begin.mockResolvedValue({
      ...beginResponse(),
      graph: { status: "unavailable", reason: "not-activated" },
    });
    // begin で Graph が unavailable の子も合流は通る（窓は W_f のまま、待たずに公開）。
    const unavailable = await fetchHybrid(child());
    expect(unavailable.graphOutcome).toBe("graph-unavailable:not-activated");
    expect(unavailable.timing.graphWindowMs).toBe(
      RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS,
    );
    h.begin.mockResolvedValue(beginResponse());
    const plain = await fetchHybrid();
    expect(plain.timing.refreshTrigger).toBeNull();
    expect(plain.timing.graphWindowMs).toBeNull();
  });
});
