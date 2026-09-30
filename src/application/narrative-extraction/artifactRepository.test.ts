import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

const getRunReviewBundleMock = vi.hoisted(() => vi.fn());

vi.mock("./nativeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nativeApi")>();
  return {
    ...actual,
    narrativeExtractionGetRunReviewBundle: getRunReviewBundleMock,
  };
});

import {
  buildInlineJsonArtifact,
  hydrateInlineArtifactsFromNative,
  listInlineJsonArtifacts,
  loadInlineJsonArtifact,
  rememberInlineJsonArtifact,
  resetNarrativeArtifactIndexForTests,
} from "./artifactRepository";

const SCOPE_A = {
  projectId: "project-cache",
  workspacePath: "/workspace/cache-a",
  workspaceOpenRevision: 3,
} as const;

const SCOPE_B = {
  projectId: "project-cache",
  workspacePath: "/workspace/cache-b",
  workspaceOpenRevision: 1,
} as const;

function emptyBundle(runId: string) {
  return {
    runId,
    projectId: "project-cache",
    artifacts: [],
    stageReceipts: [],
    proposalSet: null,
    proposals: [],
  };
}

describe("narrative extraction artifact cache isolation", () => {
  beforeEach(() => {
    setCurrentWorkspaceIdentity({
      path: SCOPE_A.workspacePath,
      openRevision: SCOPE_A.workspaceOpenRevision,
    });
    resetNarrativeArtifactIndexForTests();
    getRunReviewBundleMock.mockReset();
  });

  afterEach(() => {
    setCurrentWorkspaceIdentity(null);
  });

  it("clones local artifact JSON on write and every cache read", async () => {
    const draft = buildInlineJsonArtifact("test.artifact@1", {
      nested: { value: "sealed" },
    });
    rememberInlineJsonArtifact({
      runId: "run-cache-local",
      taskId: "task-cache-local",
      attemptId: "attempt-cache-local",
      scope: SCOPE_A,
      draft,
    });

    // A producer retaining the draft cannot alter the cache entry after task
    // terminalization.
    (draft.payloadJson.nested as { value: string }).value = "mutated-draft";
    const first = await loadInlineJsonArtifact<{
      nested: { value: string };
    }>("run-cache-local", "test.artifact@1", { scope: SCOPE_A });
    expect(first?.nested.value).toBe("sealed");

    // Nor can a consumer mutate a returned payload or a listed artifact and
    // affect a later Stage's durable-prefix input.
    if (!first) throw new Error("expected local artifact");
    first.nested.value = "mutated-read";
    const listed = listInlineJsonArtifacts("run-cache-local", SCOPE_A);
    (listed[0]?.payloadJson as { nested: { value: string } }).nested.value =
      "mutated-list";
    const second = await loadInlineJsonArtifact<{
      nested: { value: string };
    }>("run-cache-local", "test.artifact@1", { scope: SCOPE_A });
    expect(second?.nested.value).toBe("sealed");
  });

  it("does not share hydrated bundle or artifact references across callers", async () => {
    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-cache-hydrated",
      projectId: "project-cache",
      artifacts: [
        {
          artifactId: "artifact-hydrated",
          runId: "run-cache-hydrated",
          taskId: "task-hydrated",
          attemptId: "attempt-hydrated",
          artifactKind: "test.hydrated@1",
          payloadStorage: "inline-json",
          payloadJson: { nested: { value: "sealed" } },
          payloadRef: null,
          payloadDigest: "sha256:fixture",
          createdAt: "2026-08-26T00:00:00.000Z",
        },
      ],
      stageReceipts: [],
      proposalSet: null,
      proposals: [],
    });

    const [first, second] = await Promise.all([
      hydrateInlineArtifactsFromNative({
        runId: "run-cache-hydrated",
        scope: SCOPE_A,
      }),
      hydrateInlineArtifactsFromNative({
        runId: "run-cache-hydrated",
        scope: SCOPE_A,
      }),
    ]);
    expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);
    const firstPayload = first.artifacts[0]?.payloadJson as {
      nested: { value: string };
    };
    firstPayload.nested.value = "mutated-first-caller";
    expect(
      (second.artifacts[0]?.payloadJson as { nested: { value: string } }).nested
        .value,
    ).toBe("sealed");

    const cached = await loadInlineJsonArtifact<{
      nested: { value: string };
    }>("run-cache-hydrated", "test.hydrated@1", {
      scope: SCOPE_A,
      requireNativeConfirmation: true,
    });
    expect(cached?.nested.value).toBe("sealed");
  });

  it("clears a scoped Run before Native hydration so a missing durable artifact cannot fall back to cache", async () => {
    const stale = buildInlineJsonArtifact("test.rollback@1", {
      value: "draft-that-never-committed",
    });
    rememberInlineJsonArtifact({
      runId: "run-rollback",
      taskId: "task-rollback",
      attemptId: "attempt-rollback",
      scope: SCOPE_A,
      draft: stale,
    });
    getRunReviewBundleMock.mockResolvedValue(emptyBundle("run-rollback"));

    await expect(
      loadInlineJsonArtifact("run-rollback", "test.rollback@1", {
        scope: SCOPE_A,
        requireNativeConfirmation: true,
      }),
    ).resolves.toBeNull();
    expect(listInlineJsonArtifacts("run-rollback", SCOPE_A)).toEqual([]);
  });

  it("does not borrow the same Run id from another workspace clone", async () => {
    const workspaceA = buildInlineJsonArtifact("test.clone@1", {
      value: "workspace-a-only",
    });
    rememberInlineJsonArtifact({
      runId: "run-shared-id",
      taskId: "task-a",
      attemptId: "attempt-a",
      scope: SCOPE_A,
      draft: workspaceA,
    });
    getRunReviewBundleMock.mockResolvedValue(emptyBundle("run-shared-id"));
    setCurrentWorkspaceIdentity({
      path: SCOPE_B.workspacePath,
      openRevision: SCOPE_B.workspaceOpenRevision,
    });

    const fromCloneB = await loadInlineJsonArtifact<{ value: string }>(
      "run-shared-id",
      "test.clone@1",
      { scope: SCOPE_B, requireNativeConfirmation: true },
    );

    expect(fromCloneB).toBeNull();
    expect(listInlineJsonArtifacts("run-shared-id", SCOPE_B)).toEqual([]);
    setCurrentWorkspaceIdentity({
      path: SCOPE_A.workspacePath,
      openRevision: SCOPE_A.workspaceOpenRevision,
    });
    expect(listInlineJsonArtifacts("run-shared-id", SCOPE_A)).toHaveLength(1);
  });

  it("coalesces only within one workspace scope and keeps clone hydrations isolated", async () => {
    getRunReviewBundleMock
      .mockResolvedValueOnce(emptyBundle("run-coalesced-clone"))
      .mockResolvedValueOnce(emptyBundle("run-coalesced-clone"));

    await hydrateInlineArtifactsFromNative({
      runId: "run-coalesced-clone",
      scope: SCOPE_A,
    });
    setCurrentWorkspaceIdentity({
      path: SCOPE_B.workspacePath,
      openRevision: SCOPE_B.workspaceOpenRevision,
    });
    await hydrateInlineArtifactsFromNative({
      runId: "run-coalesced-clone",
      scope: SCOPE_B,
    });

    expect(getRunReviewBundleMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a Native hydrate whose workspace authority changes while IPC is in flight", async () => {
    let resolveBundle!: (value: ReturnType<typeof emptyBundle>) => void;
    getRunReviewBundleMock.mockReturnValue(
      new Promise((resolve) => {
        resolveBundle = resolve;
      }),
    );
    setCurrentWorkspaceIdentity({
      path: SCOPE_A.workspacePath,
      openRevision: SCOPE_A.workspaceOpenRevision,
    });

    const pending = hydrateInlineArtifactsFromNative({
      runId: "run-authority-race",
      scope: SCOPE_A,
    });
    setCurrentWorkspaceIdentity({
      path: SCOPE_B.workspacePath,
      openRevision: SCOPE_B.workspaceOpenRevision,
    });
    resolveBundle(emptyBundle("run-authority-race"));

    await expect(pending).rejects.toThrow("NEX_ARTIFACT_CACHE_AUTHORITY_STALE");
    setCurrentWorkspaceIdentity({
      path: SCOPE_A.workspacePath,
      openRevision: SCOPE_A.workspaceOpenRevision,
    });
    expect(listInlineJsonArtifacts("run-authority-race", SCOPE_A)).toEqual([]);
  });

  it("rejects a workspace-scoped read after active authority is withdrawn", async () => {
    setCurrentWorkspaceIdentity(null);

    await expect(
      loadInlineJsonArtifact("run-authority-withdrawn", "test.withdrawn@1", {
        scope: SCOPE_A,
        requireNativeConfirmation: true,
      }),
    ).rejects.toThrow("NEX_ARTIFACT_CACHE_AUTHORITY_STALE");
    expect(getRunReviewBundleMock).not.toHaveBeenCalled();

    setCurrentWorkspaceIdentity({
      path: SCOPE_A.workspacePath,
      openRevision: SCOPE_A.workspaceOpenRevision,
    });
    expect(listInlineJsonArtifacts("run-authority-withdrawn", SCOPE_A)).toEqual(
      [],
    );
  });

  it("rejects a Native hydrate when active authority is withdrawn during IPC", async () => {
    let resolveBundle!: (value: ReturnType<typeof emptyBundle>) => void;
    getRunReviewBundleMock.mockReturnValue(
      new Promise((resolve) => {
        resolveBundle = resolve;
      }),
    );

    const pending = hydrateInlineArtifactsFromNative({
      runId: "run-authority-withdrawn-race",
      scope: SCOPE_A,
    });
    setCurrentWorkspaceIdentity(null);
    resolveBundle(emptyBundle("run-authority-withdrawn-race"));

    await expect(pending).rejects.toThrow("NEX_ARTIFACT_CACHE_AUTHORITY_STALE");
    setCurrentWorkspaceIdentity({
      path: SCOPE_A.workspacePath,
      openRevision: SCOPE_A.workspaceOpenRevision,
    });
    expect(
      listInlineJsonArtifacts("run-authority-withdrawn-race", SCOPE_A),
    ).toEqual([]);
  });
});
