import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RelatedScenesBeginResponse,
  RelatedScenesContinueResponse,
} from "@/../electron/shared/relatedScenesSearchWire";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import type { SemanticSearchHit } from "@/features/semantic-search/api";
import type { Nir1AdmittedScene } from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";

const h = vi.hoisted(() => ({
  load: vi.fn(),
  semantic: vi.fn(),
  sparse: vi.fn(),
  begin: vi.fn(),
  continue: vi.fn(),
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
