// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";

const restoreMock = vi.hoisted(() => vi.fn());
const prepareMock = vi.hoisted(() => vi.fn());
const replacementInputMock = vi.hoisted(() => vi.fn());
const decideMock = vi.hoisted(() => vi.fn());
const readCurrentMock = vi.hoisted(() => vi.fn());

vi.mock("./codexEntityRelationReviewApi", () => ({
  prepareCodexEntityRelationReview: prepareMock,
  replacementPrepareInput: replacementInputMock,
  restoreCodexEntityRelationReview: restoreMock,
}));
vi.mock(
  "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi",
  () => ({
    decideNir1EntityRelationRevision: decideMock,
    readCurrentNir1EntityRelationRevision: readCurrentMock,
  }),
);

import { useCodexEntityRelationReview } from "./useCodexEntityRelationReview";

function typedResult() {
  return {
    projectId: "p1",
    runId: "typed-run",
    proposalId: "typed-proposal",
    revisionId: "typed-revision",
    proposalSetId: "typed-set",
    sceneId: "scene-1",
    entities: [
      {
        entityId: "entry-1",
        entityType: "character",
        label: "Entry 1",
        evidence: [],
      },
    ],
    relations: [
      {
        edgeId: "relation-1",
        fromEntityId: "entry-1",
        toEntityId: "entry-2",
        relationType: "knows",
        directionality: "directed",
        evidenceIds: [],
      },
    ],
  } as never;
}

function typedPrepareResult(runId = "typed-run") {
  return {
    runId,
    status: "draft" as const,
    receipt: {
      proposalSetId: `${runId}-set`,
      proposalId: `${runId}-proposal`,
      revisionId: `${runId}-revision`,
      status: "unreviewed" as const,
    },
  };
}

function resetScope() {
  useProjectStore.setState({ currentProjectId: "p1" });
  useWorkspaceStore.setState({
    activeWorkspacePath: "/w",
    workspaceOpenRevision: 1,
  });
  setCurrentWorkspaceIdentity({ path: "/w", openRevision: 1 });
}

function prepareArgs() {
  return {
    projectId: "p1",
    workspacePath: "/w",
    authority: {
      projectId: "p1",
      currentProjectId: () => "p1",
      workspacePath: "/w",
      workspaceOpenRevision: 1,
    },
    sceneId: "scene-1",
    entityIds: ["entry-1"],
    relationIds: ["relation-1"],
    proposalKey: "codex-ui:p1:scene-1:entry-1:relation-1",
  } as const;
}

