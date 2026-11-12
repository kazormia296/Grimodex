// @vitest-environment happy-dom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
}));
vi.mock("./api", () => apiMocks);

const extractionMocks = vi.hoisted(() => ({
  USE_NARRATIVE_EXTRACTION_RUN: true,
  discardChronicleTaskResumeCandidate: vi.fn(),
  discoverChronicleTaskResumeCandidates: vi.fn().mockResolvedValue([]),
  startChronicleExtraction: vi.fn(),
  resumeChronicleExtraction: vi.fn(),
  applyChronicleExtractionReview: vi.fn(),
  abandonChroniclePartialReview: vi.fn(),
  restoreChronicleExtractionReview: vi.fn().mockResolvedValue(null),
}));
vi.mock("./extractEventsApi", () => extractionMocks);

const editorMocks = vi.hoisted(() => ({
  saveScene: vi.fn(),
}));
vi.mock("@/features/editor/editorSaveRegistry", () => editorMocks);

const treeApiMocks = vi.hoisted(() => ({
  loadSceneContents: vi.fn(),
  listNodes: vi.fn(),
  loadProjectNarrativeSourceRows: vi.fn(),
}));
vi.mock("@/features/tree/api", () => treeApiMocks);

const sceneLengthMocks = vi.hoisted(() => ({ measure: vi.fn() }));
vi.mock(
  "@/application/narrative-extraction/sceneBodyLength",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/application/narrative-extraction/sceneBodyLength")
    >()),
    measureSceneCanonicalBodyLength: sceneLengthMocks.measure,
  }),
);

const sameSceneMocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./chronicleExtractionApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chronicleExtractionApi")>()),
  hasApprovedUnappliedProposalForScene: sameSceneMocks.read,
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

import { ChronicleExtractDialog } from "./ChronicleExtractDialog";
import { chronicleCurrentSceneOptionValue } from "./chronicleExtractScene";
import { SceneBodyLengthError } from "@/application/narrative-extraction/sceneBodyLength";
import type { ChronicleScope } from "./chronicleScope";
import {
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
  buildProposalSafetyFlags,
  type ChronicleReviewProposal,
} from "./chronicleExtractionStore";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { _resetMutationAuthorityForTests } from "@/features/concurrency/mutationAuthority";
import type { ChronicleTaskResumeCandidate } from "@/application/narrative-extraction/nativeApi";

const SCOPE_A: ChronicleScope = {
  workspacePath: "/workspace-a",
  openRevision: 1,
  projectId: "project-a",
};
const SCOPE_B: ChronicleScope = {
  workspacePath: "/workspace-b",
  openRevision: 2,
  projectId: "project-b",
};

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

function recoveryCandidate(
  runId: string,
  availability: ChronicleTaskResumeCandidate["availability"] = "ready",
): ChronicleTaskResumeCandidate {
  const catalogDigest = `sha256:${"a".repeat(64)}`;
  const coordinatorContractDigest = `sha256:${"b".repeat(64)}`;
  return {
    runId,
    projectId: SCOPE_A.projectId,
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
      status: availability === "lease-held" ? "running" : "queued",
      leaseExpiresAt:
        availability === "lease-held" ? "2099-01-01T00:00:00.000Z" : null,
    },
    availability,
    blockedCode:
      availability === "blocked" ? "NEX_CHRONICLE_RESUME_BLOCKED" : null,
    language: "ja",
    existingEventsCatalog: {
      kind: "chronicle.existing-events-catalog@1",
      events: [],
    },
    createdAt: "2026-08-10T00:00:00.000Z",
    startedAt: "2026-08-10T00:00:01.000Z",
  };
}

