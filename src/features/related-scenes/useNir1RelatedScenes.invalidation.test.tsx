// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

const h = vi.hoisted(() => ({
  load: vi.fn(),
  semantic: vi.fn(),
  sparse: vi.fn(),
  begin: vi.fn(),
  continuation: vi.fn(),
  release: vi.fn(),
  invalidations: new Set<(binding: string) => void>(),
  workspace: { activeWorkspacePath: "/one", workspaceOpenRevision: 1 },
}));
vi.mock("@/features/tree/api", () => ({ loadSceneContent: h.load }));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p",
  getCurrentProjectLanguage: () => "ja",
  useProjectStore: (select: (state: unknown) => unknown) =>
    select({ currentProjectId: "p" }),
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (select: (state: typeof h.workspace) => unknown) =>
    select(h.workspace),
}));
vi.mock("@/features/semantic-search/api", () => ({
  semanticSearch: h.semantic,
}));
vi.mock("@/features/chat/semanticRecall", async (original) => ({
  ...(await original<typeof import("@/features/chat/semanticRecall")>()),
  fetchSparseSceneIds: h.sparse,
}));
vi.mock("./nir1EvidenceNavigation", () => ({
  observeNir1RelatedScenesQuery: vi.fn(),
}));
vi.mock("./nir1RelatedScenesApi", () => ({
  beginRelatedScenes: h.begin,
  continueRelatedScenes: h.continuation,
  releaseRelatedScenes: h.release,
  listenRelatedScenesIndexReady: async () => () => {},
  listenRelatedScenesInvalidations: async (
    receive: (binding: string) => void,
  ) => {
    h.invalidations.add(receive);
    return () => {
      h.invalidations.delete(receive);
    };
  },
}));
import { useNir1RelatedScenes } from "./useNir1RelatedScenes";

const doc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
const hit = (title: string) => ({
  sceneId: "s1",
  sceneTitle: title,
  chunkText: title,
  charStart: 0,
  charEnd: 3,
  score: 0.99,
  dialogueRatio: 0,
});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const revoke = () =>
  act(async () => {
    for (const receive of [...h.invalidations]) receive("query-old");
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.invalidations.clear();
  h.workspace.activeWorkspacePath = "/one";
  h.workspace.workspaceOpenRevision = 1;
  setCurrentWorkspaceIdentity({ path: "/one", openRevision: 1 });
  useTreeStore.setState({
    activeSceneId: "s2",
    nodes: ["s1", "s2", "s3"].map((id, i) => ({
      id,
      projectId: "p",
      parentId: null,
      nodeType: "scene",
      sortOrder: String(i),
      storyTimeOrder: String(i),
    })),
  } as never);
  usePhaseStore.setState({ resolutionMode: "reading" });
  h.load.mockResolvedValue(doc("検索前の保存本文"));
  h.sparse.mockResolvedValue([]);
  h.semantic.mockResolvedValue([hit("fresh Raw")]);
  h.begin.mockResolvedValue({
    status: "raw-ready",
    denseHits: [hit("stale Raw")],
    snapshot: {
      queryBinding: "query-old",
      originalSnapshotUsable: true,
      supportedProfile: true,
    },
    ir: { status: "pending", operationTicket: "ticket-old" },
  });
  h.continuation.mockImplementation(() => new Promise(() => {}));
  h.release.mockResolvedValue({ status: "released" });
});
afterEach(() => {
  cleanup();
  setCurrentWorkspaceIdentity(null);
  vi.useRealTimers();
});

describe("in-flight IR revocation recovers fresh Raw without Index-ready", () => {
  it.each(["workspace", "scene"] as const)(
    "keeps an original pending query cancelled after a %s change",
    async (change) => {
      const view = renderHook(() => useNir1RelatedScenes(true));
      await advance(0);
      await advance(400);
      expect(h.continuation).toHaveBeenCalledOnce();
      await act(async () => {
        if (change === "workspace") {
          h.workspace.activeWorkspacePath = "/two";
          h.workspace.workspaceOpenRevision++;
          setCurrentWorkspaceIdentity({ path: "/two", openRevision: 2 });
          view.rerender();
        } else useTreeStore.setState({ activeSceneId: "s3" });
      });
      await revoke();
      await advance(0);
      expect(view.result.current.fetch).toBeNull();
      expect(h.semantic).not.toHaveBeenCalled();
      expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-old");
    },
  );

  it("reloads the current saved body and publishes fresh Raw while old IR never completes", async () => {
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.continuation).toHaveBeenCalledOnce();
    expect(view.result.current.fetch).toBeNull();
    h.load.mockResolvedValue(doc("変更後の保存本文"));
    await revoke();
    await advance(400);
    expect(h.semantic).toHaveBeenCalledOnce();
    expect(h.semantic.mock.calls[0][0].query).toBe("変更後の保存本文");
    expect(h.begin).toHaveBeenCalledOnce();
    expect(view.result.current.fetch?.status).toBe("completed");
    expect(view.result.current.fetch?.result.scenes[0].sceneTitle).toBe(
      "fresh Raw",
    );
    expect(view.result.current.fetch?.session).toBeNull();
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-old");
  });

  it.each(["workspace", "scene"] as const)(
    "does not publish recovery Raw after a %s change",
    async (change) => {
      let finishRaw!: (value: ReturnType<typeof hit>[]) => void;
      h.semantic.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRaw = resolve;
          }),
      );
      const view = renderHook(() => useNir1RelatedScenes(true));
      await advance(0);
      await advance(400);
      await revoke();
      await advance(400);
      expect(h.semantic).toHaveBeenCalledOnce();
      await act(async () => {
        if (change === "workspace") {
          h.workspace.activeWorkspacePath = "/two";
          h.workspace.workspaceOpenRevision++;
          setCurrentWorkspaceIdentity({ path: "/two", openRevision: 2 });
          view.rerender();
        } else useTreeStore.setState({ activeSceneId: "s3" });
      });
      await act(async () => {
        finishRaw([hit("old workspace or S2 Raw")]);
      });
      expect(view.result.current.fetch).toBeNull();
    },
  );

  it("does not publish a Raw query whose saved body changed during retrieval", async () => {
    let finishRaw!: (value: ReturnType<typeof hit>[]) => void;
    h.semantic.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRaw = resolve;
        }),
    );
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await revoke();
    await advance(400);
    expect(h.semantic).toHaveBeenCalledOnce();
    h.load.mockResolvedValue(doc("再取得中に変更された本文"));
    await act(async () => {
      finishRaw([hit("old body Raw")]);
    });
    expect(view.result.current.fetch).toBeNull();
    h.semantic.mockResolvedValue([hit("current body Raw")]);
    await advance(400);
    expect(h.semantic.mock.lastCall?.[0].query).toBe(
      "再取得中に変更された本文",
    );
    expect(view.result.current.fetch?.result.scenes[0].sceneTitle).toBe(
      "current body Raw",
    );
  });
});
