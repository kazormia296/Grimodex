import { beforeEach, describe, expect, it, vi } from "vitest";

const coordinatorMock = vi.hoisted(() => vi.fn());
const loadArtifactMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const listCandidatesMock = vi.hoisted(() => vi.fn());

vi.mock("@/application/narrative-extraction/extractionCoordinator", () => ({
  runChronicleExtractionCoordinator: coordinatorMock,
}));

vi.mock("@/application/narrative-extraction/artifactRepository", () => ({
  loadInlineJsonArtifact: loadArtifactMock,
  hydrateInlineArtifactsFromNative: vi.fn(),
  resetNarrativeArtifactIndexForTests: vi.fn(),
}));

vi.mock("@/application/narrative-extraction/runRepository", () => ({
  getRun: getRunMock,
  listChronicleTaskResumeCandidates: listCandidatesMock,
  listResumableRuns: vi.fn(),
}));

import type { ChronicleTaskResumeCandidate } from "@/application/narrative-extraction/nativeApi";
import { resetNarrativeArtifactIndexForTests } from "@/application/narrative-extraction/artifactRepository";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  discoverChronicleTaskResumeCandidates,
  resetChronicleExtractionApiCachesForTests,
  resumeChronicleExtraction,
  startChronicleExtraction,
} from "./chronicleExtractionApi";
import {
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
} from "./chronicleExtractionStore";

const SCOPE = {
  projectId: "project-resume",
  workspacePath: "/workspace/resume",
  openRevision: 7,
} as const;

const CHRONICLE_TASK_CHAIN = [
  "source.snapshot@1",
  "source.window-plan@1",
  "chronicle.observe-events@1",
  "evidence.resolve@1",
  "chronicle.merge-local-observations@1",
  "chronicle.cluster-event-observations@1",
  "chronicle.synthesize-event@1",
  "chronicle.match-existing-events@1",
  "chronicle.plan-proposals@1",
] as const;

const proposal: CreateChronicleEventProposalPayloadV1 = {
  eventId: "event:resumed",
  title: "Resumed proposal",
  note: null,
  actuality: "actual",
  significance: "scene-level",
  evidenceAnchorIds: ["anchor:resumed"],
  evidenceDocumentRefs: ["document:resumed"],
  disclosure: { secret: false, revealDocumentRef: "document:resumed" },
  unresolvedMetadata: {
    participantSurfaces: [],
    locationSurface: null,
    temporalExpressions: [],
  },
};

