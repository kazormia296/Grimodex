// @vitest-environment happy-dom
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Nir1ChangeReviewResponse } from "@/features/narrative-semantic-core/nir1ChangeReviewApi";
import type { Nir1EntityRelationRevisionReadResult } from "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi";
import { CodexEntityRelationChangeReviewSection } from "./CodexEntityRelationChangeReviewSection";
import { CodexEntityRelationRevisionReviewPanel } from "./CodexEntityRelationRevisionReviewPanel";

const { readMock, workspace } = vi.hoisted(() => ({
  readMock: vi.fn(),
  workspace: { activeWorkspacePath: "/workspace-1", workspaceOpenRevision: 1 },
}));

vi.mock("@/features/narrative-semantic-core/nir1ChangeReviewApi", () => ({
  readNir1ChangeReview: readMock,
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: <T,>(selector: (state: typeof workspace) => T) =>
    selector(workspace),
}));

function sampleResult(
  revisionId = "revision-2",
): Nir1EntityRelationRevisionReadResult {
  const entity = (entityId: string, label: string) => ({
    entityId,
    entityType: "character",
    label,
    evidence: [],
  });
  return {
    projectId: "project-1",
    runId: "run-1",
    proposalSetId: "set-1",
    proposalId: "proposal-1",
    revisionId,
    sceneId: "scene-1",
    entities: [entity("alice", "アリス"), entity("bob", "ボブ")],
    relations: [
      {
        edgeId: "edge-1",
        fromEntityId: "alice",
        toEntityId: "bob",
        relationType: "friend_of",
        directionality: "symmetric",
        evidenceIds: [],
      },
    ],
  };
}

const evidence = (
  quote: string,
  change: "unchanged" | "relocated" | "lost" | "gained",
) => ({ sourceRef: "codex:alice", quote, change });

const object = (
  identity: string,
  change: "added" | "removed" | "unchanged" | "content-changed" | "unresolved",
  items: ReturnType<typeof evidence>[] = [],
  evidenceWithheld = false,
) => ({ identity, change, evidence: items, evidenceWithheld });

function available(
  objects: ReturnType<typeof object>[],
  previousRevisionIds = ["revision-1"],
  revisionId = "revision-2",
): Nir1ChangeReviewResponse {
  return {
    status: "available",
    result: { revisionId, previousRevisionIds, objects },
  };
}

const section = () => screen.findByTestId("nir1-change-review");

describe("CodexEntityRelationChangeReviewSection", () => {
  beforeEach(() => {
    readMock.mockReset();
  });

  it("reads the current revision of the active workspace and shows each change", async () => {
    readMock.mockResolvedValue(
      available([
        object("codex:alice", "content-changed", [
          evidence("彼女は鍵を拾った", "relocated"),
          evidence("剣を抜いた", "lost"),
        ]),
        object("codex:bob", "unchanged"),
        object("codex-relation:edge-1", "added"),
      ]),
    );
    render(<CodexEntityRelationChangeReviewSection result={sampleResult()} />);

    const element = await section();
    expect(readMock).toHaveBeenCalledExactlyOnceWith({
      expectedWorkspacePath: "/workspace-1",
      projectId: "project-1",
      revisionId: "revision-2",
    });
    expect(element).toHaveTextContent("前に承認した版との違い");
    expect(screen.getByTestId("nir1-change-row-codex:alice")).toHaveTextContent(
      "アリス(character)元の項目が更新されています「彼女は鍵を拾った」引用の位置が変わりました「剣を抜いた」引用がなくなりました",
    );
    expect(screen.getByTestId("nir1-change-row-codex:bob")).toHaveTextContent(
      "ボブ(character)変化はありません",
    );
    expect(
      screen.getByTestId("nir1-change-row-codex-relation:edge-1"),
    ).toHaveTextContent("アリス → ボブ(関係)今回はじめて入りました");
    expect(element).toHaveTextContent(
      "※「更新されています」は、保存し直しただけでも表示します",
    );
  });

  it("says there is nothing to compare when no object has a prior approval", async () => {
    readMock.mockResolvedValue(available([object("codex:alice", "added")], []));
    render(<CodexEntityRelationChangeReviewSection result={sampleResult()} />);

    expect(await section()).toHaveTextContent("比べる承認済みの版がありません");
    expect(screen.queryByTestId("nir1-change-row-codex:alice")).toBeNull();
    expect(screen.queryByText(/保存し直しただけでも/)).toBeNull();
  });

  it("keeps the rows when a prior revision could not be determined", async () => {
    readMock.mockResolvedValue(
      available([object("codex:alice", "unresolved")], []),
    );
    render(<CodexEntityRelationChangeReviewSection result={sampleResult()} />);

    await section();
    expect(screen.getByTestId("nir1-change-row-codex:alice")).toHaveTextContent(
      "前の版を確かめられません",
    );
  });

  it("never shows removed objects or withheld quotes", async () => {
    readMock.mockResolvedValue(
      available([
        object("codex:alice", "unchanged", [evidence("秘密", "gained")], true),
        object("codex:gone", "removed"),
      ]),
    );
    render(<CodexEntityRelationChangeReviewSection result={sampleResult()} />);

    const element = await section();
    expect(element).not.toHaveTextContent("秘密");
    expect(screen.queryByTestId("nir1-change-row-codex:gone")).toBeNull();
  });

  it.each([
    [
      "unavailable",
      () =>
        Promise.resolve<Nir1ChangeReviewResponse>({
          status: "unavailable",
          result: { reason: "current-revision-unavailable" },
        }),
    ],
    ["rejected", () => Promise.reject(new Error("D2A_EGRESS_DENIED"))],
    [
      "another revision",
      () => Promise.resolve(available([], [], "revision-9")),
    ],
  ])("shows only that it cannot be displayed when %s", async (_, respond) => {
    readMock.mockImplementation(respond);
    render(<CodexEntityRelationChangeReviewSection result={sampleResult()} />);

    expect(await section()).toHaveTextContent("違いを表示できません");
  });

  it("drops a late answer for a revision that is no longer shown", async () => {
    let resolveFirst!: (response: Nir1ChangeReviewResponse) => void;
    readMock
      .mockReturnValueOnce(
        new Promise<Nir1ChangeReviewResponse>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue(
        available(
          [object("codex:bob", "unchanged")],
          ["revision-2"],
          "revision-3",
        ),
      );
    const view = render(
      <CodexEntityRelationChangeReviewSection result={sampleResult()} />,
    );
    view.rerender(
      <CodexEntityRelationChangeReviewSection
        result={sampleResult("revision-3")}
      />,
    );
    await section();
    await act(async () => {
      resolveFirst(available([object("codex:alice", "added")]));
    });

    expect(screen.getByTestId("nir1-change-row-codex:bob")).toBeTruthy();
    expect(screen.queryByTestId("nir1-change-row-codex:alice")).toBeNull();
  });

  it("is loaded by the review panel only while the revision is readable", async () => {
    readMock.mockResolvedValue(available([object("codex:alice", "unchanged")]));
    const panel = (status: "draft" | "unavailable") => (
      <CodexEntityRelationRevisionReviewPanel
        status={status}
        runId="run-1"
        result={sampleResult()}
        decision={null}
      />
    );
    const view = render(panel("unavailable"));
    await Promise.resolve();
    expect(readMock).not.toHaveBeenCalled();

    view.rerender(panel("draft"));
    await section();
    await waitFor(() => expect(readMock).toHaveBeenCalledOnce());
  });
});
