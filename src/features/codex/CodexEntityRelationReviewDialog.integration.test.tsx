// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexEntry } from "./api";

type NativeRun = {
  readonly runId: string;
  readonly result: Record<string, unknown>;
  status: "draft" | "available";
  decision: "approved" | "rejected" | "deferred" | null;
};

const {
  captureAuthorityMock,
  captureBindingMock,
  decideMock,
  listRelationsMock,
  listRunsMock,
  nativePrepareMock,
  nativeReadCurrentMock,
  nativeState,
  sceneNodes,
  treeState,
  codexState,
  workspaceState,
} = vi.hoisted(() => {
  const state: {
    nextRunNumber: number;
    runs: Map<string, NativeRun>;
    proposalRuns: Map<string, NativeRun>;
    decisions: Array<Record<string, unknown>>;
  } = {
    nextRunNumber: 0,
    runs: new Map(),
    proposalRuns: new Map(),
    decisions: [],
  };
  return {
    captureAuthorityMock: vi.fn(),
    captureBindingMock: vi.fn(),
    decideMock: vi.fn(),
    listRelationsMock: vi.fn(),
    listRunsMock: vi.fn(),
    nativePrepareMock: vi.fn(),
    nativeReadCurrentMock: vi.fn(),
    nativeState: state,
    sceneNodes: [{ id: "scene-1", projectId: "p1", title: "Scene" }],
    treeState: { nodes: [] as unknown[] },
    codexState: { entries: [] as CodexEntry[] },
    workspaceState: {
      activeWorkspacePath: "/workspace",
      workspaceOpenRevision: 1,
    },
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
  runAuthoritativeMutation: async (
    _authority: unknown,
    mutation: () => Promise<unknown>,
  ) => ({
    status: "current" as const,
    value: await mutation(),
  }),
}));
vi.mock("./codexStore", () => ({
  useCodexStore: (selector: (state: { entries: CodexEntry[] }) => unknown) =>
    selector(codexState),
}));
vi.mock("./codexRelationApi", () => ({
  listCodexRelations: listRelationsMock,
}));

// Exercise the real renderer coordinator; only its Native-facing dependencies
// are mocked so restore selection and prepare failure handling stay in scope.
vi.mock("@/application/narrative-extraction/nativeApi", () => ({
  captureNarrativeExtractionWorkspaceBinding: captureBindingMock,
  narrativeExtractionListResumableRuns: listRunsMock,
}));
vi.mock(
  "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi",
  () => ({
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH: "nir1/entity-relation-review",
    decideNir1EntityRelationRevision: decideMock,
    prepareNir1EntityRelationRevision: nativePrepareMock,
    readCurrentNir1EntityRelationRevision: nativeReadCurrentMock,
  }),
);

import { CodexEntityRelationReviewDialog } from "./CodexEntityRelationReviewDialog";

codexState.entries = [entry, entryB];

function createResult(
  runId: string,
  payload: {
    projectId: string;
    sceneId: string;
    entityIds: readonly string[];
    relationIds: readonly string[];
  },
) {
  return {
    projectId: payload.projectId,
    runId,
    proposalSetId: `${runId}-set`,
    proposalId: `${runId}-proposal`,
    revisionId: `${runId}-revision`,
    sceneId: payload.sceneId,
    entities: payload.entityIds.map((entityId) => ({
      entityId,
      entityType: "character",
      label: entityId === "entry-1" ? "主人公" : "相棒",
      evidence: [],
    })),
    relations: payload.relationIds.map((edgeId) => ({
      edgeId,
      fromEntityId: "entry-1",
      toEntityId: "entry-2",
      relationType: "knows",
      directionality: "directed" as const,
      evidenceIds: [],
    })),
  };
}

function installStatefulNativeMocks() {
  captureAuthorityMock.mockImplementation(() => ({
    projectId: "p1",
    currentProjectId: () => "p1",
    workspacePath: "/workspace",
    workspaceOpenRevision: 1,
  }));
  captureBindingMock.mockResolvedValue({
    authorityId: "authority-1",
    generation: 1,
    authorityInstanceId: "1",
  });
  listRunsMock.mockImplementation(async () =>
    [...nativeState.runs.values()].reverse().map((run) => ({
      runId: run.runId,
      projectId: "p1",
      surfacePathId: "nir1/entity-relation-review",
    })),
  );
  nativePrepareMock.mockImplementation(async (rawPayload: unknown) => {
    const payload = rawPayload as {
      projectId: string;
      sceneId: string;
      entityIds: readonly string[];
      relationIds: readonly string[];
      proposalKey?: string | null;
    };
    const existing = payload.proposalKey
      ? nativeState.proposalRuns.get(payload.proposalKey)
      : undefined;
    if (existing) {
      return {
        runId: existing.runId,
        status: "draft" as const,
        receipt: {
          proposalSetId: `${existing.runId}-set`,
          proposalId: `${existing.runId}-proposal`,
          revisionId: `${existing.runId}-revision`,
          status: "unreviewed" as const,
        },
      };
    }
    const runId = `run-${++nativeState.nextRunNumber}`;
    const run: NativeRun = {
      runId,
      result: createResult(runId, payload),
      status: "draft",
      decision: null,
    };
    nativeState.runs.set(runId, run);
    if (payload.proposalKey) {
      nativeState.proposalRuns.set(payload.proposalKey, run);
    }
    return {
      runId,
      status: "draft" as const,
      receipt: {
        proposalSetId: `${runId}-set`,
        proposalId: `${runId}-proposal`,
        revisionId: `${runId}-revision`,
        status: "unreviewed" as const,
      },
    };
  });
  nativeReadCurrentMock.mockImplementation(
    async ({ runId }: { runId: string }) => {
      const run = nativeState.runs.get(runId);
      if (!run) {
        return {
          status: "unavailable" as const,
          result: { reason: "run-missing" },
        };
      }
      return { status: run.status, result: run.result };
    },
  );
  decideMock.mockImplementation(
    async (decisionRequest: Record<string, unknown>) => {
      nativeState.decisions.push({ ...decisionRequest });
      const run = nativeState.runs.get(String(decisionRequest.runId));
      if (run) {
        run.decision = decisionRequest.decision as NativeRun["decision"];
        if (decisionRequest.decision === "approved") run.status = "available";
      }
      return { status: decisionRequest.decision };
    },
  );
}

