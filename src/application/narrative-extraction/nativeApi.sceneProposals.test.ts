import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import {
  narrativeExtractionListSceneProposals,
  narrativeExtractionListRedecidableProposals,
  type RedecidableProposalPage,
  type SceneProposalPage,
} from "./nativeApi";

describe("narrativeExtractionListSceneProposals", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("sends the page query under `payload` and returns Native's page unchanged", async () => {
    const page: SceneProposalPage = {
      items: [
        {
          proposalId: "p1",
          revisionId: "r1",
          title: "門が開いた",
          evidence: [{ sceneId: "scene-1", quote: "門が開いた。" }],
          evidenceTruncated: false,
          otherSceneIds: [],
          reviewState: "approved",
          rejectedBy: null,
          removedVia: null,
          rejectedAt: null,
          reapproval: { available: false, reason: "already-approved" },
          sourceState: "fresh",
          chronicleState: "not-applied",
          probableDuplicate: "none",
          relatedUse: { likely: true, reasons: [] },
        },
      ],
      nextCursor: null,
      limit: 20,
    };
    invokeMock.mockResolvedValue(page);

    const payload = {
      projectId: "project-1",
      sceneId: "scene-1",
      cursor: "r0",
      limit: 5,
    };
    await expect(narrativeExtractionListSceneProposals(payload)).resolves.toBe(
      page,
    );
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "narrative_extraction_list_scene_proposals",
      { payload },
    );
  });

  it("forwards the project-wide query and its redecidable page", async () => {
    const page: RedecidableProposalPage = {
      items: [
        {
          proposalId: "p1",
          revisionId: "r1",
          title: "門が開いた",
          evidenceSceneIds: ["scene-1"],
          evidenceSceneIdsTruncated: false,
          rejectedAt: "2026-11-25T12:00:00Z",
          removedVia: "undo-redo",
        },
      ],
      total: 2,
      nextCursor: "p1",
      limit: 1,
    };
    invokeMock.mockResolvedValue(page);
    const payload = { projectId: "project-1", cursor: "p0", limit: 1 };
    await expect(
      narrativeExtractionListRedecidableProposals(payload),
    ).resolves.toBe(page);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "narrative_extraction_list_redecidable_proposals",
      { payload },
    );
  });

  it("does not catch a refusal from Native", async () => {
    invokeMock.mockRejectedValue(
      new Error("NEX_SCENE_PROPOSALS_INPUT_INVALID: sceneId must be exact"),
    );
    await expect(
      narrativeExtractionListSceneProposals({
        projectId: "project-1",
        sceneId: "",
      }),
    ).rejects.toThrow("NEX_SCENE_PROPOSALS_INPUT_INVALID");
  });
});
