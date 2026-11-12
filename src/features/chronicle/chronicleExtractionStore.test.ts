import { beforeEach, describe, expect, it } from "vitest";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import type { ChronicleTaskResumeCandidate } from "@/application/narrative-extraction/nativeApi";
import {
  buildProposalSafetyFlags,
  isBulkApprovalTarget,
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
  type ChronicleExtractionReviewProjection,
  type ChronicleReviewProposal,
} from "./chronicleExtractionStore";

function payload(
  overrides: Partial<CreateChronicleEventProposalPayloadV1> = {},
): CreateChronicleEventProposalPayloadV1 {
  return {
    eventId: "event-1",
    title: "教会への砲撃",
    note: null,
    actuality: "actual",
    significance: "major",
    evidenceAnchorIds: ["anchor-1"],
    evidenceDocumentRefs: ["doc-1"],
    disclosure: { secret: true, revealDocumentRef: "doc-1" },
    unresolvedMetadata: {
      participantSurfaces: ["マルフーシャ"],
      locationSurface: "教会",
      temporalExpressions: [],
    },
    ...overrides,
  };
}

function proposal(
  overrides: Partial<ChronicleReviewProposal> = {},
): ChronicleReviewProposal {
  const basePayload = payload();
  return {
    proposalId: "proposal-1",
    revisionId: "rev-1",
    proposalKey: "key-1",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: basePayload.title,
    payload: basePayload,
    plannedTitle: basePayload.title,
    plannedMatch: { status: "none" },
    match: { status: "none" },
    evidence: [
      {
        anchorId: "anchor-1",
        quote: "教会の尖塔が砲撃で崩れ落ちた",
        documentRef: "doc-1",
        sceneId: "scene-1",
        sceneTitle: "教会籠城",
        method: "exact",
      },
    ],
    safety: buildProposalSafetyFlags({
      match: { status: "none" },
      actuality: "actual",
      evidenceMethods: ["exact"],
    }),
    probableDuplicateChoice: null,
    ...overrides,
    application: overrides.application ?? null,
  };
}

function projection(
  proposals: ChronicleReviewProposal[],
): ChronicleExtractionReviewProjection {
  return {
    runId: "run-1",
    projectId: "project-a",
    workspacePath: "/workspace-a",
    openRevision: 1,
    proposalSetId: "proposal-set-1",
    status: "completed",
    coverage: {
      mode: "complete",
      windowCount: 2,
      completedWindows: 2,
      gaps: [],
    },
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 9,
      failed: 0,
      cancelled: 0,
    },
    proposals,
  };
}

const RECOVERY_SCOPE = {
  projectId: "project-a",
  workspacePath: "/workspace-a",
  openRevision: 1,
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

function recoveryCandidate(runId: string): ChronicleTaskResumeCandidate {
  const catalogDigest = `sha256:${"a".repeat(64)}`;
  const coordinatorContractDigest = `sha256:${"b".repeat(64)}`;
  return {
    runId,
    projectId: RECOVERY_SCOPE.projectId,
    status: "running",
    scopeJson: { folderId: "folder-a", sceneIds: ["scene-a"] },
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
      taskId: `task:${runId}`,
      taskKind: "chronicle.synthesize-event@1",
      status: "queued",
      leaseExpiresAt: null,
    },
    availability: "ready",
    blockedCode: null,
    language: "ja",
    existingEventsCatalog: {
      kind: "chronicle.existing-events-catalog@1",
      events: [],
    },
    createdAt: "2026-08-10T00:00:00.000Z",
    startedAt: "2026-08-10T00:00:01.000Z",
  };
}

describe("isBulkApprovalTarget", () => {
  it("is decided by Native's judgement only (BAO/1)", () => {
    const base = proposal({ proposalId: "p" });
    // The plan-time safety flags are all green: they must not matter.
    expect(base.safety.riskLow).toBe(true);
    expect(isBulkApprovalTarget(base)).toBe(false);
    expect(isBulkApprovalTarget({ ...base, bulkApproval: null })).toBe(false);
    expect(
      isBulkApprovalTarget({
        ...base,
        bulkApproval: { eligible: false, reasons: ["r3-significance"] },
      }),
    ).toBe(false);
    expect(
      isBulkApprovalTarget({
        ...base,
        bulkApproval: { eligible: true, reasons: [] },
      }),
    ).toBe(true);
    // Native says eligible, but the safety flags are red: still a target.
    const redFlags: ChronicleReviewProposal = {
      ...base,
      safety: { ...base.safety, riskLow: false, noDuplicate: false },
      bulkApproval: { eligible: true, reasons: [] },
    };
    expect(isBulkApprovalTarget(redFlags)).toBe(true);
  });

  it("never counts applied, already-satisfied or revision-less proposals", () => {
    const eligible = { eligible: true, reasons: [] } as const;
    const base = proposal({ proposalId: "p", bulkApproval: eligible });
    expect(isBulkApprovalTarget({ ...base, revisionId: null })).toBe(false);
    expect(
      isBulkApprovalTarget({ ...base, applicability: "already-satisfied" }),
    ).toBe(false);
  });
});