beforeEach(() => {
  for (const mock of [
    captureAuthorityMock,
    captureBindingMock,
    decideMock,
    listRelationsMock,
    listRunsMock,
    nativePrepareMock,
    nativeReadCurrentMock,
  ]) {
    mock.mockReset();
  }
  nativeState.nextRunNumber = 0;
  nativeState.runs.clear();
  nativeState.proposalRuns.clear();
  nativeState.decisions.length = 0;
  listRelationsMock.mockResolvedValue([]);
  installStatefulNativeMocks();
});

async function prepareAndApprove(entryToPrepare: CodexEntry) {
  const prepare = await screen.findByTestId("nir1-typed-prepare");
  fireEvent.click(prepare);
  const approve = await screen.findByTestId("nir1-typed-approve");
  expect(
    screen.getByTestId("nir1-typed-entity-row-" + entryToPrepare.id),
  ).toBeInTheDocument();
  fireEvent.click(approve);
  await waitFor(() =>
    expect(screen.getByTestId("nir1-typed-status")).toHaveTextContent(
      "利用可能",
    ),
  );
}

function ControlledReviewLauncher({
  entryToPrepare,
}: {
  entryToPrepare: CodexEntry;
}) {
  const [open, setOpen] = useState(true);
  return (
    <CodexEntityRelationReviewDialog
      entry={entryToPrepare}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

describe("CodexEntityRelationReviewDialog Native-boundary integration", () => {
  it("shows a rejected initial Prepare reason in the real Dialog and permits retry", async () => {
    nativePrepareMock.mockRejectedValueOnce(new Error("NIR1 prepare rejected"));
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
    await waitFor(() =>
      expect(
        screen.getByTestId("nir1-typed-entity-row-entry-1"),
      ).toBeInTheDocument(),
    );
    expect(nativePrepareMock).toHaveBeenCalledTimes(2);
  });

  it("moves a matching restored approved review to new selectors without changing its Decision", async () => {
    const first = render(
      <CodexEntityRelationReviewDialog
        entry={entry}
        open
        onOpenChange={vi.fn()}
      />,
    );
    await prepareAndApprove(entry);
    first.unmount();

    render(
      <CodexEntityRelationReviewDialog
        entry={entry}
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(
      await screen.findByTestId("nir1-entity-relation-review-panel"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("nir1-typed-status")).toHaveTextContent(
      "利用可能",
    );
    fireEvent.click(screen.getByTestId("nir1-typed-start-new"));
    expect(
      await screen.findByTestId("nir1-typed-entity-selector"),
    ).toBeInTheDocument();
    expect(nativeState.decisions).toEqual([
      expect.objectContaining({
        runId: "run-1",
        decision: "approved",
      }),
    ]);
  });

  it("prepares B after A is approved and closed while retaining A's persisted Decision", async () => {
    const first = render(<ControlledReviewLauncher entryToPrepare={entry} />);
    await prepareAndApprove(entry);
    expect(nativeState.decisions).toHaveLength(1);
    expect(nativeState.decisions[0]).toMatchObject({
      runId: "run-1",
      decision: "approved",
    });
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    await waitFor(() =>
      expect(
        screen.queryByTestId("nir1-entity-relation-prepare-dialog"),
      ).not.toBeInTheDocument(),
    );
    first.unmount();

    const second = render(
      <CodexEntityRelationReviewDialog
        entry={entryB}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const prepareB = await screen.findByTestId("nir1-typed-prepare");
    fireEvent.click(prepareB);
    await waitFor(() =>
      expect(
        screen.getByTestId("nir1-typed-entity-row-entry-2"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("nir1-typed-status")).toHaveTextContent("未承認");
    expect(nativeState.decisions).toHaveLength(1);
    expect(nativeState.decisions[0]).toMatchObject({
      runId: "run-1",
      decision: "approved",
    });
    second.unmount();

    render(
      <CodexEntityRelationReviewDialog
        entry={entry}
        open
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("nir1-typed-entity-row-entry-1"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("nir1-typed-status")).toHaveTextContent(
      "利用可能",
    );
    expect(nativeState.decisions).toHaveLength(1);
  });
});
