// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexEntry } from "./api";

const {
  captureAuthorityMock,
  decideMock,
  listRelationsMock,
  prepareMock,
  readCurrentMock,
  restoreMock,
  codexState,
  sceneNodes,
  treeState,
  workspaceState,
} = vi.hoisted(() => {
  const state = {
    activeWorkspacePath: "/workspace",
    workspaceOpenRevision: 1,
  };
  const captureAuthority = vi.fn(() => ({
    projectId: "p1",
    currentProjectId: () => "p1",
    workspacePath: "/workspace",
    workspaceOpenRevision: 1,
  }));
  return {
    captureAuthorityMock: captureAuthority,
    codexState: { entries: [] as CodexEntry[] },
    decideMock: vi.fn(),
    listRelationsMock: vi.fn(),
    prepareMock: vi.fn(),
    readCurrentMock: vi.fn(),
    restoreMock: vi.fn(),
    sceneNodes: [{ id: "scene-1", projectId: "p1", title: "Scene" }],
    treeState: { nodes: [] as unknown[] },
    workspaceState: state,
  };
});

const entry = {
  id: "entry-1",
  projectId: "p1",
  name: "主人公",
  type: "character",
} as unknown as CodexEntry;
const entryB = {
  id: "entry-2",
  projectId: "p1",
  name: "相棒",
  type: "character",
} as unknown as CodexEntry;

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
  useWorkspaceStore: Object.assign(
    (selector: (state: typeof workspaceState) => unknown) =>
      selector(workspaceState),
    { getState: () => workspaceState },
  ),
}));
vi.mock("@/features/concurrency/mutationAuthority", () => ({
  captureMutationAuthority: captureAuthorityMock,
  isCurrentMutationAuthority: () => true,
}));
vi.mock("./codexStore", () => ({
  useCodexStore: (selector: (state: { entries: CodexEntry[] }) => unknown) =>
    selector(codexState),
}));
vi.mock("./codexRelationApi", () => ({
  listCodexRelations: listRelationsMock,
}));
vi.mock("./codexEntityRelationReviewApi", () => ({
  prepareCodexEntityRelationReview: prepareMock,
  replacementPrepareInput: vi.fn(),
  restoreCodexEntityRelationReview: restoreMock,
}));
vi.mock(
  "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi",
  () => ({
    decideNir1EntityRelationRevision: decideMock,
    readCurrentNir1EntityRelationRevision: readCurrentMock,
  }),
);

import { CodexEntityRelationReviewDialog } from "./CodexEntityRelationReviewDialog";

codexState.entries = [entry, entryB];

function preparedResult() {
  return {
    runId: "retried-run",
    status: "draft" as const,
    receipt: {
      proposalSetId: "set-1",
      proposalId: "proposal-1",
      revisionId: "revision-1",
      status: "unreviewed" as const,
    },
  };
}

function availableReviewResult() {
  return {
    projectId: "p1",
    runId: "approved-a-run",
    proposalSetId: "set-a",
    proposalId: "proposal-a",
    revisionId: "revision-a",
    sceneId: "scene-1",
    entities: [
      {
        entityId: "entry-1",
        entityType: "character",
        label: "主人公",
        evidence: [],
      },
    ],
    relations: [],
  };
}

describe("CodexEntityRelationReviewDialog prepare errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRelationsMock.mockResolvedValue([]);
    restoreMock.mockResolvedValue(null);
    prepareMock
      .mockRejectedValueOnce(new Error("NIR1 prepare rejected"))
      .mockResolvedValueOnce(preparedResult());
    readCurrentMock.mockResolvedValue({
      status: "unavailable",
      result: { reason: "typed-review-evidence-unavailable" },
    });
    decideMock.mockReset();
  });

  it("shows an initial Prepare rejection in the real Dialog and permits retry", async () => {
    render(
      <CodexEntityRelationReviewDialog
        entry={entry}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const prepare = await screen.findByTestId("nir1-typed-prepare");
    fireEvent.click(prepare);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "NIR1 prepare rejected",
    );

    await waitFor(() => expect(prepare).not.toBeDisabled());
    fireEvent.click(prepare);
    await waitFor(() => expect(prepareMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("nir1-typed-prepare")).not.toBeDisabled();
  });

  it("keeps a matching approved Run intact while preparing a different launcher target", async () => {
    prepareMock.mockReset();
    prepareMock.mockResolvedValue(preparedResult());
    restoreMock.mockReset();
    restoreMock
      .mockResolvedValueOnce({
        runId: "approved-a-run",
        response: { status: "available", result: availableReviewResult() },
      })
      .mockResolvedValueOnce(null);

    const { rerender } = render(
      <CodexEntityRelationReviewDialog
        entry={entry}
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(
      await screen.findByTestId("nir1-entity-relation-review-panel"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nir1-typed-start-new"));
    expect(
      await screen.findByTestId("nir1-typed-entity-selector"),
    ).toBeInTheDocument();

    rerender(
      <CodexEntityRelationReviewDialog
        entry={entryB}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const prepare = await screen.findByTestId("nir1-typed-prepare");
    fireEvent.click(prepare);
    await waitFor(() => expect(prepareMock).toHaveBeenCalledOnce());
    expect(prepareMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityIds: ["entry-2"],
        relationIds: [],
      }),
    );
    expect(restoreMock).toHaveBeenNthCalledWith(1, "p1", "/workspace", {
      entityId: "entry-1",
      relationId: null,
    });
    expect(restoreMock).toHaveBeenNthCalledWith(2, "p1", "/workspace", {
      entityId: "entry-2",
      relationId: null,
    });
  });

  it("opens B as a fresh launcher after A is closed and does not decide A again", async () => {
    prepareMock.mockReset();
    prepareMock.mockResolvedValue(preparedResult());
    restoreMock.mockReset();
    restoreMock
      .mockResolvedValueOnce({
        runId: "approved-a-run",
        response: { status: "available", result: availableReviewResult() },
      })
      .mockResolvedValueOnce(null);

    const first = render(
      <CodexEntityRelationReviewDialog
        entry={entry}
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(
      await screen.findByTestId("nir1-entity-relation-review-panel"),
    ).toBeInTheDocument();
    first.unmount();

    render(
      <CodexEntityRelationReviewDialog
        entry={entryB}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const prepare = await screen.findByTestId("nir1-typed-prepare");
    fireEvent.click(prepare);
    await waitFor(() => expect(prepareMock).toHaveBeenCalledOnce());
    expect(prepareMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityIds: ["entry-2"],
        relationIds: [],
      }),
    );
    expect(decideMock).not.toHaveBeenCalled();
  });
});
