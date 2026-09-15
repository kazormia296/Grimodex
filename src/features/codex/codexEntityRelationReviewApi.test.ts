import { beforeEach, describe, expect, it, vi } from "vitest";

const captureBindingMock = vi.hoisted(() => vi.fn());
const listRunsMock = vi.hoisted(() => vi.fn());
const prepareNativeMock = vi.hoisted(() => vi.fn());
const readCurrentMock = vi.hoisted(() => vi.fn());
const runAuthoritativeMutationMock = vi.hoisted(() => vi.fn());

vi.mock("@/application/narrative-extraction/nativeApi", () => ({
  captureNarrativeExtractionWorkspaceBinding: captureBindingMock,
  narrativeExtractionListResumableRuns: listRunsMock,
}));
vi.mock("@/features/concurrency/mutationAuthority", () => ({
  runAuthoritativeMutation: runAuthoritativeMutationMock,
}));
vi.mock(
  "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi",
  () => ({
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH: "nir1/entity-relation-review",
    prepareNir1EntityRelationRevision: prepareNativeMock,
    readCurrentNir1EntityRelationRevision: readCurrentMock,
  }),
);

import {
  prepareCodexEntityRelationReview,
  restoreCodexEntityRelationReview,
} from "./codexEntityRelationReviewApi";

const authority = {
  projectId: "p1",
  currentProjectId: () => "p1",
  workspacePath: "/w",
  workspaceOpenRevision: 3,
} as const;

describe("direct Option B Entity/Relation preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureBindingMock.mockResolvedValue({
      authorityId: "authority-1",
      generation: 3,
      authorityInstanceId: "3",
    });
    runAuthoritativeMutationMock.mockImplementation(
      async (_authority: unknown, mutation: () => Promise<unknown>) => ({
        status: "current",
        value: await mutation(),
      }),
    );
    prepareNativeMock.mockResolvedValue({
      runId: "typed-run",
      status: "draft",
      receipt: {
        proposalSetId: "set-1",
        proposalId: "proposal-1",
        revisionId: "revision-1",
        status: "unreviewed",
      },
    });
  });

  it("captures authority and calls only the dedicated Native prepare", async () => {
    await prepareCodexEntityRelationReview({
      projectId: "p1",
      workspacePath: "/w",
      authority,
      sceneId: "scene-1",
      entityIds: ["entry-1"],
      relationIds: ["relation-1"],
      proposalKey: "codex-ui:p1",
    });

    expect(captureBindingMock).toHaveBeenCalledExactlyOnceWith("/w");
    expect(prepareNativeMock).toHaveBeenCalledExactlyOnceWith(
      {
        projectId: "p1",
        sceneId: "scene-1",
        entityIds: ["entry-1"],
        relationIds: ["relation-1"],
        proposalKey: "codex-ui:p1",
      },
      {
        authorityId: "authority-1",
        generation: 3,
        authorityInstanceId: "3",
      },
    );
  });

  it("fails closed before Native when the project binding does not match", async () => {
    await expect(
      prepareCodexEntityRelationReview({
        projectId: "p2",
        workspacePath: "/w",
        authority,
        sceneId: "scene-1",
        entityIds: ["entry-1"],
        relationIds: [],
        proposalKey: "codex-ui:p2",
      }),
    ).rejects.toThrow("NEX_CHRONICLE_WORKSPACE_BINDING_INVALID");
    expect(captureBindingMock).not.toHaveBeenCalled();
    expect(prepareNativeMock).not.toHaveBeenCalled();
  });

  it("restores through the typed resumable summary and current reader only", async () => {
    listRunsMock.mockResolvedValue([
      {
        runId: "typed-run",
        projectId: "p1",
        surfacePathId: "nir1/entity-relation-review",
        status: "completed",
        snapshotDigest: null,
        createdAt: "2026-01-01T00:00:00Z",
        startedAt: null,
        completedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    readCurrentMock.mockResolvedValue({
      status: "available",
      result: { revisionId: "revision-1" },
    });

    await expect(
      restoreCodexEntityRelationReview("p1", "/w"),
    ).resolves.toMatchObject({
      runId: "typed-run",
      response: { status: "available" },
    });
    expect(listRunsMock).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      surfacePathId: "nir1/entity-relation-review",
      limit: 8,
    });
    expect(readCurrentMock).toHaveBeenCalledExactlyOnceWith({
      expectedWorkspacePath: "/w",
      projectId: "p1",
      runId: "typed-run",
    });
  });
});
