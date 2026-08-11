import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareMock = vi.hoisted(() => vi.fn());
const applyMock = vi.hoisted(() => vi.fn());
const statusMock = vi.hoisted(() => vi.fn());

vi.mock("./nativeApi", () => ({
  narrativeExtractionPrepareCommit: prepareMock,
  narrativeExtractionApplyCommit: applyMock,
  narrativeExtractionGetCommitStatus: statusMock,
  narrativeExtractionUndoCommit: vi.fn(),
  narrativeExtractionRedoCommit: vi.fn(),
}));

vi.mock("./commitCoordinator", () => ({
  computePlanDigest: vi.fn(async () => "digest-fixed"),
}));

import { prepareAndApplyCodexCommit } from "./codexCommitCoordinator";

const baseInput = {
  projectId: "p1",
  runId: "run-1",
  proposalSetId: "set-1",
  requestId: "req-1",
  sessionId: "sess-1",
  operations: [
    {
      operation: {
        kind: "codex.entry.create" as const,
        payload: {
          entryId: "entry-1",
          typeSlug: "character",
          name: "ライカ",
          summary: null,
          aliases: [] as const,
          parentId: null,
          content: '{"type":"doc","content":[]}' as const,
          narrativeEntityId: "ne-1",
        },
      },
      proposalId: "prop-1",
      revisionId: "rev-1",
    },
  ],
};

describe("prepareAndApplyCodexCommit status-first retry", () => {
  beforeEach(() => {
    prepareMock.mockReset();
    applyMock.mockReset();
    statusMock.mockReset();
  });

  it("returns stored receipt without prepare when request already applied", async () => {
    const receipt = {
      commitId: "commit-1",
      requestId: "req-1",
      planDigest: "digest-fixed",
      status: "applied",
      created: [{ entityId: "entry-1" }],
    };
    statusMock.mockResolvedValue({
      found: true,
      commitId: "commit-1",
      requestId: "req-1",
      planDigest: "digest-fixed",
      status: "applied",
      receipt,
    });

    const result = await prepareAndApplyCodexCommit(baseInput);

    expect(prepareMock).not.toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
    expect(result.applied.idempotentReplay).toBe(true);
    expect(result.applied.commitId).toBe("commit-1");
    expect(result.status.found).toBe(true);
  });

  it("runs prepare→apply when status is not found", async () => {
    statusMock.mockResolvedValueOnce({ found: false }).mockResolvedValueOnce({
      found: true,
      status: "applied",
      commitId: "commit-2",
      requestId: "req-1",
      planDigest: "digest-fixed",
    });
    prepareMock.mockResolvedValue({
      ok: true,
      requestId: "req-1",
      planDigest: "digest-fixed",
      operationCount: 1,
    });
    applyMock.mockResolvedValue({
      commitId: "commit-2",
      requestId: "req-1",
      planDigest: "digest-fixed",
      status: "applied",
    });

    const result = await prepareAndApplyCodexCommit(baseInput);

    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(result.applied.commitId).toBe("commit-2");
  });

  it("rejects when prior commit failed for the same requestId", async () => {
    statusMock.mockResolvedValue({
      found: true,
      status: "failed",
      errorMessage: "NEX_CODEX_SELF_RELATION",
      planDigest: "digest-fixed",
    });

    await expect(prepareAndApplyCodexCommit(baseInput)).rejects.toThrow(
      /NEX_CODEX_SELF_RELATION/,
    );
    expect(prepareMock).not.toHaveBeenCalled();
  });
});
