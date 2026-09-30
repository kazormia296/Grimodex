import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

beforeEach(() => {
  setCurrentWorkspaceIdentity({ path: "/ws/cold", openRevision: 3 });
});

afterEach(() => {
  setCurrentWorkspaceIdentity(null);
});

const getRunReviewBundleMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const listResumableRunsMock = vi.hoisted(() => vi.fn());
const createHumanDerivedRevisionMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@/application/narrative-extraction/nativeApi",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/nativeApi")
      >();
    return {
      ...actual,
      narrativeExtractionGetRunReviewBundle: getRunReviewBundleMock,
      narrativeExtractionGetRun: getRunMock,
    };
  },
);

vi.mock("@/application/narrative-extraction/runRepository", () => ({
  getRun: (...args: unknown[]) => getRunMock(...args),
  listChronicleTaskResumeCandidates: vi.fn(),
  listResumableRuns: listResumableRunsMock,
}));

vi.mock(
  "@/application/narrative-extraction/proposalRepository",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/proposalRepository")
      >();
    return {
      ...actual,
      createHumanDerivedRevision: createHumanDerivedRevisionMock,
    };
  },
);

import { resetNarrativeArtifactIndexForTests } from "@/application/narrative-extraction/artifactRepository";
import { CHRONICLE_EXTRACT_ARTIFACT_KINDS } from "@/application/narrative-extraction/extractionCoordinator";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  getChronicleExtractionReview,
  resetChronicleExtractionApiCachesForTests,
  reviseChronicleProposal,
  restoreChronicleExtractionReview,
} from "./chronicleExtractionApi";
import {
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
} from "./chronicleExtractionStore";

function sampleProposal(
  overrides?: Partial<CreateChronicleEventProposalPayloadV1>,
): CreateChronicleEventProposalPayloadV1 {
  return {
    eventId: "ev-cold-1",
    title: "Cold start event",
    note: null,
    actuality: "actual",
    significance: "scene-level",
    evidenceAnchorIds: ["anchor-1"],
    evidenceDocumentRefs: ["doc:scene-1"],
    disclosure: {
      secret: false,
      revealDocumentRef: "doc:scene-1",
    },
    unresolvedMetadata: {
      participantSurfaces: [],
      locationSurface: null,
      temporalExpressions: [],
    },
    ...overrides,
  };
}