function authority(
  overrides: Partial<MutationAuthority> = {},
): MutationAuthority {
  return {
    projectId: SCOPE.projectId,
    currentProjectId: () => SCOPE.projectId,
    workspacePath: SCOPE.workspacePath,
    workspaceOpenRevision: SCOPE.openRevision,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<ChronicleTaskResumeCandidate> = {},
): ChronicleTaskResumeCandidate {
  const catalogDigest = `sha256:${"a".repeat(64)}`;
  const coordinatorContractDigest = `sha256:${"b".repeat(64)}`;
  return {
    runId: "run-resume-product",
    projectId: SCOPE.projectId,
    status: "running",
    scopeJson: {
      folderId: "folder-resume",
      sceneIds: ["scene-resume"],
    },
    specJson: {
      kind: "chronicle.extract.run-spec@2",
      domain: "chronicle",
      version: 2,
      taskChain: [...CHRONICLE_TASK_CHAIN],
      executionMode: "deterministic-fallback",
      existingEventsCatalogDigest: catalogDigest,
      coordinatorContractDigest,
    },
    runSpecDigest: `sha256:${"c".repeat(64)}`,
    snapshotDigest: `sha256:${"d".repeat(64)}`,
    catalogDigest,
    executionMode: "deterministic-fallback",
    coordinatorContractDigest,
    completedTaskKinds: [...CHRONICLE_TASK_CHAIN.slice(0, 6)],
    nextTask: {
      taskId: "task-synthesize",
      taskKind: "chronicle.synthesize-event@1",
      status: "queued",
      leaseExpiresAt: null,
    },
    availability: "ready",
    blockedCode: null,
    language: "ja",
    existingEventsCatalog: {
      kind: "chronicle.existing-events-catalog@1",
      events: [
        {
          ref: "event:existing",
          sourceKey: "event:existing",
          title: "Existing event",
          note: null,
          version: 3,
          linkedDocumentSourceKeys: [],
          participantEntityRefs: [],
          startTime: null,
          endTime: null,
          digest: `sha256:${"e".repeat(64)}`,
          applicationProvenanceKeys: [],
        },
      ],
    },
    createdAt: "2026-08-10T00:00:00.000Z",
    startedAt: "2026-08-10T00:00:01.000Z",
    ...overrides,
  };
}

function terminalCoordinatorResult() {
  return {
    runId: "run-resume-product",
    snapshot: { documents: [] },
    proposals: [proposal],
    savedProposalSetId: "set-resume-product",
    savedProposals: [
      {
        proposalId: "proposal-resume-product",
        proposalKey: "event:resumed:0",
        revisionId: "revision-resume-product",
        status: "unreviewed" as const,
        payload: proposal,
      },
    ],
  };
}

describe("Chronicle product cold-start Task recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChronicleExtractionApiCachesForTests();
    resetChronicleExtractionStoreForTests();
    setCurrentWorkspaceIdentity({
      path: SCOPE.workspacePath,
      openRevision: SCOPE.openRevision,
    });
    loadArtifactMock.mockResolvedValue(null);
    getRunMock.mockResolvedValue({
      run: { status: "completed", coverageJson: {} },
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 9,
        failed: 0,
        cancelled: 0,
      },
    });
    coordinatorMock.mockResolvedValue(terminalCoordinatorResult());
  });

  it("store/cache消去後にdurable候補を発見し、same runIdをterminal Reviewへ再開する", async () => {
    const durableCandidate = candidate();
    coordinatorMock.mockRejectedValueOnce(
      new Error("SIMULATED_PROCESS_EXIT_AFTER_OBSERVATION"),
    );

    await expect(
      startChronicleExtraction({
        projectId: SCOPE.projectId,
        folderId: durableCandidate.scopeJson.folderId,
        language: durableCandidate.language!,
        sceneIds: durableCandidate.scopeJson.sceneIds,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
        existingEvents: durableCandidate.existingEventsCatalog!.events,
        useAi: false,
      }),
    ).rejects.toThrow("SIMULATED_PROCESS_EXIT_AFTER_OBSERVATION");
    expect(coordinatorMock).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.mock.calls[0]?.[0]).not.toHaveProperty("runId");
    expect(coordinatorMock.mock.calls[0]?.[0]).not.toHaveProperty("resume");

    // Model a true renderer cold start: every process-local projection/index
    // is gone, while the Native Run/Task/Attempt/artifact ledger survives.
    resetChronicleExtractionApiCachesForTests();
    resetChronicleExtractionStoreForTests();
    resetNarrativeArtifactIndexForTests();
    expect(resetNarrativeArtifactIndexForTests).toHaveBeenCalledTimes(1);
    listCandidatesMock.mockResolvedValue([durableCandidate]);

    const discovered = await discoverChronicleTaskResumeCandidates(SCOPE);
    expect(discovered.map((item) => item.runId)).toEqual([
      "run-resume-product",
    ]);
    expect(useChronicleExtractionStore.getState().projection).toBeNull();

    await expect(
      resumeChronicleExtraction({
        candidate: discovered[0]!,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).resolves.toEqual({ runId: "run-resume-product" });

    expect(coordinatorMock).toHaveBeenCalledTimes(2);
    expect(coordinatorMock).toHaveBeenNthCalledWith(
      2,
      {
        projectId: SCOPE.projectId,
        folderId: "folder-resume",
        language: "ja",
        sceneIds: ["scene-resume"],
        authority: expect.objectContaining({
          projectId: SCOPE.projectId,
          workspacePath: SCOPE.workspacePath,
          workspaceOpenRevision: SCOPE.openRevision,
        }),
        runId: "run-resume-product",
        resume: true,
        specDigest: durableCandidate.coordinatorContractDigest,
        existingEvents: durableCandidate.existingEventsCatalog?.events,
      },
      { useAi: false },
    );
    expect(coordinatorMock.mock.calls.slice(1)).toHaveLength(1);
    expect(coordinatorMock.mock.calls[1]?.[0]).toMatchObject({
      runId: durableCandidate.runId,
      resume: true,
    });
    expect(useChronicleExtractionStore.getState().projection).toMatchObject({
      runId: "run-resume-product",
      projectId: SCOPE.projectId,
      workspacePath: SCOPE.workspacePath,
      openRevision: SCOPE.openRevision,
      proposalSetId: "set-resume-product",
    });
    expect(useChronicleExtractionStore.getState().recovery.candidates).toEqual(
      [],
    );
  });

  it("同じrunning Runの同時resumeをworkspace/project/run単位でsingle-flight化する", async () => {
    const resumableCandidate = candidate();
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(SCOPE, [resumableCandidate]);
    let finishResume!: (
      value: ReturnType<typeof terminalCoordinatorResult>,
    ) => void;
    coordinatorMock.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof terminalCoordinatorResult>>((resolve) => {
          finishResume = resolve;
        }),
    );
    const request = {
      candidate: resumableCandidate,
      authority: authority(),
      workspacePath: SCOPE.workspacePath,
      openRevision: SCOPE.openRevision,
    } as const;

    const first = resumeChronicleExtraction(request);
    const second = resumeChronicleExtraction(request);
    await vi.waitFor(() => expect(coordinatorMock).toHaveBeenCalledTimes(1));
    finishResume(terminalCoordinatorResult());

    await expect(Promise.all([first, second])).resolves.toEqual([
      { runId: resumableCandidate.runId },
      { runId: resumableCandidate.runId },
    ]);
    expect(coordinatorMock).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.mock.calls[0]?.[0]).toMatchObject({
      runId: resumableCandidate.runId,
      resume: true,
    });
  });

  it.each([
    {
      label: "lease-held",
      value: candidate({
        availability: "lease-held",
        nextTask: {
          taskId: "task-synthesize",
          taskKind: "chronicle.synthesize-event@1",
          status: "running",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      }),
      error: "NEX_CHRONICLE_RESUME_LEASE_HELD",
    },
    {
      label: "catalog missing",
      value: candidate({ existingEventsCatalog: null }),
      error: "NEX_CHRONICLE_RESUME_CATALOG_MISSING",
    },
  ])(
    "$label candidateをfresh Runへfallbackしない",
    async ({ value, error }) => {
      await expect(
        resumeChronicleExtraction({
          candidate: value,
          authority: authority(),
          workspacePath: SCOPE.workspacePath,
          openRevision: SCOPE.openRevision,
        }),
      ).rejects.toThrow(error);
      expect(coordinatorMock).not.toHaveBeenCalled();
    },
  );

  it("workspace scope driftをclaim前に拒否し、fresh Runへfallbackしない", async () => {
    setCurrentWorkspaceIdentity({ path: "/workspace/other", openRevision: 8 });
    await expect(
      resumeChronicleExtraction({
        candidate: candidate(),
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_AUTHORITY_STALE");
    expect(coordinatorMock).not.toHaveBeenCalled();
  });

  it("discovery failureをblockedとして保持し、候補なしへcoerceしない", async () => {
    listCandidatesMock.mockRejectedValue(
      new Error("NEX_CHRONICLE_TASK_RESUME_QUERY_FAILED: sqlite read failed"),
    );
    await expect(discoverChronicleTaskResumeCandidates(SCOPE)).rejects.toThrow(
      "NEX_CHRONICLE_TASK_RESUME_QUERY_FAILED",
    );
    expect(useChronicleExtractionStore.getState().recovery).toMatchObject({
      status: "blocked",
      scope: SCOPE,
      candidates: [],
      errorCode: "NEX_CHRONICLE_TASK_RESUME_QUERY_FAILED",
    });
    expect(coordinatorMock).not.toHaveBeenCalled();
  });
});
