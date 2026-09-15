// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexEntry } from "./api";

const { listRelationsMock, reviewState, codexState, treeState, sceneNodes } =
  vi.hoisted(() => ({
    listRelationsMock: vi.fn(),
    reviewState: {
      typedReview: null,
      typedDecisionBusy: false,
      typedPrepareBusy: false,
      typedDecisionError: null,
      prepareTypedReview: vi.fn(),
      handleTypedDecision: vi.fn(),
      replaceTypedReview: vi.fn(),
      clearTypedReview: vi.fn(),
    },
    codexState: { entries: [] as CodexEntry[] },
    treeState: { nodes: [] as unknown[] },
    sceneNodes: [{ id: "scene-1", projectId: "p1", title: "Scene" }],
  }));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
  useCurrentProjectId: () => "p1",
}));
vi.mock("@/features/tree/treeStore", () => ({
  getAllProjectScenesInOrder: () => sceneNodes,
  useTreeStore: (selector: (state: { nodes: unknown[] }) => unknown) =>
    selector(treeState),
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (
    selector: (state: {
      activeWorkspacePath: string;
      workspaceOpenRevision: number;
    }) => unknown,
  ) =>
    selector({ activeWorkspacePath: "/workspace", workspaceOpenRevision: 1 }),
}));
vi.mock("@/features/concurrency/mutationAuthority", () => ({
  captureMutationAuthority: vi.fn(() => ({
    projectId: "p1",
    currentProjectId: () => "p1",
    workspacePath: "/workspace",
    workspaceOpenRevision: 1,
  })),
}));
vi.mock("./codexStore", () => ({
  useCodexStore: (selector: (state: { entries: CodexEntry[] }) => unknown) =>
    selector(codexState),
}));
vi.mock("./codexRelationApi", () => ({
  listCodexRelations: listRelationsMock,
}));
vi.mock("./useCodexEntityRelationReview", () => ({
  useCodexEntityRelationReview: () => reviewState,
}));

import {
  buildBoundedCodexEntityRelationProposalKey,
  buildCodexEntityRelationSelectionIdentity,
  CodexEntityRelationReviewDialog,
  getOrCreateCodexEntityRelationAttemptId,
} from "./CodexEntityRelationReviewDialog";

const entry = {
  id: "entry-1",
  projectId: "p1",
  name: "主人公",
  type: "character",
} as unknown as CodexEntry;

describe("CodexEntityRelationReviewDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codexState.entries = [entry];
    listRelationsMock.mockResolvedValue([]);
    reviewState.typedReview = null;
  });

  it("opens the direct typed preparation surface without a render loop", async () => {
    render(
      <CodexEntityRelationReviewDialog
        entry={entry}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByTestId("nir1-entity-relation-prepare-dialog"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("nir1-typed-scene-scope")).toBeInTheDocument();
    expect(screen.getByText(/本文Evidenceではありません/)).toBeInTheDocument();
  });

  it("keeps the reason and direct Prepare selectors after an unavailable cold restore", async () => {
    reviewState.typedReview = {
      runId: "old-typed-run",
      status: "unavailable",
      result: null,
      decision: null,
      receipt: null,
      unavailableReason: "revision-restore-invalidated",
    } as never;
    render(
      <CodexEntityRelationReviewDialog
        entry={entry}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByTestId("nir1-typed-unavailable-reason"),
    ).toHaveTextContent("revision-restore-invalidated");
    expect(screen.getByTestId("nir1-typed-scene-scope")).toBeInTheDocument();
    const prepare = screen.getByTestId("nir1-typed-prepare");
    expect(prepare).toBeInTheDocument();
    fireEvent.click(prepare);
    expect(reviewState.prepareTypedReview).toHaveBeenCalledTimes(1);
  });

  it("bounds selection proposal payloads and separates recovery attempts", () => {
    const entityIds = Array.from(
      { length: 512 },
      (_, index) => `entity-${index}-${"x".repeat(80)}`,
    );
    const relationIds = Array.from(
      { length: 512 },
      (_, index) => `relation-${index}-${"y".repeat(80)}`,
    );
    const selectionIdentity = buildCodexEntityRelationSelectionIdentity({
      projectId: "project-" + "p".repeat(180),
      sceneId: "scene-" + "s".repeat(180),
      entityIds,
      relationIds,
    });
    const attempts = new Map<string, string>();
    const selectionAttempt = getOrCreateCodexEntityRelationAttemptId(
      attempts,
      selectionIdentity,
    );
    const repeatedAttempt = getOrCreateCodexEntityRelationAttemptId(
      attempts,
      selectionIdentity,
    );
    const otherAttempt = getOrCreateCodexEntityRelationAttemptId(
      attempts,
      `${selectionIdentity}:other`,
    );
    const selectionProposalKey = buildBoundedCodexEntityRelationProposalKey(
      "selection",
      selectionAttempt,
    );
    const recoveryProposalKey = buildBoundedCodexEntityRelationProposalKey(
      "recovery",
      selectionAttempt,
    );
    const otherSelectionProposalKey =
      buildBoundedCodexEntityRelationProposalKey("selection", otherAttempt);

    expect(selectionIdentity.length).toBeGreaterThan(256);
    expect(repeatedAttempt).toBe(selectionAttempt);
    expect(otherAttempt).not.toBe(selectionAttempt);
    expect(selectionProposalKey.length).toBeLessThanOrEqual(256);
    expect(recoveryProposalKey.length).toBeLessThanOrEqual(256);
    expect(recoveryProposalKey).not.toBe(selectionProposalKey);
    expect(otherSelectionProposalKey).not.toBe(selectionProposalKey);
  });

  it("sends a bounded and stable proposal key for a large actual selection", async () => {
    const largeEntries = Array.from({ length: 32 }, (_, index) => ({
      id: `entry-${index}`,
      projectId: "p1",
      name: `Entry ${index}`,
      type: "character",
    })) as unknown as CodexEntry[];
    codexState.entries = largeEntries;
    render(
      <CodexEntityRelationReviewDialog
        entry={largeEntries[0]}
        open
        onOpenChange={vi.fn()}
      />,
    );
    await screen.findByTestId("nir1-typed-entity-selector");
    for (const candidate of largeEntries.slice(1)) {
      fireEvent.click(screen.getByTestId(`nir1-typed-entity-${candidate.id}`));
    }
    const prepare = screen.getByTestId("nir1-typed-prepare");
    fireEvent.click(prepare);
    fireEvent.click(prepare);

    expect(reviewState.prepareTypedReview).toHaveBeenCalledTimes(2);
    const firstProposalKey =
      reviewState.prepareTypedReview.mock.calls[0]?.[0]?.proposalKey;
    const secondProposalKey =
      reviewState.prepareTypedReview.mock.calls[1]?.[0]?.proposalKey;
    expect(typeof firstProposalKey).toBe("string");
    expect(firstProposalKey.length).toBeLessThanOrEqual(256);
    expect(secondProposalKey).toBe(firstProposalKey);
  });
});