function supportArtifacts(
  runId: string,
  hypothesisId: string,
  actuality: "actual" | "rumored" | "planned" | "dreamed" = "actual",
) {
  return [
    {
      artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
      payloadJson: {
        observations: [
          {
            localId: "obs-cold",
            evidence: [{ sourceRef: "S1", quote: "quoted text" }],
            assertion: {
              attribution: "narrator",
              narrativeFrame: "story-world",
            },
            payload: {
              predicate: "event",
              actuality,
              participants: [],
              temporalExpressions: [],
            },
          },
        ],
      },
    },
    {
      artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
      payloadJson: {
        hypotheses: [
          {
            hypothesisId,
            clusterRef: "cluster-cold",
            observationRefs: ["obs-cold"],
            titleSuggestion: "event",
            summary: "event",
            actuality: "actual",
            significance: "scene-level",
          },
        ],
      },
    },
  ].map((row, index) => ({
    ...row,
    artifactId: `support-${index}`,
    runId,
    taskId: `support-task-${index}`,
    attemptId: `support-attempt-${index}`,
    payloadStorage: "inline-json",
    payloadRef: null,
    payloadDigest: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
}

describe("getChronicleExtractionReview cold-start restore", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    resetChronicleExtractionStoreForTests();
    resetChronicleExtractionApiCachesForTests();
    getRunReviewBundleMock.mockReset();
    getRunMock.mockReset();
    listResumableRunsMock.mockReset();
    createHumanDerivedRevisionMock.mockReset();
  });

  it.each(["actual", "rumored", "planned", "dreamed"] as const)(
    "checks %s support even when the saved review contains only already-satisfied rows",
    async (actuality) => {
      const runId = "run-already-satisfied";
      getRunMock.mockResolvedValue({
        run: {
          runId,
          projectId: "project-cold",
          surfacePathId: "chronicle.extract",
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
        tasks: [],
      });
      getRunReviewBundleMock.mockResolvedValue({
        runId,
        projectId: "project-cold",
        artifacts: [
          ...supportArtifacts(runId, "hyp-satisfied", actuality),
          {
            artifactId: "satisfied-plan",
            runId,
            taskId: "plan",
            attemptId: "attempt",
            artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
            payloadStorage: "inline-json",
            payloadJson: {
              proposals: [],
              planned: [],
              alreadySatisfied: [
                {
                  hypothesisId: "hyp-satisfied",
                  title: "Existing event",
                  existingRef: "event-existing",
                },
              ],
            },
            payloadRef: null,
            payloadDigest: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        proposalSet: {
          proposalSetId: "set-satisfied",
          runId,
          setKind: "chronicle.extract.review@1",
        },
        proposals: [],
      });
      const execution = getChronicleExtractionReview(runId, {
        projectId: "project-cold",
        workspacePath: "/ws/cold",
        openRevision: 3,
      });
      if (actuality !== "actual") {
        await expect(execution).rejects.toThrow(
          "NEX_CHRONICLE_REANALYSIS_REQUIRED",
        );
        expect(useChronicleExtractionStore.getState().projection).toBeNull();
      } else {
        const restored = await execution;
        expect(restored.proposals).toHaveLength(1);
        expect(restored.proposals[0]).toMatchObject({
          displayTitle: "Existing event",
          applicability: "already-satisfied",
        });
      }
      expect(createHumanDerivedRevisionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["actual", "rumored", "planned", "dreamed"] as const)(
    "validates cold %s support before restoring Native revision ids and decisions",
    async (actuality) => {
      const plannedProposal = sampleProposal();
      const proposal = sampleProposal({
        title: "Current human revision",
        note: "A current-revision decision must survive cold hydration.",
      });
      const nativeRevisionId = "rev-native-abc";
      const nativeProposalId = "prop-native-xyz";

      getRunMock.mockResolvedValue({
        run: {
          runId: "run-cold-1",
          projectId: "project-cold",
          surfacePathId: "chronicle.extract",
          scopeJson: {},
          specJson: {},
          specDigest: "spec",
          snapshotDigest: null,
          catalogDigest: null,
          registryDigest: null,
          status: "completed",
          coverageJson: {
            mode: "complete",
            documentCount: 1,
            windowCount: 1,
            completedWindows: 1,
            gaps: [],
          },
          outcomeSummaryJson: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          version: 1,
        },
        tasks: [],
        taskCounts: {
          queued: 0,
          running: 0,
          completed: 1,
          failed: 0,
          cancelled: 0,
        },
      });

      getRunReviewBundleMock.mockResolvedValue({
        runId: "run-cold-1",
        projectId: "project-cold",
        artifacts: [
          ...supportArtifacts("run-cold-1", "hyp-1", actuality),
          {
            artifactId: "art-proposals",
            runId: "run-cold-1",
            taskId: "task-1",
            attemptId: "attempt-1",
            artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
            payloadStorage: "inline-json",
            payloadJson: {
              proposalSetId: "set-cold-1",
              proposals: [plannedProposal],
              planned: [
                {
                  proposal: plannedProposal,
                  match: { status: "none" },
                  hypothesisId: "hyp-1",
                },
              ],
            },
            payloadRef: null,
            payloadDigest: null,
            createdAt: "2026-01-01T00:00:30.000Z",
          },
          {
            artifactId: "art-evidence",
            runId: "run-cold-1",
            taskId: "task-1",
            attemptId: "attempt-1",
            artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
            payloadStorage: "inline-json",
            payloadJson: {
              anchors: [
                {
                  id: "anchor-1",
                  documentRef: "doc:scene-1",
                  quote: "quoted text",
                  method: "exact",
                },
              ],
            },
            payloadRef: null,
            payloadDigest: null,
            createdAt: "2026-01-01T00:00:20.000Z",
          },
          {
            artifactId: "art-snapshot",
            runId: "run-cold-1",
            taskId: "task-1",
            attemptId: "attempt-1",
            artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
            payloadStorage: "inline-json",
            payloadJson: {
              snapshot: {
                documents: [
                  {
                    ref: "doc:scene-1",
                    origin: { kind: "project-node", nodeId: "scene-1" },
                  },
                ],
              },
            },
            payloadRef: null,
            payloadDigest: null,
            createdAt: "2026-01-01T00:00:10.000Z",
          },
        ],
        proposalSet: {
          proposalSetId: "set-cold-1",
          runId: "run-cold-1",
          projectId: "project-cold",
          setKind: "chronicle.extract.review@1",
          status: "draft",
          summaryJson: {},
          createdAt: "2026-01-01T00:00:40.000Z",
          updatedAt: "2026-01-01T00:00:40.000Z",
          version: 0,
        },
        proposals: [
          {
            proposalId: nativeProposalId,
            proposalSetId: "set-cold-1",
            proposalKey: "ev-cold-1:0",
            kind: "chronicle.create-event@1",
            status: "approved",
            payloadJson: proposal,
            currentRevisionId: nativeRevisionId,
            createdAt: "2026-01-01T00:00:40.000Z",
            updatedAt: "2026-01-01T00:00:50.000Z",
            reconciliationEnvelopeDigest: `sha256:${"d".repeat(64)}`,
            reconciliationEnvelopeSchemaVersion: 2,
            latestDecision: {
              decisionId: "dec-1",
              proposalId: nativeProposalId,
              revisionId: nativeRevisionId,
              decision: "approved",
              decisionJson: { probableDuplicateChoice: "create-as-new" },
              createdAt: "2026-01-01T00:00:50.000Z",
              createdBy: "reviewer",
            },
            application: {
              commitId: "commit-cold-1",
              revisionId: nativeRevisionId,
              appliedEntityKind: "chronicle-event",
              appliedEntityId: "event-cold-1",
              createdAt: "2026-01-01T00:00:55.000Z",
              applicationKind: "normal",
              compensatesApplicationId: null,
            },
          },
        ],
      });

      const execution = getChronicleExtractionReview("run-cold-1", {
        projectId: "project-cold",
        workspacePath: "/ws/cold",
        openRevision: 3,
      });

      if (actuality !== "actual") {
        await expect(execution).rejects.toThrow(
          "NEX_CHRONICLE_REANALYSIS_REQUIRED",
        );
        expect(useChronicleExtractionStore.getState().projection).toBeNull();
        expect(createHumanDerivedRevisionMock).not.toHaveBeenCalled();
        return;
      }
      const restored = await execution;
      expect(getRunReviewBundleMock).toHaveBeenCalledWith({
        runId: "run-cold-1",
        projectId: "project-cold",
      });
      expect(restored.proposalSetId).toBe("set-cold-1");
      expect(restored.proposals).toHaveLength(1);
      const [row] = restored.proposals;
      expect(row.proposalId).toBe(nativeProposalId);
      expect(row.revisionId).toBe(nativeRevisionId);
      expect(row.revisionId).not.toMatch(/^local-rev-/);
      expect(row.proposalId).not.toMatch(/^local-proposal-/);
      expect(row.status).toBe("approved");
      expect(row.application).toMatchObject({
        commitId: "commit-cold-1",
        revisionId: nativeRevisionId,
        appliedEntityId: "event-cold-1",
        applicationKind: "normal",
      });
      expect(row.reconciliationEnvelopeSchemaVersion).toBe(2);
      expect(row.displayTitle).toBe("Current human revision");
      expect(row.probableDuplicateChoice).toBe("create-as-new");
      expect(row.safety).toMatchObject({
        fresh: false,
        noDuplicate: false,
        riskLow: false,
      });
      expect(row.evidence[0]?.quote).toBe("quoted text");
    },
  );

  it("uses the current human revision payload and never carries a prior revision decision forward", async () => {
    const plannedPayload = sampleProposal({
      title: "Initial terminal proposal",
    });
    const currentPayload = sampleProposal({
      title: "Human revised terminal proposal",
      note: "The revision is the reviewable payload.",
    });

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-cold-current-revision",
        projectId: "project-cold",
        surfacePathId: "chronicle.extract",
        scopeJson: {},
        specJson: {},
        specDigest: "spec",
        snapshotDigest: null,
        catalogDigest: null,
        registryDigest: null,
        status: "completed",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        version: 1,
      },
      tasks: [],
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 9,
        failed: 0,
        cancelled: 0,
      },
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-cold-current-revision",
      projectId: "project-cold",
      artifacts: [
        ...supportArtifacts("run-cold-current-revision", "hyp-current"),
        {
          artifactId: "art-current-proposals",
          runId: "run-cold-current-revision",
          taskId: "task-plan",
          attemptId: "attempt-plan",
          artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId:
              "chronicle-plan-proposals:run-cold-current-revision:task-plan",
            proposals: [plannedPayload],
            planned: [
              {
                proposal: plannedPayload,
                match: { status: "none" },
                hypothesisId: "hyp-current",
              },
            ],
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "2026-01-01T00:00:30.000Z",
        },
        {
          artifactId: "art-current-snapshot",
          runId: "run-cold-current-revision",
          taskId: "task-snapshot",
          attemptId: "attempt-snapshot",
          artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
          payloadStorage: "inline-json",
          payloadJson: {
            snapshot: { documents: [] },
            existingEventsCatalog: {
              kind: "chronicle.existing-events-catalog@1",
              events: [
                {
                  ref: "event-existing-revised-title",
                  sourceKey: "chronicle:event:event-existing-revised-title",
                  title: currentPayload.title,
                  note: null,
                  version: 1,
                  linkedDocumentSourceKeys: [],
                  participantEntityRefs: [],
                  startTime: null,
                  endTime: null,
                  digest: `sha256:${"c".repeat(64)}`,
                  applicationProvenanceKeys: [],
                },
              ],
            },
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "2026-01-01T00:00:10.000Z",
        },
      ],
      proposalSet: {
        proposalSetId:
          "chronicle-plan-proposals:run-cold-current-revision:task-plan",
        runId: "run-cold-current-revision",
        projectId: "project-cold",
        setKind: "chronicle.extract.review@1",
        status: "draft",
        summaryJson: {},
        createdAt: "2026-01-01T00:00:40.000Z",
        updatedAt: "2026-01-01T00:00:40.000Z",
        version: 1,
      },
      proposals: [
        {
          proposalId: "prop-current-revision",
          proposalSetId:
            "chronicle-plan-proposals:run-cold-current-revision:task-plan",
          proposalKey: "ev-cold-1:0",
          kind: "chronicle.create-event@1",
          status: "unreviewed",
          payloadJson: currentPayload,
          currentRevisionId: "revision-2-current",
          createdAt: "2026-01-01T00:00:40.000Z",
          updatedAt: "2026-01-01T00:00:50.000Z",
          reconciliationEnvelopeDigest: `sha256:${"f".repeat(64)}`,
          reconciliationEnvelopeSchemaVersion: 2,
          latestDecision: {
            decisionId: "decision-on-revision-1",
            proposalId: "prop-current-revision",
            revisionId: "revision-1-terminal",
            decision: "approved",
            decisionJson: { probableDuplicateChoice: "create-as-new" },
            createdAt: "2026-01-01T00:00:45.000Z",
            createdBy: "reviewer",
          },
        },
      ],
    });

    const restored = await getChronicleExtractionReview(
      "run-cold-current-revision",
      {
        projectId: "project-cold",
        workspacePath: "/ws/cold",
        openRevision: 3,
      },
    );

    const [row] = restored.proposals;
    expect(row).toMatchObject({
      proposalId: "prop-current-revision",
      revisionId: "revision-2-current",
      status: "unreviewed",
      displayTitle: "Human revised terminal proposal",
      payload: currentPayload,
    });
    expect(row?.probableDuplicateChoice).toBeNull();
    expect(row?.match).toEqual({
      status: "probable-duplicate",
      candidates: ["event-existing-revised-title"],
      reasons: ["title-only"],
    });
    expect(row?.safety).toMatchObject({
      fresh: false,
      noDuplicate: false,
      riskLow: false,
    });
    expect(useChronicleExtractionStore.getState().bulkApproveSafe()).toBe(0);

    createHumanDerivedRevisionMock.mockResolvedValue({
      revisionId: "revision-3-reverted",
      reconciliationEnvelopeDigest: `sha256:${"e".repeat(64)}`,
    });
    await reviseChronicleProposal({
      proposalId: "prop-current-revision",
      patch: { title: plannedPayload.title },
    });

    const reverted =
      useChronicleExtractionStore.getState().projection?.proposals[0];
    expect(reverted).toMatchObject({
      revisionId: "revision-3-reverted",
      displayTitle: plannedPayload.title,
      plannedTitle: plannedPayload.title,
      plannedMatch: { status: "none" },
      match: { status: "none" },
      status: "unreviewed",
      probableDuplicateChoice: null,
    });
  });

  it("fails closed when Native proposal set is missing", async () => {
    setCurrentWorkspaceIdentity({ path: "/ws", openRevision: 1 });
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-cold-empty",
        projectId: "project-cold",
        surfacePathId: "chronicle.extract",
        scopeJson: {},
        specJson: {},
        specDigest: "spec",
        snapshotDigest: null,
        catalogDigest: null,
        registryDigest: null,
        status: "completed",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        version: 0,
      },
      tasks: [],
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-cold-empty",
      projectId: "project-cold",
      artifacts: [],
      proposalSet: null,
      proposals: [],
    });

    await expect(
      getChronicleExtractionReview("run-cold-empty", {
        projectId: "project-cold",
        workspacePath: "/ws",
        openRevision: 1,
      }),
    ).rejects.toThrow(/no Native proposal set/);
  });
});