function node(
  id: string,
  nodeType: "folder" | "scene",
  parentId: string | null,
): TreeNodeData {
  return {
    id,
    projectId: "project-a",
    parentId,
    nodeType,
    title: id,
    synopsis: null,
    intent: null,
    sortOrder: id,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function publishScope(scope: ChronicleScope): void {
  useProjectStore.setState({ currentProjectId: scope.projectId });
  useWorkspaceStore.setState({
    activeWorkspaceId:
      scope.projectId === "project-a" ? "workspace-a-id" : "workspace-b-id",
    activeWorkspacePath: scope.workspacePath,
    workspaceOpenRevision: scope.openRevision,
    workspaceSwitchInProgress: false,
    workspaceHydrated: true,
  });
  setCurrentWorkspaceIdentity({
    path: scope.workspacePath,
    openRevision: scope.openRevision,
  });
}

function seedProjection(
  overrides: Partial<ChronicleReviewProposal> = {},
): void {
  const proposal: ChronicleReviewProposal = {
    proposalId: "proposal-1",
    revisionId: "rev-1",
    proposalKey: "key-1",
    status: "approved",
    applicability: "applicable",
    displayTitle: "抽出候補",
    payload: {
      eventId: "event-1",
      title: "抽出候補",
      note: null,
      actuality: "actual",
      significance: "major",
      evidenceAnchorIds: ["anchor-1"],
      evidenceDocumentRefs: ["doc-1"],
      disclosure: { secret: false, revealDocumentRef: "doc-1" },
      unresolvedMetadata: {
        participantSurfaces: [],
        locationSurface: null,
        temporalExpressions: [],
      },
    },
    plannedTitle: "抽出候補",
    plannedMatch: { status: "none" },
    match: { status: "none" },
    evidence: [
      {
        anchorId: "anchor-1",
        quote: "本文",
        documentRef: "doc-1",
        sceneId: "scene-a",
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
  useChronicleExtractionStore.getState().setProjection({
    runId: "run-1",
    projectId: SCOPE_A.projectId,
    workspacePath: SCOPE_A.workspacePath,
    openRevision: SCOPE_A.openRevision,
    proposalSetId: "proposal-set-1",
    status: "completed",
    coverage: {
      mode: "complete",
      windowCount: 1,
      completedWindows: 1,
      gaps: [],
    },
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
    },
    proposals: [proposal],
  });
}

async function analyze(): Promise<void> {
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "folder-a" },
  });
  fireEvent.click(screen.getByRole("button", { name: "解析" }));
  await waitFor(() =>
    expect(extractionMocks.startChronicleExtraction).toHaveBeenCalled(),
  );
}

describe("ChronicleExtractDialog run-path cutover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMutationAuthorityForTests();
    resetChronicleExtractionStoreForTests();
    publishScope(SCOPE_A);
    useTreeStore.setState({
      activeSceneId: "",
      nodes: [
        node("folder-a", "folder", null),
        node("scene-a", "scene", "folder-a"),
      ],
    });
    apiMocks.listEvents.mockResolvedValue([]);
    treeApiMocks.loadSceneContents.mockResolvedValue(
      new Map([
        [
          "scene-a",
          JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "本文" }],
              },
            ],
          }),
        ],
      ]),
    );
    extractionMocks.startChronicleExtraction.mockImplementation(async () => {
      seedProjection();
      return { runId: "run-1" };
    });
    extractionMocks.discoverChronicleTaskResumeCandidates.mockReset();
    extractionMocks.discoverChronicleTaskResumeCandidates.mockResolvedValue([]);
    extractionMocks.discardChronicleTaskResumeCandidate.mockReset();
    extractionMocks.discardChronicleTaskResumeCandidate.mockResolvedValue({
      runId: "run-discarded",
    });
    extractionMocks.resumeChronicleExtraction.mockReset();
    extractionMocks.applyChronicleExtractionReview.mockResolvedValue(1);
    extractionMocks.abandonChroniclePartialReview.mockReset();
    extractionMocks.restoreChronicleExtractionReview.mockResolvedValue(null);
  });

  it("分析時に固定したProjectへ取り込み、現在Projectを取り直さない", async () => {
    const onOpenChange = vi.fn();
    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    await analyze();
    expect(await screen.findByText("抽出候補")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));

    await waitFor(() =>
      expect(
        extractionMocks.applyChronicleExtractionReview,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-a",
        }),
      ),
    );
    expect(toastMocks.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("未判断Proposalが残る間は部分Applyを開始しない", async () => {
    seedProjection();
    const current = useChronicleExtractionStore.getState().projection;
    if (!current) throw new Error("expected seeded projection");
    const approved = current.proposals[0];
    if (!approved) throw new Error("expected seeded proposal");
    useChronicleExtractionStore.getState().setProjection({
      ...current,
      proposals: [
        approved,
        {
          ...approved,
          proposalId: "proposal-2",
          revisionId: "rev-2",
          proposalKey: "key-2",
          status: "unreviewed",
          displayTitle: "未判断候補",
          payload: approved.payload
            ? {
                ...approved.payload,
                eventId: "event-2",
                title: "未判断候補",
              }
            : null,
        },
      ],
    });

    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );

    const importButton = screen.getByRole("button", { name: "取り込む" });
    expect(importButton).toBeDisabled();
    fireEvent.click(importButton);
    expect(
      extractionMocks.applyChronicleExtractionReview,
    ).not.toHaveBeenCalled();

    act(() => {
      useChronicleExtractionStore
        .getState()
        .updateProposalStatus("proposal-2", "rejected");
    });
    expect(importButton).toBeEnabled();
    fireEvent.click(importButton);
    await waitFor(() =>
      expect(
        extractionMocks.applyChronicleExtractionReview,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-a",
          proposals: expect.arrayContaining([
            expect.objectContaining({
              proposalId: "proposal-1",
              status: "approved",
            }),
            expect.objectContaining({
              proposalId: "proposal-2",
              status: "rejected",
            }),
          ]),
        }),
      ),
    );
  });

  it("部分Apply済みのcold restoreは再適用を禁止し再解析を案内する", () => {
    seedProjection();
    const current = useChronicleExtractionStore.getState().projection;
    if (!current) throw new Error("expected seeded projection");
    const first = current.proposals[0];
    if (!first?.revisionId) throw new Error("expected seeded revision");
    useChronicleExtractionStore.getState().setProjection({
      ...current,
      proposals: [
        {
          ...first,
          application: {
            commitId: "commit-partial",
            revisionId: first.revisionId,
            appliedEntityKind: "chronicle-event",
            appliedEntityId: "event-1",
            createdAt: "2026-08-26T00:00:00.000Z",
            applicationKind: "normal",
            compensatesApplicationId: null,
          },
        },
        {
          ...first,
          proposalId: "proposal-2",
          revisionId: "rev-2",
          proposalKey: "key-2",
          status: "unreviewed",
          displayTitle: "未適用候補",
          payload: first.payload
            ? {
                ...first.payload,
                eventId: "event-2",
                title: "未適用候補",
              }
            : null,
          application: null,
        },
      ],
    });

    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("chronicle-partial-apply-blocked"),
    ).toHaveTextContent("一部取り込み済み");
    expect(screen.getByText("取り込み済み（再適用しません）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取り込む" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "未適用の提案を破棄" }),
    ).toBeEnabled();
  });

  it("historical partialをdurableに破棄した後だけ新しい解析を許可する", async () => {
    let releaseAbandon!: () => void;
    const abandonGate = new Promise<void>((resolve) => {
      releaseAbandon = resolve;
    });
    seedProjection();
    const current = useChronicleExtractionStore.getState().projection;
    if (!current) throw new Error("expected seeded projection");
    const applied = current.proposals[0];
    if (!applied?.revisionId) throw new Error("expected seeded revision");
    useChronicleExtractionStore.getState().setProjection({
      ...current,
      proposals: [
        {
          ...applied,
          application: {
            commitId: "commit-partial",
            revisionId: applied.revisionId,
            appliedEntityKind: "chronicle-event",
            appliedEntityId: "event-1",
            createdAt: "2026-08-26T00:00:00.000Z",
            applicationKind: "normal",
            compensatesApplicationId: null,
          },
        },
        {
          ...applied,
          proposalId: "proposal-2",
          revisionId: "rev-2",
          proposalKey: "key-2",
          status: "unreviewed",
          displayTitle: "未適用候補",
          payload: applied.payload
            ? {
                ...applied.payload,
                eventId: "event-2",
                title: "未適用候補",
              }
            : null,
          application: null,
        },
      ],
    });
    extractionMocks.abandonChroniclePartialReview.mockImplementationOnce(
      async ({ runId, projectId }) => {
        expect({ runId, projectId }).toEqual({
          runId: "run-1",
          projectId: "project-a",
        });
        await abandonGate;
        useChronicleExtractionStore.getState().clearProjection();
        return { runId, terminalizedProposalCount: 1 };
      },
    );

    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "未適用の提案を破棄" }));
    await waitFor(() =>
      expect(
        extractionMocks.abandonChroniclePartialReview,
      ).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("button", { name: "キャンセル" })).toBeDisabled();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();

    releaseAbandon();
    await waitFor(() =>
      expect(useChronicleExtractionStore.getState().projection).toBeNull(),
    );
    expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chronicle-partial-apply-blocked")).toBeNull();
    expect(screen.getByRole("combobox")).toBeEnabled();

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "folder-a" },
    });
    const analyzeButton = screen.getByRole("button", { name: "解析" });
    expect(analyzeButton).toBeEnabled();
    fireEvent.click(analyzeButton);
    await waitFor(() =>
      expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(1),
    );
  });

  it("Proposal判断の永続化中はApplyを開始しない", () => {
    seedProjection();
    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );
    const importButton = screen.getByRole("button", { name: "取り込む" });
    expect(importButton).toBeEnabled();

    act(() => {
      expect(
        useChronicleExtractionStore.getState().tryBeginReviewMutation(),
      ).toBe(true);
    });
    expect(importButton).toBeDisabled();
    fireEvent.click(importButton);
    expect(
      extractionMocks.applyChronicleExtractionReview,
    ).not.toHaveBeenCalled();

    act(() => {
      useChronicleExtractionStore.getState().endReviewMutation();
    });
    expect(importButton).toBeEnabled();
  });

  it("Apply中は新しいProposal判断・編集を開始しない", async () => {
    let resolveApply!: (count: number) => void;
    extractionMocks.applyChronicleExtractionReview.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        resolveApply = resolve;
      }),
    );
    seedProjection();
    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));
    await waitFor(() =>
      expect(
        extractionMocks.applyChronicleExtractionReview,
      ).toHaveBeenCalledTimes(1),
    );

    expect(useChronicleExtractionStore.getState().applyMutationInFlight).toBe(
      true,
    );
    expect(
      useChronicleExtractionStore.getState().tryBeginReviewMutation(),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "拒否" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保留" })).toBeDisabled();
    expect(screen.getByDisplayValue("抽出候補")).toBeDisabled();
    expect(useChronicleExtractionStore.getState().reviewMutationCount).toBe(0);

    await act(async () => {
      resolveApply(1);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(useChronicleExtractionStore.getState().applyMutationInFlight).toBe(
        false,
      ),
    );
  });

  it("候補表示後にProject authorityが変わるとimport直前に拒否する", async () => {
    const onOpenChange = vi.fn();
    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    await analyze();
    expect(await screen.findByText("抽出候補")).toBeTruthy();
    publishScope(SCOPE_B);
    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(
      extractionMocks.applyChronicleExtractionReview,
    ).not.toHaveBeenCalled();
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("LLM待機中にscopeが変わると候補を破棄してDialogを閉じる", async () => {
    let resolveStart!: (value: { runId: string }) => void;
    extractionMocks.startChronicleExtraction.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    await analyze();
    publishScope(SCOPE_B);
    rerender(
      <ChronicleExtractDialog
        open
        scope={SCOPE_B}
        isActive
        onOpenChange={onOpenChange}
      />,
    );
    await act(async () => {
      seedProjection();
      resolveStart({ runId: "run-stale" });
      await Promise.resolve();
    });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByText("抽出候補")).toBeNull();
    expect(
      extractionMocks.applyChronicleExtractionReview,
    ).not.toHaveBeenCalled();
  });

  it("非アクティブ化するとPortal上のDialogも閉じる", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    rerender(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive={false}
        onOpenChange={onOpenChange}
      />,
    );

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("保存済み候補の実在性不整合を再解析案内として通知する", async () => {
    extractionMocks.restoreChronicleExtractionReview.mockRejectedValue(
      new Error("NEX_CHRONICLE_REANALYSIS_REQUIRED: invalid saved support"),
    );
    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "保存済みの抽出候補を復元できません。本文から再解析してください。",
      ),
    );
    expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
  });

  it.each(["closed", "scope-changed"] as const)(
    "失効した%sダイアログへの遅延復元エラーは通知しない",
    async (invalidation) => {
      let rejectRestore!: (error: Error) => void;
      extractionMocks.restoreChronicleExtractionReview.mockReturnValue(
        new Promise((_, reject) => {
          rejectRestore = reject;
        }),
      );
      const onOpenChange = vi.fn();
      const { rerender } = render(
        <ChronicleExtractDialog
          open
          scope={SCOPE_A}
          isActive
          onOpenChange={onOpenChange}
        />,
      );
      if (invalidation === "scope-changed") act(() => publishScope(SCOPE_B));
      rerender(
        <ChronicleExtractDialog
          open={invalidation !== "closed"}
          scope={invalidation === "scope-changed" ? SCOPE_B : SCOPE_A}
          isActive
          onOpenChange={onOpenChange}
        />,
      );
      await act(async () => {
        rejectRestore(
          new Error("NEX_CHRONICLE_REANALYSIS_REQUIRED: invalid saved support"),
        );
      });
      expect(toastMocks.error).not.toHaveBeenCalled();
    },
  );

  it("再オープン時に同scopeの投影を保持し、legacy propose を呼ばない", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    await analyze();
    expect(await screen.findByText("抽出候補")).toBeTruthy();

    rerender(
      <ChronicleExtractDialog
        open={false}
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );
    rerender(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    expect(await screen.findByText("抽出候補")).toBeTruthy();
    expect(extractionMocks.restoreChronicleExtractionReview).toHaveBeenCalled();
  });

  it("cold-start候補を複数明示し、選んだexact Runだけを再開してfresh開始しない", async () => {
    const first = recoveryCandidate("run-recovery-first");
    const second = recoveryCandidate("run-recovery-second");
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(SCOPE_A, [first, second]);
    extractionMocks.resumeChronicleExtraction.mockImplementation(
      async ({ candidate }: { candidate: ChronicleTaskResumeCandidate }) => {
        seedProjection();
        useChronicleExtractionStore
          .getState()
          .completeCandidateResume(candidate.runId);
        return { runId: candidate.runId };
      },
    );

    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("前回中断した抽出があります")).toBeTruthy();
    expect(
      screen.getByTitle("run-recovery-first · 2026-08-10T00:00:00.000Z")
        .textContent,
    ).toContain("run-recovery-first · 2026-08-10T00:00:00.000Z");
    expect(
      screen.getByTitle("run-recovery-second · 2026-08-10T00:00:00.000Z")
        .textContent,
    ).toContain("run-recovery-second · 2026-08-10T00:00:00.000Z");
    const resumeButtons = screen.getAllByRole("button", {
      name: /^再開 run-recovery-/u,
    });
    expect(resumeButtons).toHaveLength(2);
    fireEvent.click(resumeButtons[1]!);

    await waitFor(() =>
      expect(extractionMocks.resumeChronicleExtraction).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({
            runId: "run-recovery-second",
          }),
          workspacePath: SCOPE_A.workspacePath,
          openRevision: SCOPE_A.openRevision,
        }),
      ),
    );
    expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
    expect(await screen.findByText("抽出候補")).toBeTruthy();
  });

  it("lease-held候補を表示したまま再開もfresh解析も許可しない", async () => {
    const held = recoveryCandidate("run-lease-held", "lease-held");
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(SCOPE_A, [held]);

    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );

    const heldButton = await screen.findByRole("button", {
      name: "処理中 run-lease-held",
    });
    expect(heldButton).toBeDisabled();
    expect(
      screen.queryByRole("button", {
        name: "中断Runを破棄 run-lease-held",
      }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "解析" })).toBeDisabled();
    expect(extractionMocks.resumeChronicleExtraction).not.toHaveBeenCalled();
    expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
  });

  it("candidate discovery failureをblocked表示し、fresh解析へfallbackしない", async () => {
    useChronicleExtractionStore
      .getState()
      .blockRecovery(SCOPE_A, "NEX_CHRONICLE_RESUME_DISCOVERY_FAILED");

    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(
        "中断した抽出の状態を確認できません。新しい解析は開始されません。",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "解析" })).toBeDisabled();
    expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
  });

  it("Snapshot未完了のblocked Runを明示的に破棄し、その後だけfresh解析を許可する", async () => {
    const blocked = recoveryCandidate("run-snapshot-incomplete", "blocked");
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(SCOPE_A, [blocked]);
    extractionMocks.discardChronicleTaskResumeCandidate.mockImplementation(
      async () => {
        useChronicleExtractionStore
          .getState()
          .setRecoveryCandidates(SCOPE_A, []);
        return { runId: blocked.runId };
      },
    );

    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("前回中断した抽出があります")).toBeTruthy();
    expect(screen.getByRole("button", { name: "解析" })).toBeDisabled();
    expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "中断Runを破棄 run-snapshot-incomplete",
      }),
    );
    await waitFor(() =>
      expect(
        extractionMocks.discardChronicleTaskResumeCandidate,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({
            runId: "run-snapshot-incomplete",
          }),
          workspacePath: SCOPE_A.workspacePath,
          openRevision: SCOPE_A.openRevision,
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "解析" })).toBeEnabled(),
    );
    expect(screen.getByRole("combobox")).toHaveValue("folder-a");
    expect(toastMocks.success).toHaveBeenCalledWith(
      "中断した抽出を破棄しました。新しい解析を開始できます。",
    );

    fireEvent.click(screen.getByRole("button", { name: "解析" }));
    await waitFor(() =>
      expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(1),
    );
  });
});