describe("useCodexEntityRelationReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetScope();
    restoreMock.mockResolvedValue(null);
    decideMock.mockResolvedValue({ status: "approved" });
  });

  it("shares one direct Native prepare across concurrent calls", async () => {
    let resolvePrepare!: (value: unknown) => void;
    prepareMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    readCurrentMock.mockResolvedValue({
      status: "unavailable",
      result: { reason: "current-read-failed" },
    });
    const { result } = renderHook(() => useCodexEntityRelationReview(true));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.prepareTypedReview(prepareArgs());
      second = result.current.prepareTypedReview(prepareArgs());
    });
    expect(prepareMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePrepare(typedPrepareResult());
      await Promise.all([first, second]);
    });

    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: "p1",
      workspacePath: "/w",
      sceneId: "scene-1",
      entityIds: ["entry-1"],
      relationIds: ["relation-1"],
      proposalKey: "codex-ui:p1:scene-1:entry-1:relation-1",
    });
    expect(result.current.typedReview).toMatchObject({
      runId: "typed-run",
      status: "unavailable",
      receipt: typedPrepareResult().receipt,
    });
  });

  it("passes the launcher Entity and Relation target to warm restore", async () => {
    renderHook(() =>
      useCodexEntityRelationReview(true, {
        entityId: "entry-2",
        relationId: "relation-2",
      }),
    );

    await waitFor(() =>
      expect(restoreMock).toHaveBeenCalledExactlyOnceWith("p1", "/w", {
        entityId: "entry-2",
        relationId: "relation-2",
      }),
    );
  });

  it("prepares a new revision after an unavailable cold restore with no result", async () => {
    restoreMock.mockResolvedValue({
      runId: "old-typed-run",
      response: {
        status: "unavailable",
        result: { reason: "revision-restore-invalidated" },
      },
    });
    prepareMock.mockResolvedValue(typedPrepareResult("new-typed-run"));
    readCurrentMock.mockRejectedValue(new Error("D2A publication denied"));
    const { result } = renderHook(() => useCodexEntityRelationReview(true));

    await waitFor(() =>
      expect(result.current.typedReview).toMatchObject({
        runId: "old-typed-run",
        status: "unavailable",
        result: null,
        unavailableReason: "revision-restore-invalidated",
      }),
    );

    await act(async () => {
      await result.current.prepareTypedReview({
        ...prepareArgs(),
        proposalKey: "codex-ui:p1:new-revision",
      });
    });

    expect(prepareMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        proposalKey: "codex-ui:p1:new-revision",
      }),
    );
    expect(result.current.typedReview).toMatchObject({
      runId: "new-typed-run",
      status: "unavailable",
      result: null,
      receipt: typedPrepareResult("new-typed-run").receipt,
    });
  });

  it("exposes an initial Prepare rejection and allows an intentional retry", async () => {
    prepareMock
      .mockRejectedValueOnce(new Error("Native prepare rejected"))
      .mockResolvedValueOnce(typedPrepareResult("retried-typed-run"));
    readCurrentMock.mockResolvedValue({
      status: "unavailable",
      result: { reason: "typed-review-evidence-unavailable" },
    });
    const { result } = renderHook(() => useCodexEntityRelationReview(true));

    await act(async () => {
      await result.current.prepareTypedReview(prepareArgs());
    });
    expect(result.current.typedReview).toBeNull();
    expect(result.current.typedDecisionError).toBe("Native prepare rejected");
    expect(result.current.typedPrepareBusy).toBe(false);

    await act(async () => {
      await result.current.prepareTypedReview(prepareArgs());
    });
    expect(prepareMock).toHaveBeenCalledTimes(2);
    expect(result.current.typedDecisionError).toBeNull();
    expect(result.current.typedReview).toMatchObject({
      runId: "retried-typed-run",
      status: "unavailable",
    });
  });

  it("does not mint another Run for a re-entrant prepare with the same receipt key", async () => {
    prepareMock.mockResolvedValue(typedPrepareResult("stable-typed-run"));
    readCurrentMock.mockRejectedValue(new Error("current read unavailable"));
    const { result } = renderHook(() => useCodexEntityRelationReview(true));

    await act(async () => {
      await result.current.prepareTypedReview(prepareArgs());
      await result.current.prepareTypedReview(prepareArgs());
    });

    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(result.current.typedReview?.runId).toBe("stable-typed-run");
  });

  it("evicts a successful receipt when warm reopen restores that Run as unavailable", async () => {
    restoreMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      runId: "old-typed-run",
      response: {
        status: "unavailable",
        result: { reason: "revision-restore-invalidated" },
      },
    });
    prepareMock
      .mockResolvedValueOnce(typedPrepareResult("old-typed-run"))
      .mockResolvedValueOnce(typedPrepareResult("new-typed-run"));
    readCurrentMock.mockResolvedValue({
      status: "unavailable",
      result: { reason: "typed-review-evidence-unavailable" },
    });
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useCodexEntityRelationReview(open),
      { initialProps: { open: true } },
    );

    await act(async () => {
      await result.current.prepareTypedReview(prepareArgs());
    });
    expect(prepareMock).toHaveBeenCalledTimes(1);

    rerender({ open: false });
    rerender({ open: true });
    await waitFor(() =>
      expect(result.current.typedReview).toMatchObject({
        runId: "old-typed-run",
        status: "unavailable",
        result: null,
        unavailableReason: "revision-restore-invalidated",
      }),
    );

    await act(async () => {
      await result.current.prepareTypedReview(prepareArgs());
    });

    expect(prepareMock).toHaveBeenCalledTimes(2);
    expect(prepareMock.mock.calls[1]?.[0]).toMatchObject({
      projectId: "p1",
      workspacePath: "/w",
      sceneId: "scene-1",
      entityIds: ["entry-1"],
      relationIds: ["relation-1"],
      proposalKey: "codex-ui:p1:scene-1:entry-1:relation-1",
    });
    expect(result.current.typedReview?.runId).toBe("new-typed-run");
  });

  it("shares one replacement prepare across same-event-loop re-entry", async () => {
    restoreMock.mockResolvedValue({
      runId: "typed-run",
      response: { status: "draft", result: typedResult() },
    });
    decideMock.mockResolvedValue({ status: "approved" });
    readCurrentMock
      .mockRejectedValueOnce(new Error("egress denied"))
      .mockResolvedValue({
        status: "unavailable",
        result: { reason: "typed-review-evidence-unavailable" },
      });
    replacementInputMock.mockReturnValue({
      ...prepareArgs(),
      proposalKey: "codex-replacement:typed-run:typed-revision",
    });
    prepareMock.mockResolvedValue(typedPrepareResult("replacement-run"));
    const { result } = renderHook(() => useCodexEntityRelationReview(true));

    await waitFor(() =>
      expect(result.current.typedReview?.status).toBe("draft"),
    );
    await act(async () => {
      await result.current.handleTypedDecision("approved");
    });
    expect(result.current.typedReview).toMatchObject({
      runId: "typed-run",
      status: "unavailable",
      result: typedResult(),
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.replaceTypedReview();
      second = result.current.replaceTypedReview();
    });
    await act(async () => {
      await Promise.all([first, second]);
    });

    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: "p1",
      workspacePath: "/w",
      sceneId: "scene-1",
      entityIds: ["entry-1"],
      relationIds: ["relation-1"],
      proposalKey: "codex-replacement:typed-run:typed-revision",
    });
    expect(result.current.typedReview?.runId).toBe("replacement-run");
  });

  it("keeps the receipt and records an approved Decision when current-read fails", async () => {
    restoreMock.mockResolvedValue({
      runId: "typed-run",
      response: { status: "draft", result: typedResult() },
    });
    readCurrentMock.mockRejectedValueOnce(new Error("egress denied"));
    const { result } = renderHook(() => useCodexEntityRelationReview(true));
    await waitFor(() =>
      expect(result.current.typedReview?.status).toBe("draft"),
    );

    await act(async () => {
      await result.current.handleTypedDecision("approved");
    });

    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(result.current.typedReview).toMatchObject({
      runId: "typed-run",
      status: "unavailable",
      decision: "approved",
      unavailableReason: "typed-review-current-read-failed",
      receipt: {
        proposalSetId: "typed-set",
        proposalId: "typed-proposal",
        revisionId: "typed-revision",
        status: "unreviewed",
      },
    });
  });

  it("does not publish a late prepare after the dialog closes", async () => {
    let resolvePrepare!: (value: unknown) => void;
    prepareMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    const { result, unmount } = renderHook(() =>
      useCodexEntityRelationReview(true),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.prepareTypedReview(prepareArgs());
    });
    unmount();

    await act(async () => {
      resolvePrepare(typedPrepareResult());
      await pending;
    });
  });
});