describe("restoreChronicleExtractionReview candidate fallback", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    resetChronicleExtractionStoreForTests();
    resetChronicleExtractionApiCachesForTests();
    getRunReviewBundleMock.mockReset();
    getRunMock.mockReset();
    listResumableRunsMock.mockReset();
  });

  it.each(["actual", "planned"] as const)(
    "skips a newer incomplete run and checks older %s support without swallowing reanalysis errors",
    async (actuality) => {
      listResumableRunsMock.mockResolvedValue([
        {
          run: {
            runId: "run-crash",
            projectId: "project-cold",
            surfacePathId: "chronicle.extract",
            status: "running",
          },
        },
        {
          run: {
            runId: "run-old-review",
            projectId: "project-cold",
            surfacePathId: "chronicle.extract",
            status: "completed",
          },
        },
      ]);

      getRunMock.mockImplementation(async (runId: string) => ({
        run: {
          runId,
          projectId: "project-cold",
          surfacePathId: "chronicle.extract",
          scopeJson: {},
          specJson: {},
          specDigest: "spec",
          snapshotDigest: null,
          catalogDigest: null,
          registryDigest: null,
          status: runId === "run-crash" ? "running" : "completed",
          coverageJson: {},
          outcomeSummaryJson: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          version: 0,
        },
        tasks: [],
        taskCounts: {
          queued: 0,
          running: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
      }));

      getRunReviewBundleMock.mockImplementation(
        async (args: { runId: string }) => {
          if (args.runId === "run-crash") {
            return {
              runId: "run-crash",
              projectId: "project-cold",
              artifacts: [],
              proposalSet: null,
              proposals: [],
            };
          }
          const proposal = sampleProposal({
            eventId: "ev-old",
            title: "Older review event",
          });
          return {
            runId: "run-old-review",
            projectId: "project-cold",
            artifacts: [
              ...supportArtifacts("run-old-review", "hyp-old", actuality),
              {
                artifactId: "art-old-plan",
                runId: "run-old-review",
                taskId: "plan-old",
                attemptId: "attempt-old",
                artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
                payloadStorage: "inline-json",
                payloadJson: {
                  proposals: [proposal],
                  planned: [
                    {
                      proposal,
                      hypothesisId: "hyp-old",
                      match: { status: "none" },
                    },
                  ],
                },
                payloadRef: null,
                payloadDigest: null,
                createdAt: "2026-01-01T00:00:30.000Z",
              },
            ],
            proposalSet: {
              proposalSetId: "set-old",
              runId: "run-old-review",
              projectId: "project-cold",
              setKind: "chronicle.extract.review@1",
              status: "draft",
              summaryJson: {},
              createdAt: "2026-01-01T00:00:40.000Z",
              updatedAt: "2026-01-01T00:00:40.000Z",
              version: 0,
            },
            proposals: [
              {
                proposalId: "prop-old",
                proposalSetId: "set-old",
                proposalKey: "ev-old:0",
                kind: "chronicle.create-event@1",
                status: "approved",
                payloadJson: proposal,
                currentRevisionId: "rev-old",
                createdAt: "2026-01-01T00:00:40.000Z",
                updatedAt: "2026-01-01T00:00:50.000Z",
                latestDecision: null,
              },
            ],
          };
        },
      );

      const execution = restoreChronicleExtractionReview({
        projectId: "project-cold",
        workspacePath: "/ws/cold",
        openRevision: 3,
      });

      if (actuality !== "actual") {
        await expect(execution).rejects.toThrow(
          "NEX_CHRONICLE_REANALYSIS_REQUIRED",
        );
        expect(useChronicleExtractionStore.getState().projection).toBeNull();
        return;
      }
      const restored = await execution;
      expect(restored?.runId).toBe("run-old-review");
      expect(restored?.proposals[0]?.displayTitle).toBe("Older review event");
      expect(listResumableRunsMock).toHaveBeenCalled();
      const runIds = getRunReviewBundleMock.mock.calls.map(
        (call) => call[0]?.runId,
      );
      // Bundle hydrate is intentionally not cached after completion (mutable
      // proposal state). Assert candidate order, not call cardinality.
      expect([...new Set(runIds)]).toEqual(["run-crash", "run-old-review"]);
      expect(runIds[0]).toBe("run-crash");
    },
  );
});