describe("ChronicleExtractDialog 場面 1 つの抽出（SSE/1）", () => {
  const sceneA = chronicleCurrentSceneOptionValue("scene-a");

  function sceneNode(
    id: string,
    parentId: string | null,
    title: string,
  ): TreeNodeData {
    return { ...node(id, "scene", parentId), title };
  }

  function seedTree(activeSceneId: string): void {
    useTreeStore.setState({
      activeSceneId,
      nodes: [
        node("folder-a", "folder", null),
        sceneNode("scene-a", "folder-a", "第一場"),
        sceneNode("scene-b", "folder-a", "第二場"),
        sceneNode("scene-root", null, "直下の場面"),
        { ...node("note-1", "scene", "folder-a"), nodeType: "note" },
      ],
    });
  }

  function renderDialog() {
    return render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={vi.fn()}
      />,
    );
  }

  function select(value: string): void {
    fireEvent.change(screen.getByRole("combobox"), { target: { value } });
  }

  function pressAnalyze(): void {
    fireEvent.click(screen.getByRole("button", { name: "解析" }));
  }

  function startCall(): Record<string, unknown> {
    const call = extractionMocks.startChronicleExtraction.mock.calls[0];
    if (!call) throw new Error("startChronicleExtraction was not called");
    return call[0] as Record<string, unknown>;
  }

  function seedPendingProjection(
    statuses: ChronicleReviewProposal["status"][],
  ): void {
    seedProjection();
    const current = useChronicleExtractionStore.getState().projection;
    const base = current?.proposals[0];
    if (!current || !base) throw new Error("expected seeded projection");
    useChronicleExtractionStore.getState().setProjection({
      ...current,
      proposals: statuses.map((status, index) => ({
        ...base,
        proposalId: `proposal-${index}`,
        revisionId: `rev-${index}`,
        proposalKey: `key-${index}`,
        status,
        displayTitle: `候補${index}`,
        payload: base.payload
          ? {
              ...base.payload,
              eventId: `event-${index}`,
              title: `候補${index}`,
            }
          : null,
      })),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetMutationAuthorityForTests();
    resetChronicleExtractionStoreForTests();
    publishScope(SCOPE_A);
    seedTree("scene-a");
    apiMocks.listEvents.mockResolvedValue([]);
    treeApiMocks.loadSceneContents.mockResolvedValue(new Map());
    extractionMocks.startChronicleExtraction.mockReset();
    extractionMocks.startChronicleExtraction.mockResolvedValue({
      runId: "run-1",
    });
    extractionMocks.discoverChronicleTaskResumeCandidates.mockReset();
    extractionMocks.discoverChronicleTaskResumeCandidates.mockResolvedValue([]);
    extractionMocks.discardChronicleTaskResumeCandidate.mockReset();
    extractionMocks.restoreChronicleExtractionReview.mockResolvedValue(null);
    sceneLengthMocks.measure.mockReset();
    sceneLengthMocks.measure.mockResolvedValue({ canonicalLength: 100 });
    sameSceneMocks.read.mockReset();
    sameSceneMocks.read.mockResolvedValue(false);
  });

  describe("S5/S6 対象の選択", () => {
    it("開いている場面を「今の場面：題」として選べ、select と解析は 1 つのまま", () => {
      renderDialog();
      const option = screen.getByRole("option", { name: "今の場面：第一場" });
      expect(option).toHaveValue(sceneA);
      expect((option as HTMLOptionElement).disabled).toBe(false);
      expect(screen.getAllByRole("combobox")).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "解析" })).toHaveLength(1);
      expect(
        screen.queryByTestId("chronicle-extract-current-scene-unavailable"),
      ).toBeNull();
      // フォルダの option の value はフォルダの id のまま。
      expect(screen.getByRole("option", { name: "folder-a" })).toHaveValue(
        "folder-a",
      );
    });

    it("題が空なら（無名）を出す", () => {
      useTreeStore.setState({
        nodes: useTreeStore
          .getState()
          .nodes.map((n) => (n.id === "scene-a" ? { ...n, title: "" } : n)),
      });
      renderDialog();
      expect(
        screen.getByRole("option", { name: "今の場面：（無名）" }),
      ).toBeTruthy();
    });

    it.each([
      ["", "エディタで場面を開くと、その場面だけを抽出できます。"],
      ["note-1", "開いているのは場面ではないため、今の場面としては選べません"],
      [
        "scene-root",
        "フォルダに入っていない場面は、今の場面としては選べません",
      ],
      ["missing-node", "エディタで場面を開くと、その場面だけを抽出できます。"],
    ])("activeSceneId=%j は選べず、理由を出す", (activeSceneId, reason) => {
      seedTree(activeSceneId);
      renderDialog();
      const option = screen.getByRole("option", { name: "今の場面" });
      expect((option as HTMLOptionElement).disabled).toBe(true);
      expect(
        screen.getByTestId("chronicle-extract-current-scene-unavailable"),
      ).toHaveTextContent(reason);
      expect(screen.getAllByRole("combobox")).toHaveLength(1);
    });

    it("開いている場面は描くたびに導く（後から開いた場面が選べる）", () => {
      seedTree("");
      renderDialog();
      expect(screen.getByRole("option", { name: "今の場面" })).toBeTruthy();
      act(() => useTreeStore.setState({ activeSceneId: "scene-b" }));
      expect(
        screen.getByRole("option", { name: "今の場面：第二場" }),
      ).toBeTruthy();
    });
  });

  describe("開始（S5/S7）", () => {
    it("場面を選んで解析すると、親のフォルダと場面 1 つで requested-direct-children を渡す", async () => {
      renderDialog();
      select(sceneA);
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
      expect(startCall()).toEqual(
        expect.objectContaining({
          projectId: "project-a",
          folderId: "folder-a",
          sceneIds: ["scene-a"],
          sceneScopeMode: "requested-direct-children",
        }),
      );
      // 保存の後に長さを見る。木の全走査（本文の一括読み込み）はしない。
      expect(editorMocks.saveScene).toHaveBeenCalledWith("scene-a");
      expect(sceneLengthMocks.measure).toHaveBeenCalledWith(
        "project-a",
        "scene-a",
      );
      expect(treeApiMocks.loadSceneContents).not.toHaveBeenCalled();
    });

    it("フォルダを選ぶと、今までどおり全場面で sceneScopeMode を渡さない", async () => {
      renderDialog();
      select("folder-a");
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
      const request = startCall();
      expect(request["folderId"]).toBe("folder-a");
      expect(request["sceneIds"]).toEqual(["scene-a", "scene-b"]);
      expect("sceneScopeMode" in request).toBe(false);
      expect(sceneLengthMocks.measure).not.toHaveBeenCalled();
      expect(sameSceneMocks.read).not.toHaveBeenCalled();
    });

    it("選んだ後に開いている場面が変わっても、選んだ場面を対象にし、両方を保存する", async () => {
      renderDialog();
      select(sceneA);
      act(() => useTreeStore.setState({ activeSceneId: "scene-b" }));
      expect(screen.getByRole("combobox")).toHaveValue(sceneA);
      expect(
        screen.getByRole("option", { name: "今の場面：第二場" }),
      ).toBeTruthy();
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
      expect(startCall()["sceneIds"]).toEqual(["scene-a"]);
      expect(editorMocks.saveScene).toHaveBeenCalledWith("scene-b");
      expect(editorMocks.saveScene).toHaveBeenCalledWith("scene-a");
    });

    it("本文が 0 字なら始めず、知らせを出す", async () => {
      sceneLengthMocks.measure.mockResolvedValue({ canonicalLength: 0 });
      renderDialog();
      select(sceneA);
      pressAnalyze();
      await waitFor(() =>
        expect(toastMocks.error).toHaveBeenCalledWith(
          "本文が空のため抽出できません。",
        ),
      );
      expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "解析" })).toBeEnabled();
    });

    it.each([6000, 6001, 12001, 60000])(
      "%i 字でも、長い場面の知らせは出ず、1 回で始まる",
      async (canonicalLength) => {
        sceneLengthMocks.measure.mockResolvedValue({ canonicalLength });
        renderDialog();
        select(sceneA);
        pressAnalyze();
        await waitFor(() =>
          expect(
            extractionMocks.startChronicleExtraction,
          ).toHaveBeenCalledTimes(1),
        );
        expect(
          screen.queryByTestId("chronicle-extract-start-notices"),
        ).toBeNull();
        expect(
          screen.queryByTestId("chronicle-extract-notice-long-scene"),
        ).toBeNull();
        // 長さは測るが、知らせのためには使わない。1 回の押下で測るのは 1 回。
        expect(sceneLengthMocks.measure).toHaveBeenCalledTimes(1);
        expect(toastMocks.error).not.toHaveBeenCalled();
      },
    );

    it("SceneBodyLengthError は一般の失敗として扱い、始めない", async () => {
      sceneLengthMocks.measure.mockRejectedValue(
        new SceneBodyLengthError("SCENE_BODY_UNREADABLE", "bad"),
      );
      renderDialog();
      select(sceneA);
      pressAnalyze();
      await waitFor(() =>
        expect(toastMocks.error).toHaveBeenCalledWith("抽出に失敗しました"),
      );
      expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
    });

    it("選んだ後に場面が消えたら、始めずに理由を出す", async () => {
      renderDialog();
      select(sceneA);
      act(() =>
        useTreeStore.setState({
          nodes: useTreeStore
            .getState()
            .nodes.filter((n) => n.id !== "scene-a"),
        }),
      );
      pressAnalyze();
      await waitFor(() =>
        expect(toastMocks.error).toHaveBeenCalledWith(
          "選んだ場面が見つからないか、フォルダに入っていません。選び直してください。",
        ),
      );
      expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
      expect(screen.getByRole("combobox")).toHaveValue("");
    });

    it("選んだ後に場面がフォルダの外へ移されたら、始めない", async () => {
      renderDialog();
      select(sceneA);
      act(() =>
        useTreeStore.setState({
          nodes: useTreeStore
            .getState()
            .nodes.map((n) =>
              n.id === "scene-a" ? { ...n, parentId: null } : n,
            ),
        }),
      );
      pressAnalyze();
      await waitFor(() => expect(toastMocks.error).toHaveBeenCalled());
      expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
    });
  });

  describe("S8 前の組の提案", () => {
    it("画面の組に未取り込みの提案が残っていても止めず、1 回の解析で始めて toast で知らせる（場面でもフォルダでも）", async () => {
      for (const choose of [sceneA, "folder-a"]) {
        extractionMocks.startChronicleExtraction.mockClear();
        toastMocks.info.mockClear();
        seedPendingProjection(["approved", "held", "rejected"]);
        const { unmount } = renderDialog();
        select(choose);
        pressAnalyze();
        await waitFor(() =>
          expect(
            extractionMocks.startChronicleExtraction,
          ).toHaveBeenCalledTimes(1),
        );
        expect(
          screen.queryByTestId("chronicle-extract-start-notices"),
        ).toBeNull();
        expect(toastMocks.info).toHaveBeenCalledTimes(1);
        const message = String(toastMocks.info.mock.calls[0]?.[0]);
        expect(message).toContain("前の組の提案が2件残っています");
        expect(message).toContain("提案は消えません");
        expect(message).toContain("秘密の印を外した提案は");
        expect(toastMocks.error).not.toHaveBeenCalled();
        unmount();
        resetChronicleExtractionStoreForTests();
      }
    });

    it("止める知らせと同時に当たるときは、一覧の間は toast を出さず、始めるときに出す", async () => {
      sameSceneMocks.read.mockResolvedValue(true);
      seedPendingProjection(["unreviewed"]);
      renderDialog();
      select(sceneA);
      pressAnalyze();
      await screen.findByTestId("chronicle-extract-start-notices");
      expect(toastMocks.info).not.toHaveBeenCalled();
      expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
      expect(toastMocks.info).toHaveBeenCalledTimes(1);
    });

    it("未取り込みの提案が無ければ toast を出さない", async () => {
      seedPendingProjection(["rejected"]);
      renderDialog();
      select("folder-a");
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
      expect(toastMocks.info).not.toHaveBeenCalled();
    });

    it("未取り込みが無ければ（拒否だけ・取り込み済みだけ）知らせず 1 回で始まる", async () => {
      seedPendingProjection(["rejected"]);
      renderDialog();
      select(sceneA);
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
      expect(
        screen.queryByTestId("chronicle-extract-start-notices"),
      ).toBeNull();
    });

    it("画面に組が無ければ（通常の流れ）知らせず 1 回で始まる", async () => {
      renderDialog();
      select("folder-a");
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
    });
  });

  describe("S8b 同じ場面の承認済みで取り込んでいない提案", () => {
    it("該当があれば 1 回目は知らせ、2 回目で始まる", async () => {
      sameSceneMocks.read.mockResolvedValue(true);
      renderDialog();
      select(sceneA);
      pressAnalyze();
      expect(
        await screen.findByTestId(
          "chronicle-extract-notice-same-scene-approved",
        ),
      ).toHaveTextContent("承認済みで取り込んでいない提案があります");
      expect(sameSceneMocks.read).toHaveBeenCalledWith({
        projectId: "project-a",
        sceneId: "scene-a",
      });
      expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
    });

    it("該当が無ければ 1 回で始まる", async () => {
      renderDialog();
      select(sceneA);
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
      expect(
        screen.queryByTestId("chronicle-extract-start-notices"),
      ).toBeNull();
    });

    it("読み取りが失敗したら知らせを出さず、抽出は今までどおり進む", async () => {
      sameSceneMocks.read.mockRejectedValue(new Error("native down"));
      renderDialog();
      select(sceneA);
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
      expect(
        screen.queryByTestId("chronicle-extract-start-notices"),
      ).toBeNull();
      expect(toastMocks.error).not.toHaveBeenCalled();
    });

    it("長い場面でも、出る知らせは同じ場面の知らせだけ", async () => {
      sceneLengthMocks.measure.mockResolvedValue({ canonicalLength: 7000 });
      sameSceneMocks.read.mockResolvedValue(true);
      seedPendingProjection(["unreviewed"]);
      renderDialog();
      select(sceneA);
      pressAnalyze();
      await screen.findByTestId("chronicle-extract-start-notices");
      expect(
        screen.queryByTestId("chronicle-extract-notice-long-scene"),
      ).toBeNull();
      expect(
        screen.getByTestId("chronicle-extract-notice-same-scene-approved"),
      ).toBeTruthy();
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
    });
  });

  it("対象の選択を変えると知らせが消え、最初からになる", async () => {
    sameSceneMocks.read.mockResolvedValue(true);
    renderDialog();
    select(sceneA);
    pressAnalyze();
    await screen.findByTestId("chronicle-extract-start-notices");

    select("folder-a");
    expect(screen.queryByTestId("chronicle-extract-start-notices")).toBeNull();
    select(sceneA);
    pressAnalyze();
    await screen.findByTestId("chronicle-extract-start-notices");
    // 選び直したので、2 回押すまで始まらない。
    expect(extractionMocks.startChronicleExtraction).not.toHaveBeenCalled();
  });

  describe("S9 再開の候補と破棄の後", () => {
    function sceneRunCandidate(
      runId: string,
      scopeJson: { folderId: string; sceneIds: string[] },
      availability: ChronicleTaskResumeCandidate["availability"] = "blocked",
    ): ChronicleTaskResumeCandidate {
      return { ...recoveryCandidate(runId, availability), scopeJson };
    }

    it("場面 1 つの候補は題、消えた場面は削除済み、フォルダの候補は今のまま", async () => {
      useChronicleExtractionStore.getState().setRecoveryCandidates(SCOPE_A, [
        sceneRunCandidate("run-scene", {
          folderId: "folder-a",
          sceneIds: ["scene-a"],
        }),
        sceneRunCandidate("run-gone", {
          folderId: "folder-a",
          sceneIds: ["scene-gone"],
        }),
        sceneRunCandidate("run-folder", {
          folderId: "folder-a",
          sceneIds: ["scene-a", "scene-b"],
        }),
      ]);
      renderDialog();
      const rowText = (runId: string) =>
        screen.getByTitle(`${runId} · 2026-08-10T00:00:00.000Z`).textContent;
      expect(rowText("run-scene")).toContain("場面：第一場");
      expect(rowText("run-gone")).toContain("場面（削除済み）");
      expect(rowText("run-folder")).toContain("folder-a ·");
    });

    it("配下の場面がその 1 つだけのフォルダの候補は、場面 1 つの形でもフォルダの表示", () => {
      useTreeStore.setState({
        nodes: useTreeStore.getState().nodes.filter((n) => n.id !== "scene-b"),
      });
      useChronicleExtractionStore.getState().setRecoveryCandidates(SCOPE_A, [
        sceneRunCandidate("run-single", {
          folderId: "folder-a",
          sceneIds: ["scene-a"],
        }),
      ]);
      renderDialog();
      const text = screen.getByTitle(
        "run-single · 2026-08-10T00:00:00.000Z",
      ).textContent;
      expect(text).toContain("folder-a ·");
      expect(text).not.toContain("場面：");
    });

    async function discard(
      candidate: ChronicleTaskResumeCandidate,
    ): Promise<void> {
      useChronicleExtractionStore
        .getState()
        .setRecoveryCandidates(SCOPE_A, [candidate]);
      extractionMocks.discardChronicleTaskResumeCandidate.mockImplementation(
        async () => {
          useChronicleExtractionStore
            .getState()
            .setRecoveryCandidates(SCOPE_A, []);
          return { runId: candidate.runId };
        },
      );
      renderDialog();
      fireEvent.click(
        await screen.findByRole("button", {
          name: `中断Runを破棄 ${candidate.runId}`,
        }),
      );
      await waitFor(() =>
        expect(toastMocks.success).toHaveBeenCalledWith(
          "中断した抽出を破棄しました。新しい解析を開始できます。",
        ),
      );
    }

    it("場面 1 つの抽出を破棄すると、その場面（開いていなくても）が選ばれ、場面として始まる", async () => {
      seedTree("scene-b");
      await discard(
        sceneRunCandidate("run-scene", {
          folderId: "folder-a",
          sceneIds: ["scene-a"],
        }),
      );
      expect(screen.getByRole("combobox")).toHaveValue(sceneA);
      expect(screen.getByRole("option", { name: "場面：第一場" })).toBeTruthy();
      pressAnalyze();
      await waitFor(() =>
        expect(extractionMocks.startChronicleExtraction).toHaveBeenCalledTimes(
          1,
        ),
      );
      expect(startCall()).toEqual(
        expect.objectContaining({
          folderId: "folder-a",
          sceneIds: ["scene-a"],
          sceneScopeMode: "requested-direct-children",
        }),
      );
    });

    it("場面が消えた・フォルダの外へ移された場合は未選択", async () => {
      useTreeStore.setState({
        nodes: useTreeStore
          .getState()
          .nodes.map((n) =>
            n.id === "scene-a" ? { ...n, parentId: null } : n,
          ),
      });
      await discard(
        sceneRunCandidate("run-scene", {
          folderId: "folder-a",
          sceneIds: ["scene-a"],
        }),
      );
      expect(screen.getByRole("combobox")).toHaveValue("");
    });

    it("フォルダの抽出（場面が複数）は今までどおりフォルダ", async () => {
      await discard(
        sceneRunCandidate("run-folder", {
          folderId: "folder-a",
          sceneIds: ["scene-a", "scene-b"],
        }),
      );
      expect(screen.getByRole("combobox")).toHaveValue("folder-a");
    });

    it("配下の場面がその 1 つだけのフォルダは、場面 1 つの形でもフォルダに戻す", async () => {
      useTreeStore.setState({
        nodes: useTreeStore.getState().nodes.filter((n) => n.id !== "scene-b"),
      });
      await discard(
        sceneRunCandidate("run-single", {
          folderId: "folder-a",
          sceneIds: ["scene-a"],
        }),
      );
      expect(screen.getByRole("combobox")).toHaveValue("folder-a");
    });
  });
});
