import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyChronicleCommit,
  computePlanDigest,
  prepareAndApplyChronicleCommit,
} from "./commitCoordinator";
import type { CommitOperation } from "./nativeApi";

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

const sampleOp: CommitOperation = {
  kind: "chronicle.event.create",
  payload: { eventId: "e1" },
  proposalId: "p1",
  revisionId: "r1",
};

describe("computePlanDigest", () => {
  it("omits empty entityBindings so digests match pre-binding Chronicle plans", async () => {
    const without = await computePlanDigest([sampleOp], null);
    const withEmpty = await computePlanDigest([sampleOp], null, []);
    const withNull = await computePlanDigest([sampleOp], null, null);
    expect(without).toBe(withEmpty);
    expect(without).toBe(withNull);
    // Fixture from the pre-entityBindings canonical plan shape.
    expect(without).toBe(
      "21eae6ea2277cefe9feca7b65b57c6e7c61fa09ca629c6c082e0c6a7a356c4eb",
    );
  });

  it("includes entityBindings in the digest when provided", async () => {
    const base = await computePlanDigest([sampleOp], null);
    const withBindings = await computePlanDigest([sampleOp], null, [
      {
        narrativeEntityId: "ent:a",
        codexEntryId: "codex-a",
        source: "existing",
      },
    ]);
    expect(withBindings).not.toBe(base);
  });

  it("canonicalizes binding key order for stable digests", async () => {
    const a = await computePlanDigest([sampleOp], "tail-1", [
      { narrativeEntityId: "ent:b", codexEntryId: "b", source: "created" },
      { narrativeEntityId: "ent:a", codexEntryId: "a", source: "existing" },
    ]);
    const b = await computePlanDigest([sampleOp], "tail-1", [
      { narrativeEntityId: "ent:a", codexEntryId: "a", source: "existing" },
      { narrativeEntityId: "ent:b", codexEntryId: "b", source: "created" },
    ]);
    expect(a).toBe(b);
  });
});

describe("prepareAndApplyChronicleCommit", () => {
  beforeEach(() => {
    prepareMock.mockReset();
    applyMock.mockReset();
    statusMock.mockReset();
  });

  it("sends the full plan to prepare and only the prepared reference to apply", async () => {
    const input = {
      projectId: "project-1",
      runId: "run-1",
      proposalSetId: "set-1",
      requestId: "request-1",
      sessionId: "session-1",
      operations: [
        {
          operation: {
            kind: "chronicle.event.create" as const,
            payload: {
              eventId: "event-1",
              title: "Event",
              note: null,
              kind: "generic" as const,
              precision: "unknown" as const,
              placement: { mode: "append-tail" as const, afterOrdinal: null },
              secret: false,
              revealSceneId: "scene-1",
              evidenceSceneLinks: [],
              detail: null,
              primaryCodexId: null,
              locationCodexId: null,
              participants: [] as const,
              startTime: null,
              endTime: null,
              startGranularity: "none" as const,
              endGranularity: "none" as const,
            },
          },
          proposalId: "proposal-1",
          revisionId: "revision-1",
        },
      ],
    };
    prepareMock.mockResolvedValue({
      ok: true,
      preparedCommitId: "prepared-1",
      requestId: input.requestId,
      planDigest: "native-digest",
      operationCount: 1,
      version: 0,
    });
    applyMock.mockResolvedValue({
      commitId: "commit-1",
      requestId: input.requestId,
      planDigest: "native-digest",
      status: "applied",
    });
    statusMock.mockResolvedValue({
      found: true,
      commitId: "prepared-1",
      requestId: input.requestId,
      planDigest: "native-digest",
      status: "applied",
    });

    await prepareAndApplyChronicleCommit(input);

    expect(prepareMock).toHaveBeenCalledWith({
      projectId: input.projectId,
      runId: input.runId,
      proposalSetId: input.proposalSetId,
      requestId: input.requestId,
      planDigest: expect.any(String),
      sessionId: input.sessionId,
      surface: undefined,
      operations: [
        {
          kind: "chronicle.event.create",
          payload: {
            eventId: "event-1",
            title: "Event",
            note: null,
            kind: "generic",
            precision: "unknown",
            placement: { mode: "append-tail", afterOrdinal: null },
            secret: false,
            revealSceneId: "scene-1",
            evidenceSceneLinks: [],
            detail: null,
            primaryCodexId: null,
            locationCodexId: null,
            participants: [],
            startTime: null,
            endTime: null,
            startGranularity: "none",
            endGranularity: "none",
          },
          proposalId: "proposal-1",
          revisionId: "revision-1",
        },
      ],
      applications: [{ proposalId: "proposal-1", revisionId: "revision-1" }],
      expectedTailOrdinal: null,
    });
    expect(applyMock).toHaveBeenCalledWith({
      projectId: input.projectId,
      preparedCommitId: "prepared-1",
      requestId: input.requestId,
      sessionId: input.sessionId,
      expectedVersion: 0,
    });
  });

  it("accepts the prepare result when applying a commit", async () => {
    const input = {
      projectId: "project-1",
      runId: "run-1",
      proposalSetId: "set-1",
      requestId: "request-1",
      sessionId: "session-1",
      operations: [],
    };
    applyMock.mockResolvedValue({
      commitId: "commit-1",
      requestId: input.requestId,
      planDigest: "native-digest",
      status: "applied",
    });

    await applyChronicleCommit(input, {
      preparedCommitId: "prepared-1",
      version: 3,
    });

    expect(applyMock).toHaveBeenCalledWith({
      projectId: input.projectId,
      preparedCommitId: "prepared-1",
      requestId: input.requestId,
      sessionId: input.sessionId,
      expectedVersion: 3,
    });
  });
});
