import { beforeEach, describe, expect, it, vi } from "vitest";

const coordinatorMock = vi.hoisted(() => vi.fn());
const loadArtifactMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const listCandidatesMock = vi.hoisted(() => vi.fn());
const cancelRunMock = vi.hoisted(() => vi.fn());
const captureWorkspaceBindingMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@/application/narrative-extraction/nativeApi",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/nativeApi")
      >();
    return {
      ...actual,
      captureNarrativeExtractionWorkspaceBinding: captureWorkspaceBindingMock,
    };
  },
);

vi.mock("@/application/narrative-extraction/extractionCoordinator", () => ({
  runChronicleExtractionCoordinator: coordinatorMock,
}));

vi.mock("@/application/narrative-extraction/artifactRepository", () => ({
  loadInlineJsonArtifact: loadArtifactMock,
  hydrateInlineArtifactsFromNative: vi.fn(),
  resetNarrativeArtifactIndexForTests: vi.fn(),
}));

vi.mock("@/application/narrative-extraction/runRepository", () => ({
  cancelRun: cancelRunMock,
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
  discardChronicleTaskResumeCandidate,
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
    listCandidatesMock.mockReset().mockResolvedValue([candidate()]);
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
    cancelRunMock.mockResolvedValue({
      runId: "run-resume-product",
      status: "cancelled",
    });
    captureWorkspaceBindingMock.mockResolvedValue({
      authorityId: "workspace-authority-resume",
      generation: 1,
      authorityInstanceId: "1",
    });
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
    {
      label: "live catalog drift",
      value: candidate({
        availability: "blocked",
        blockedCode: "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT",
      }),
      error: "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT",
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

  it("CTA表示後のlive Catalog driftを再列挙でblocked候補へ更新してclaimしない", async () => {
    const staleReady = candidate();
    const blocked = candidate({
      availability: "blocked",
      blockedCode: "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT",
    });
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(SCOPE, [staleReady]);
    listCandidatesMock.mockResolvedValue([blocked]);

    await expect(
      resumeChronicleExtraction({
        candidate: staleReady,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT");

    expect(coordinatorMock).not.toHaveBeenCalled();
    expect(useChronicleExtractionStore.getState().recovery).toMatchObject({
      status: "blocked",
      scope: SCOPE,
      candidates: [
        expect.objectContaining({
          runId: staleReady.runId,
          availability: "blocked",
          blockedCode: "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT",
        }),
      ],
      errorCode: "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT",
    });
  });

  it("再列挙後claimまでのdriftも再発見し、ready候補を残さない", async () => {
    const staleReady = candidate();
    const blocked = candidate({
      availability: "blocked",
      blockedCode: "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT",
    });
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(SCOPE, [staleReady]);
    listCandidatesMock
      .mockResolvedValueOnce([staleReady])
      .mockResolvedValueOnce([blocked]);
    coordinatorMock.mockRejectedValueOnce(
      new Error(
        "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT: claim transaction rejected drift",
      ),
    );

    await expect(
      resumeChronicleExtraction({
        candidate: staleReady,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT");

    expect(coordinatorMock).toHaveBeenCalledTimes(1);
    expect(listCandidatesMock).toHaveBeenCalledTimes(2);
    expect(useChronicleExtractionStore.getState().recovery).toMatchObject({
      status: "blocked",
      candidates: [
        expect.objectContaining({
          runId: staleReady.runId,
          availability: "blocked",
        }),
      ],
      errorCode: "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT",
    });
  });

  it("finish時driftでRunが候補外になった場合はfresh開始を再解放する", async () => {
    const staleReady = candidate();
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(SCOPE, [staleReady]);
    listCandidatesMock
      .mockResolvedValueOnce([staleReady])
      .mockResolvedValueOnce([]);
    coordinatorMock.mockRejectedValueOnce(
      new Error(
        "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT: finish transaction rejected drift",
      ),
    );

    await expect(
      resumeChronicleExtraction({
        candidate: staleReady,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT");

    expect(listCandidatesMock).toHaveBeenCalledTimes(2);
    expect(useChronicleExtractionStore.getState().recovery).toMatchObject({
      status: "ready",
      scope: SCOPE,
      candidates: [],
      resumingRunId: null,
      errorCode: null,
    });
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

  it("exact blocked RunをNativeでcancelし、再列挙から消えるまでfresh開始を解放しない", async () => {
    const blocked = candidate({
      status: "pending",
      completedTaskKinds: [],
      nextTask: {
        taskId: "task-snapshot",
        taskKind: "source.snapshot@1",
        status: "queued",
        leaseExpiresAt: null,
      },
      availability: "blocked",
      blockedCode: "NEX_CHRONICLE_RESUME_SNAPSHOT_INCOMPLETE",
      language: null,
      existingEventsCatalog: null,
      startedAt: null,
    });
    listCandidatesMock
      .mockResolvedValueOnce([blocked])
      .mockResolvedValueOnce([]);
    const discovered = await discoverChronicleTaskResumeCandidates(SCOPE);

    await expect(
      discardChronicleTaskResumeCandidate({
        candidate: discovered[0]!,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).resolves.toEqual({ runId: blocked.runId });

    expect(cancelRunMock).toHaveBeenCalledWith(
      blocked.runId,
      SCOPE.projectId,
      {
        authorityId: "workspace-authority-resume",
        generation: 1,
        authorityInstanceId: "1",
      },
      {
        nextTaskId: blocked.nextTask.taskId,
        blockedCode: "NEX_CHRONICLE_RESUME_SNAPSHOT_INCOMPLETE",
        runSpecDigest: blocked.runSpecDigest,
        snapshotDigest: blocked.snapshotDigest,
        catalogDigest: blocked.catalogDigest,
      },
    );
    expect(listCandidatesMock).toHaveBeenCalledTimes(2);
    expect(useChronicleExtractionStore.getState().recovery).toMatchObject({
      status: "ready",
      scope: SCOPE,
      candidates: [],
      errorCode: null,
    });
    expect(coordinatorMock).not.toHaveBeenCalled();
  });

  it("ready/lease-heldまたはcurrent recovery外のRunはcancelしない", async () => {
    const ready = candidate();
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(SCOPE, [ready]);

    await expect(
      discardChronicleTaskResumeCandidate({
        candidate: ready,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_DISCARD_NOT_ALLOWED");

    const leaseHeld = candidate({
      status: "running",
      availability: "lease-held",
      blockedCode: null,
      nextTask: {
        taskId: "task-observe-held",
        taskKind: "chronicle.observe-events@1",
        status: "running",
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(SCOPE, [leaseHeld]);
    await expect(
      discardChronicleTaskResumeCandidate({
        candidate: leaseHeld,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_DISCARD_NOT_ALLOWED");
    expect(cancelRunMock).not.toHaveBeenCalled();
  });
});
