import { beforeEach, describe, expect, it, vi } from "vitest";

const appendRevisionMock = vi.hoisted(() => vi.fn());
const createHumanDerivedRevisionMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@/application/narrative-extraction/proposalRepository",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/proposalRepository")
      >();
    return {
      ...actual,
      appendRevision: appendRevisionMock,
      createHumanDerivedRevision: createHumanDerivedRevisionMock,
    };
  },
);

import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  recordChronicleProposalRevision,
  reviseChronicleProposal,
} from "./chronicleExtractionApi";
import {
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
  type ChronicleExtractionReviewProjection,
} from "./chronicleExtractionStore";

const payload = {
  eventId: "event:route",
  title: "Route",
  note: null,
  actuality: "actual",
  significance: "major",
  evidenceAnchorIds: ["anchor:route"],
  evidenceDocumentRefs: ["document:route"],
  disclosure: {
    secret: false,
    revealDocumentRef: "document:route",
  },
  unresolvedMetadata: {
    participantSurfaces: [],
    locationSurface: null,
    temporalExpressions: [],
  },
} as unknown as CreateChronicleEventProposalPayloadV1;

describe("Chronicle review revision route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChronicleExtractionStoreForTests();
  });

  it("uses the typed Human C2B writer for an explicit V2 current revision", async () => {
    createHumanDerivedRevisionMock.mockResolvedValue({
      revisionId: "revision-human-v2",
      reconciliationEnvelopeDigest: `sha256:${"b".repeat(64)}`,
    });

    await expect(
      recordChronicleProposalRevision({
        runId: "run-route",
        projectId: "project-route",
        proposalId: "proposal-route",
        expectedCurrentRevisionId: "revision-parent",
        payload,
        useHumanDerivedRevision: true,
        inheritReconciliationEnvelope: {
          parentRevisionId: "revision-parent",
          expectedEnvelopeDigest: `sha256:${"a".repeat(64)}`,
        },
      }),
    ).resolves.toEqual({
      revisionId: "revision-human-v2",
      reconciliationEnvelopeDigest: `sha256:${"b".repeat(64)}`,
    });

    expect(createHumanDerivedRevisionMock).toHaveBeenCalledWith({
      projectId: "project-route",
      request: expect.objectContaining({
        proposalId: "proposal-route",
        parentRevisionId: "revision-parent",
        expectedParentEnvelopeDigest: `sha256:${"a".repeat(64)}`,
      }),
    });
    expect(appendRevisionMock).not.toHaveBeenCalled();
  });

  it("keeps the explicit V1 fallback on the legacy append route", async () => {
    appendRevisionMock.mockResolvedValue({ revisionId: "revision-v1" });

    await expect(
      recordChronicleProposalRevision({
        runId: "run-route-v1",
        projectId: "project-route",
        proposalId: "proposal-route-v1",
        expectedCurrentRevisionId: "revision-v1-parent",
        payload,
      }),
    ).resolves.toEqual({
      revisionId: "revision-v1",
      reconciliationEnvelopeDigest: null,
    });

    expect(appendRevisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-route-v1",
        proposalId: "proposal-route-v1",
        inheritReconciliationEnvelope: undefined,
      }),
    );
    expect(createHumanDerivedRevisionMock).not.toHaveBeenCalled();
  });

  it("uses the immediately preceding V2 child and its fresh envelope on a second edit", async () => {
    const initialDigest = `sha256:${"a".repeat(64)}`;
    const childDigest = `sha256:${"b".repeat(64)}`;
    const grandchildDigest = `sha256:${"c".repeat(64)}`;
    createHumanDerivedRevisionMock
      .mockResolvedValueOnce({
        revisionId: "revision-child",
        reconciliationEnvelopeDigest: childDigest,
      })
      .mockResolvedValueOnce({
        revisionId: "revision-grandchild",
        reconciliationEnvelopeDigest: grandchildDigest,
      });
    useChronicleExtractionStore.getState().setProjection({
      runId: "run-route",
      projectId: "project-route",
      workspacePath: "/workspace-route",
      openRevision: 1,
      proposalSetId: "proposal-set-route",
      status: "completed",
      coverage: {},
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
      proposals: [
        {
          proposalId: "proposal-route",
          revisionId: "revision-parent",
          reconciliationEnvelopeDigest: initialDigest,
          reconciliationEnvelopeSchemaVersion: 2,
          proposalKey: "proposal-key-route",
          status: "unreviewed",
          applicability: "applicable",
          displayTitle: "Route",
          payload,
          match: { status: "none" },
          evidence: [],
          safety: {
            fresh: true,
            evidenceExact: true,
            actualitySettled: true,
            noDuplicate: true,
            lossless: true,
            noDeps: true,
            riskLow: true,
          },
          probableDuplicateChoice: null,
          application: null,
        },
      ],
    } satisfies ChronicleExtractionReviewProjection);

    await reviseChronicleProposal({
      proposalId: "proposal-route",
      patch: { title: "Route child" },
    });
    await reviseChronicleProposal({
      proposalId: "proposal-route",
      patch: { note: "second edit" },
    });

    expect(createHumanDerivedRevisionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        request: expect.objectContaining({
          expectedCurrentRevisionId: "revision-parent",
          parentRevisionId: "revision-parent",
          expectedParentEnvelopeDigest: initialDigest,
        }),
      }),
    );
    expect(createHumanDerivedRevisionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: expect.objectContaining({
          expectedCurrentRevisionId: "revision-child",
          parentRevisionId: "revision-child",
          expectedParentEnvelopeDigest: childDigest,
        }),
      }),
    );
    const current =
      useChronicleExtractionStore.getState().projection?.proposals[0];
    expect(current?.revisionId).toBe("revision-grandchild");
    expect(current?.reconciliationEnvelopeDigest).toBe(grandchildDigest);
  });
});
