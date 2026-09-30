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

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

import { ChronicleExtractDialog } from "./ChronicleExtractDialog";
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
