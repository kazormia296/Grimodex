import { beforeEach, describe, expect, it, vi } from "vitest";

const coordinatorMock = vi.hoisted(() => vi.fn());
const loadArtifactMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());

vi.mock("@/application/narrative-extraction/extractionCoordinator", () => ({
  runChronicleExtractionCoordinator: coordinatorMock,
}));

vi.mock("@/application/narrative-extraction/artifactRepository", () => ({
  loadInlineJsonArtifact: loadArtifactMock,
  hydrateInlineArtifactsFromNative: vi.fn(),
}));

vi.mock("@/application/narrative-extraction/runRepository", () => ({
  getRun: getRunMock,
  listResumableRuns: vi.fn(),
}));

import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  resetChronicleExtractionApiCachesForTests,
  startChronicleExtraction,
} from "./chronicleExtractionApi";
import {
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
} from "./chronicleExtractionStore";

const proposal: CreateChronicleEventProposalPayloadV1 = {
  eventId: "event:start-capture",
  title: "Captured title",
  note: null,
  actuality: "actual",
  significance: "scene-level",
  evidenceAnchorIds: ["anchor:start"],
  evidenceDocumentRefs: ["document:start"],
  disclosure: { secret: false, revealDocumentRef: "document:start" },
  unresolvedMetadata: {
    participantSurfaces: [],
    locationSurface: null,
    temporalExpressions: [],
  },
};

describe("startChronicleExtraction caller capture", () => {
  beforeEach(() => {
    coordinatorMock.mockReset();
    loadArtifactMock.mockReset();
    getRunMock.mockReset();
    resetChronicleExtractionApiCachesForTests();
    resetChronicleExtractionStoreForTests();
    loadArtifactMock.mockResolvedValue(null);
    getRunMock.mockResolvedValue({
      run: {
        status: "completed",
        coverageJson: {},
      },
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 9,
        failed: 0,
        cancelled: 0,
      },
    });
  });

  it("uses the synchronously captured scope/catalog/authority through dynamic import and projection", async () => {
    coordinatorMock.mockImplementation(
      async (request: {
        projectId: string;
        sceneIds: readonly string[];
        authority: { projectId: string; workspacePath: string | null };
        existingEvents?: readonly { title: string }[];
      }) => {
        expect(request.projectId).toBe("project-start");
        expect(request.sceneIds).toEqual(["scene-start"]);
        expect(request.authority).toMatchObject({
          projectId: "project-start",
          workspacePath: "/workspace-start",
        });
        expect(request.existingEvents?.[0]?.title).toBe("Original catalog");
        return {
          runId: "run-start-capture",
          snapshot: { documents: [] },
          proposals: [proposal],
          savedProposalSetId: "set-start-capture",
          savedProposals: [
            {
              proposalId: "proposal-start-capture",
              proposalKey: "event:start-capture:0",
              revisionId: "revision-start-capture",
              status: "unreviewed",
              payload: proposal,
            },
          ],
        };
      },
    );

    const mutableRequest = {
      projectId: "project-start",
      folderId: "folder-start",
      language: "ja",
      sceneIds: ["scene-start"],
      authority: {
        projectId: "project-start",
        currentProjectId: () => "project-start",
        workspacePath: "/workspace-start",
        workspaceOpenRevision: 7,
      },
      workspacePath: "/workspace-start",
      openRevision: 7,
      existingEvents: [
        {
          ref: "event:existing",
          sourceKey: "project:scene:scene-start",
          title: "Original catalog",
          note: null,
          version: 1,
          linkedDocumentSourceKeys: ["project:scene:scene-start"],
          participantEntityRefs: [],
          startTime: null,
          endTime: null,
          digest: `sha256:${"a".repeat(64)}`,
          applicationProvenanceKeys: [],
        },
      ],
      useAi: false,
    };

    const started = startChronicleExtraction(mutableRequest);
    // The dynamic coordinator import has not resolved yet. Mutating the
    // caller-owned object cannot relabel either the sealed Run or its review.
    mutableRequest.projectId = "project-mutated";
    mutableRequest.workspacePath = "/workspace-mutated";
    mutableRequest.openRevision = 99;
    mutableRequest.sceneIds[0] = "scene-mutated";
    mutableRequest.authority.projectId = "project-mutated";
    mutableRequest.authority.workspacePath = "/workspace-mutated";
    mutableRequest.existingEvents[0]!.title = "Mutated catalog";

    await expect(started).resolves.toEqual({ runId: "run-start-capture" });
    expect(getRunMock).toHaveBeenCalledWith(
      "run-start-capture",
      "project-start",
    );
    const projection = useChronicleExtractionStore.getState().projection;
    expect(projection).toMatchObject({
      projectId: "project-start",
      workspacePath: "/workspace-start",
      openRevision: 7,
    });
  });
});
