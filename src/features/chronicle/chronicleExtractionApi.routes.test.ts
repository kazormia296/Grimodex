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
import { recordChronicleProposalRevision } from "./chronicleExtractionApi";

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
  });

  it("uses the typed Human C2B writer for an explicit V2 current revision", async () => {
    createHumanDerivedRevisionMock.mockResolvedValue({
      revisionId: "revision-human-v2",
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
    ).resolves.toBe("revision-human-v2");

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
    ).resolves.toBe("revision-v1");

    expect(appendRevisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-route-v1",
        proposalId: "proposal-route-v1",
        inheritReconciliationEnvelope: undefined,
      }),
    );
    expect(createHumanDerivedRevisionMock).not.toHaveBeenCalled();
  });
});
