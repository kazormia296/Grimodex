// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  useProjectStore,
  getCurrentProjectId,
} from "@/features/project/projectStore";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";

const ports = vi.hoisted(() => ({ blocked: false }));
vi.mock("@/features/editor/editorNavigationPorts", async () => {
  const { useTreeStore } = await import("@/features/tree/treeStore");
  return {
    defaultEditorNavigationPorts: {
      tabs: { openPinned: vi.fn() },
      layout: { showEditor: vi.fn() },
      tree: {
        setActiveScene: (id: string) =>
          useTreeStore.getState().setActiveScene(id),
      },
      isNavigationBlocked: () => ports.blocked,
    },
  };
});
vi.mock("./nir1RelatedScenesApi", () => ({ qualifyNir1Evidence: vi.fn() }));
import { qualifyNir1Evidence } from "./nir1RelatedScenesApi";
import {
  cancelNir1EvidenceNavigation,
  claimNir1EvidenceNavigation,
  hasPendingNir1EvidenceNavigation,
  observeNir1RelatedScenesQuery,
  requestNir1EvidenceNavigation,
} from "./nir1EvidenceNavigation";

const qualified = {
  status: "qualified" as const,
  bindingKey: "evidence",
  queryBinding: "query",
  sceneId: "s1",
  sourceVersion: 1,
  storageDigest: "sha256:storage",
  canonicalTextDigest: "sha256:text",
  normalizerVersion: "normalizer",
  fullQuote: "full quote",
  canonicalRange: { start: 0, end: 10 },
};
function fetchResult() {
  let active = true;
  const release = vi.fn(() => {
    active = false;
  });
  const session = {
    isActive: () => true,
    retain: () => ({ isActive: () => active, release }),
    subscribeInvalidation: () => () => {},
  } as unknown as Nir1RelatedScenesSession;
  const fetch = {
    origin: {
      workspacePath: "/test/novel",
      openRevision: 1,
      projectId: getCurrentProjectId(),
      querySceneId: "s2",
      queryGeneration: 7,
    },
    queryBinding: "query",
    session,
  } as Nir1RelatedScenesFetchResult;
  return { fetch, release };
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.blocked = false;
  setCurrentWorkspaceIdentity({ path: "/test/novel", openRevision: 1 });
  useProjectStore.setState({ currentProjectId: "project" });
  useTreeStore.setState({
    activeSceneId: "s2",
    nodes: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
  } as never);
  vi.mocked(qualifyNir1Evidence).mockResolvedValue(qualified);
});
afterEach(() => cancelNir1EvidenceNavigation());

describe("NIR Evidence request lifetime", () => {
  it("revokes a claimed selection when navigation returns from S1 to the original S2", async () => {
    const f = fetchResult();
    expect(await requestNir1EvidenceNavigation(f.fetch, "s1", "evidence")).toBe(
      true,
    );
    const claim = claimNir1EvidenceNavigation("s1");
    expect(claim?.isCurrent()).toBe(true);
    useTreeStore.setState({ activeSceneId: "s2" });
    expect(claim?.isCurrent()).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("qualifies before opening and retains the original S2 ticket through its own S1 query", async () => {
    const f = fetchResult();
    let resolve!: (value: typeof qualified) => void;
    vi.mocked(qualifyNir1Evidence).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const requested = requestNir1EvidenceNavigation(f.fetch, "s1", "evidence");
    expect(useTreeStore.getState().activeSceneId).toBe("s2");
    resolve(qualified);
    expect(await requested).toBe(true);
    expect(useTreeStore.getState().activeSceneId).toBe("s1");
    observeNir1RelatedScenesQuery("s1");
    expect(hasPendingNir1EvidenceNavigation("s1")).toBe(true);
    const claim = claimNir1EvidenceNavigation("s1");
    expect(claim?.isCurrent()).toBe(true);
    expect(claimNir1EvidenceNavigation("s1")).toBeNull();
    expect(f.release).not.toHaveBeenCalled();
    claim?.finish();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["scene", "workspace", "query"])(
    "cancels a pending qualification on unrelated %s change",
    async (kind) => {
      const f = fetchResult();
      let resolve!: (value: typeof qualified) => void;
      vi.mocked(qualifyNir1Evidence).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const requested = requestNir1EvidenceNavigation(
        f.fetch,
        "s1",
        "evidence",
      );
      if (kind === "scene") useTreeStore.setState({ activeSceneId: "s3" });
      else if (kind === "workspace")
        setCurrentWorkspaceIdentity({ path: "/test/novel", openRevision: 2 });
      else observeNir1RelatedScenesQuery("s2");
      resolve(qualified);
      expect(await requested).toBe(false);
      expect(f.release).toHaveBeenCalledOnce();
      expect(useTreeStore.getState().activeSceneId).not.toBe("s1");
    },
  );

  it("releases a retained ticket when the existing editor navigation gate blocks the request", async () => {
    ports.blocked = true;
    const f = fetchResult();
    expect(await requestNir1EvidenceNavigation(f.fetch, "s1", "evidence")).toBe(
      false,
    );
    expect(useTreeStore.getState().activeSceneId).toBe("s2");
    expect(f.release).toHaveBeenCalledOnce();
    expect(hasPendingNir1EvidenceNavigation("s1")).toBe(false);
  });
});