describe("chronicleExtractionStore", () => {
  beforeEach(() => {
    resetChronicleExtractionStoreForTests();
  });

  it("starts proposals as unreviewed and holds DB projection fields", () => {
    const store = useChronicleExtractionStore.getState();
    store.setProjection(projection([proposal()]));
    const next = useChronicleExtractionStore.getState().projection;
    expect(next?.runId).toBe("run-1");
    expect(next?.proposals[0]?.status).toBe("unreviewed");
    expect(next?.coverage.windowCount).toBe(2);
    expect(useChronicleExtractionStore.getState().selectedProposalId).toBe(
      "proposal-1",
    );
  });

  it("clears projection when workspace/project scope mismatches", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal()]));
    useChronicleExtractionStore.getState().clearIfScopeMismatch({
      projectId: "project-b",
      workspacePath: "/workspace-a",
      openRevision: 1,
    });
    expect(useChronicleExtractionStore.getState().projection).toBeNull();
  });

  it("keeps projection when scope matches", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal()]));
    useChronicleExtractionStore.getState().clearIfScopeMismatch({
      projectId: "project-a",
      workspacePath: "/workspace-a",
      openRevision: 1,
    });
    expect(useChronicleExtractionStore.getState().projection?.runId).toBe(
      "run-1",
    );
  });

  it("clears Task recovery independently when workspace scope mismatches", () => {
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(RECOVERY_SCOPE, [recoveryCandidate("run-a")]);

    useChronicleExtractionStore.getState().clearIfScopeMismatch({
      ...RECOVERY_SCOPE,
      openRevision: 2,
    });

    expect(useChronicleExtractionStore.getState().recovery).toEqual({
      status: "idle",
      scope: null,
      candidates: [],
      resumingRunId: null,
      errorCode: null,
    });
  });

  it("keeps a discovery error blocked for the matching scope", () => {
    const store = useChronicleExtractionStore.getState();
    store.beginRecoveryDiscovery(RECOVERY_SCOPE);
    store.blockRecovery(
      RECOVERY_SCOPE,
      "NEX_CHRONICLE_RESUME_DISCOVERY_FAILED",
    );
    store.clearIfScopeMismatch(RECOVERY_SCOPE);

    expect(useChronicleExtractionStore.getState().recovery).toMatchObject({
      status: "blocked",
      scope: RECOVERY_SCOPE,
      candidates: [],
      errorCode: "NEX_CHRONICLE_RESUME_DISCOVERY_FAILED",
    });
  });

  it("removes only the terminal candidate and preserves the other Run", () => {
    const first = recoveryCandidate("run-a");
    const second = recoveryCandidate("run-b");
    const store = useChronicleExtractionStore.getState();
    store.setRecoveryCandidates(RECOVERY_SCOPE, [first, second]);
    store.beginCandidateResume(first.runId);
    store.completeCandidateResume(first.runId);

    expect(useChronicleExtractionStore.getState().recovery).toMatchObject({
      status: "ready",
      scope: RECOVERY_SCOPE,
      candidates: [second],
      resumingRunId: null,
      errorCode: null,
    });
  });

  it("test reset clears Task recovery state", () => {
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(RECOVERY_SCOPE, [recoveryCandidate("run-a")]);

    resetChronicleExtractionStoreForTests();

    expect(useChronicleExtractionStore.getState().recovery).toEqual({
      status: "idle",
      scope: null,
      candidates: [],
      resumingRunId: null,
      errorCode: null,
    });
  });

  it("reviseProposalFields applies Native revision id and requires re-approval", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ status: "approved" })]));
    useChronicleExtractionStore.getState().reviseProposalFields(
      "proposal-1",
      "rev-native-2",
      `sha256:${"b".repeat(64)}`,
      {
        status: "probable-duplicate",
        candidates: ["event-existing"],
        reasons: ["title-only"],
      },
      {
        title: "撤退命令",
        secret: false,
      },
    );
    const updated =
      useChronicleExtractionStore.getState().projection?.proposals[0];
    expect(updated?.status).toBe("unreviewed");
    expect(updated?.displayTitle).toBe("撤退命令");
    expect(updated?.payload?.disclosure.secret).toBe(false);
    expect(updated?.revisionId).toBe("rev-native-2");
    expect(updated?.reconciliationEnvelopeDigest).toBe(
      `sha256:${"b".repeat(64)}`,
    );
    expect(updated?.probableDuplicateChoice).toBeNull();
    expect(updated?.match.status).toBe("probable-duplicate");
    expect(updated?.safety).toMatchObject({
      fresh: false,
      noDuplicate: false,
      riskLow: false,
    });
    expect(isBulkApprovalTarget(updated as ChronicleReviewProposal)).toBe(
      false,
    );
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("unreviewed");
  });

  it("(replaces the 7-flag bulkApproveSafe test) targets come from Native's judgement only", () => {
    const safeByFlags = proposal({ proposalId: "safe-flags" });
    const duplicateByFlags = proposal({
      proposalId: "dup-flags",
      match: {
        status: "probable-duplicate",
        candidates: ["event-old"],
        reasons: ["title"],
      },
      safety: buildProposalSafetyFlags({
        match: {
          status: "probable-duplicate",
          candidates: ["event-old"],
          reasons: ["title"],
        },
        actuality: "actual",
        evidenceMethods: ["exact"],
      }),
      bulkApproval: { eligible: true, reasons: [] },
    });
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([safeByFlags, duplicateByFlags]));
    const targets = useChronicleExtractionStore
      .getState()
      .projection?.proposals.filter(isBulkApprovalTarget)
      .map((item) => item.proposalId);
    // Flags green but no judgement yet: not a target. Flags red but Native
    // says eligible: a target.
    expect(targets).toEqual(["dup-flags"]);
  });

  it("local changes make the touched proposal's judgement unknown", () => {
    const eligible = { eligible: true, reasons: [] } as const;
    useChronicleExtractionStore
      .getState()
      .setProjection(
        projection([
          proposal({ proposalId: "a", bulkApproval: eligible }),
          proposal({ proposalId: "b", bulkApproval: eligible }),
        ]),
      );
    useChronicleExtractionStore.getState().updateProposalStatus("a", "held");
    const rows = useChronicleExtractionStore.getState().projection?.proposals;
    expect(rows?.map((item) => item.bulkApproval ?? null)).toEqual([
      null,
      eligible,
    ]);
  });

  describe("Native judgement merge (applyNativeReviewRows)", () => {
    const identity = {
      runId: "run-1",
      projectId: "project-a",
      workspacePath: "/workspace-a",
      openRevision: 1,
    } as const;

    it("updates only the judgement and keeps the author's choices", () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(
          projection([
            proposal({ proposalId: "a", status: "held" }),
            proposal({ proposalId: "b" }),
          ]),
        );
      useChronicleExtractionStore.getState().selectProposal("b");
      const accepted = useChronicleExtractionStore
        .getState()
        .applyNativeReviewRows(identity, [
          {
            proposalId: "a",
            bulkApproval: { eligible: false, reasons: ["held"] },
          },
          { proposalId: "b", bulkApproval: { eligible: true, reasons: [] } },
        ]);
      expect(accepted).toBe(true);
      const state = useChronicleExtractionStore.getState();
      expect(state.selectedProposalId).toBe("b");
      expect(state.projection?.proposals.map((p) => p.status)).toEqual([
        "held",
        "unreviewed",
      ]);
      expect(
        state.projection?.proposals.map((p) => p.bulkApproval?.eligible),
      ).toEqual([false, true]);
    });

    it("drops a result computed for another run, project or workspace", () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal({ proposalId: "a" })]));
      for (const other of [
        { ...identity, runId: "run-2" },
        { ...identity, projectId: "project-b" },
        { ...identity, workspacePath: "/workspace-b" },
        { ...identity, openRevision: 2 },
      ]) {
        expect(
          useChronicleExtractionStore.getState().applyNativeReviewRows(other, [
            {
              proposalId: "a",
              bulkApproval: { eligible: true, reasons: [] },
            },
          ]),
        ).toBe(false);
      }
      expect(
        useChronicleExtractionStore.getState().projection?.proposals[0]
          ?.bulkApproval ?? null,
      ).toBeNull();
    });

    it("makes a proposal missing from Native's answer unknown", () => {
      useChronicleExtractionStore.getState().setProjection(
        projection([
          proposal({
            proposalId: "a",
            bulkApproval: { eligible: true, reasons: [] },
          }),
        ]),
      );
      useChronicleExtractionStore
        .getState()
        .applyNativeReviewRows(identity, []);
      expect(
        useChronicleExtractionStore.getState().projection?.proposals[0]
          ?.bulkApproval,
      ).toBeNull();
    });

    it("copies the new revision and status after a bulk approval", () => {
      useChronicleExtractionStore.getState().setProjection(
        projection([
          proposal({
            proposalId: "a",
            bulkApproval: { eligible: true, reasons: [] },
          }),
        ]),
      );
      useChronicleExtractionStore.getState().applyNativeReviewRows(identity, [
        {
          proposalId: "a",
          bulkApproval: { eligible: false, reasons: ["approved", "edited"] },
          sync: {
            revisionId: "rev-child",
            status: "approved",
            payload: payload({
              disclosure: { secret: false, revealDocumentRef: "doc-1" },
            }),
            reconciliationEnvelopeDigest: `sha256:${"c".repeat(64)}`,
            reconciliationEnvelopeSchemaVersion: 2,
          },
        },
      ]);
      const row =
        useChronicleExtractionStore.getState().projection?.proposals[0];
      expect(row).toMatchObject({
        revisionId: "rev-child",
        status: "approved",
        reconciliationEnvelopeDigest: `sha256:${"c".repeat(64)}`,
      });
      expect(row?.payload?.disclosure.secret).toBe(false);
    });
  });

  it("treats already-satisfied as non-actionable", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          proposalId: "done",
          applicability: "already-satisfied",
          status: "approved",
          payload: null,
          match: { status: "already-satisfied", existingRef: "event-old" },
        }),
      ]),
    );
    useChronicleExtractionStore
      .getState()
      .updateProposalStatus("done", "rejected");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("approved");
  });

  it("keeps Native-applied proposals immutable in the review store", () => {
    const applied = proposal({
      status: "approved",
      application: {
        commitId: "commit-1",
        revisionId: "rev-1",
        appliedEntityKind: "chronicle-event",
        appliedEntityId: "event-1",
        createdAt: "2026-08-26T00:00:00.000Z",
        applicationKind: "normal",
        compensatesApplicationId: null,
      },
    });
    useChronicleExtractionStore.getState().setProjection(projection([applied]));

    const store = useChronicleExtractionStore.getState();
    store.updateProposalStatus("proposal-1", "rejected");
    store.reviseProposalFields(
      "proposal-1",
      "rev-2",
      `sha256:${"c".repeat(64)}`,
      { status: "none" },
      { title: "must not change" },
    );

    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0],
    ).toEqual(applied);
  });

  it("serializes review writes and atomic Apply in both directions", () => {
    const store = useChronicleExtractionStore.getState();

    expect(store.tryBeginApplyMutation()).toBe(true);
    expect(
      useChronicleExtractionStore.getState().tryBeginReviewMutation(),
    ).toBe(false);
    useChronicleExtractionStore.getState().endApplyMutation();

    expect(
      useChronicleExtractionStore.getState().tryBeginReviewMutation(),
    ).toBe(true);
    expect(useChronicleExtractionStore.getState().tryBeginApplyMutation()).toBe(
      false,
    );
    useChronicleExtractionStore.getState().endReviewMutation();

    expect(useChronicleExtractionStore.getState().tryBeginApplyMutation()).toBe(
      true,
    );
    useChronicleExtractionStore.getState().endApplyMutation();
  });

  it("probable-duplicate choices map to skip / create / hold", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          match: {
            status: "probable-duplicate",
            candidates: ["event-old"],
            reasons: ["title"],
          },
        }),
      ]),
    );
    const store = useChronicleExtractionStore.getState();
    store.setProbableDuplicateChoice("proposal-1", "skip-as-same");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("rejected");
    store.setProbableDuplicateChoice("proposal-1", "create-as-new");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]
        ?.probableDuplicateChoice,
    ).toBe("create-as-new");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("approved");
    store.setProbableDuplicateChoice("proposal-1", "hold");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("held");
  });
});
