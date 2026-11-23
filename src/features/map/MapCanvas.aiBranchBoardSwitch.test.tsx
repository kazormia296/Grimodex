// @vitest-environment happy-dom
//
// AI Branch の確認中に board を切り替えたときの保存先と画面反映を確認する。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider } from "@xyflow/react";
import { toast } from "sonner";
import type { MapAiBranch, MapBoard, MapSticky } from "@/db/schema";
import { useWorkspaceStore } from "@/features/workspace/store";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useMapStore } from "./mapStore";

const h = vi.hoisted(() => ({
  projectId: "project-1",
  boards: new Map<string, unknown>(),
  stickies: new Map<string, unknown[]>(),
  positions: new Map<string, unknown[]>(),
  aiBranches: new Map<string, unknown[]>(),
  /** board-b の listAiBranches を保留する gate（null なら即時）。 */
  boardBGate: null as Promise<void> | null,
  createAiBranch: vi.fn(),
  getAiBranchSnapshot: vi.fn(),
  runAiBranchGeneration: vi.fn(),
}));

vi.mock("@/features/project/projectStore", async (orig) => ({
  ...(await orig<object>()),
  getCurrentProjectId: () => h.projectId,
  useCurrentProjectId: () => h.projectId,
}));

vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({
    presentation: "enabled",
    tooltip: null,
    capability: { state: "enabled" },
  }),
}));

vi.mock("@/features/codex/codexRelationApi", () => ({
  listCodexRelations: vi.fn().mockResolvedValue([]),
}));

vi.mock("./aiBranchContext", async (orig) => ({
  ...(await orig<object>()),
  runAiBranchGeneration: h.runAiBranchGeneration,
  listAiBranchCodexIdsNotSent: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("./mapApi", async (orig) => ({
  ...(await orig<object>()),
  listBoards: vi.fn(async () => [...h.boards.values()]),
  getOrCreateBoard: vi.fn(async () => [...h.boards.values()][0]),
  getMapBoard: vi.fn(async (id: string) => h.boards.get(id) ?? null),
  listNodePositions: vi.fn(async (id: string) => h.positions.get(id) ?? []),
  listUserEdges: vi.fn(async () => []),
  listFrames: vi.fn(async () => []),
  listStickies: vi.fn(async (id: string) => h.stickies.get(id) ?? []),
  listAiBranches: vi.fn(async (id: string) => {
    if (id === "board-b" && h.boardBGate) await h.boardBGate;
    return h.aiBranches.get(id) ?? [];
  }),
  createAiBranch: h.createAiBranch,
  getAiBranchSnapshot: h.getAiBranchSnapshot,
  updateMapBoardSettings: vi.fn().mockResolvedValue(undefined),
}));

import { MapCanvas } from "./MapCanvas";

const NOW = "2026-01-01T00:00:00.000Z";

function board(id: string): MapBoard {
  return {
    id,
    projectId: h.projectId,
    title: id,
    sortOrder: 0,
    mode: "free",
    viewportX: 0,
    viewportY: 0,
    viewportZoom: 1,
    showConfig: "{}",
    colorBy: "none",
    createdAt: NOW,
    updatedAt: NOW,
  } as MapBoard;
}

function position(boardId: string, kind: "sticky" | "ai_branch", id: string) {
  return {
    id: `pos-${id}`,
    boardId,
    nodeRefType: kind,
    aiBranchId: kind === "ai_branch" ? id : null,
    stickyId: kind === "sticky" ? id : null,
    treeNodeId: null,
    codexEntryId: null,
    snippetId: null,
    x: 100,
    y: 100,
    pinned: 0,
    zIndex: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function sticky(boardId: string, id: string, title: string): MapSticky {
  return {
    id,
    boardId,
    title,
    body: '{"type":"doc","content":[]}',
    previewText: null,
    paletteId: "default",
    colorSlot: 0,
    aiBranchId: null,
    aiDerived: 0,
    sourceChatMessageId: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as MapSticky;
}

/** 描画されている React Flow の node id。 */
function renderedNodeIds(): string[] {
  return Array.from(document.querySelectorAll(".react-flow__node")).map(
    (el) => el.getAttribute("data-id") ?? "",
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const PROMPT = "無人駅の怪談";

function newBranchResult(boardId: string) {
  const branch = {
    id: "branch-new",
    boardId,
    prompt: PROMPT,
    seedNodeIds: "[]",
    sessionId: null,
    model: null,
    tokenUsage: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as MapAiBranch;
  return {
    branch,
    stickies: [sticky(boardId, "sticky-new", "NEW-STICKY")],
    positions: [
      position(boardId, "ai_branch", "branch-new"),
      position(boardId, "sticky", "sticky-new"),
    ],
    edges: [],
    writeReceipt: {},
  };
}

async function openDialogAndType(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /AI Branch/ }));
  const textarea =
    await screen.findByPlaceholderText("アイデアを展開してください…");
  await user.type(textarea, PROMPT);
}

async function renderOnBoardA() {
  const user = userEvent.setup();
  render(
    <ReactFlowProvider>
      <MapCanvas />
    </ReactFlowProvider>,
  );
  // board A（先頭）が読み込まれ、その付箋が出る。
  await waitFor(() => expect(renderedNodeIds()).toContain("sticky:sa"));
  expect(useMapStore.getState().activeBoardId).toBe("board-a");
  return user;
}

beforeEach(() => {
  h.boards.clear();
  h.boards.set("board-a", board("board-a"));
  h.boards.set("board-b", board("board-b"));
  h.stickies.set("board-a", [sticky("board-a", "sa", "A-STICKY")]);
  h.stickies.set("board-b", [sticky("board-b", "sb", "B-STICKY")]);
  h.positions.set("board-a", [position("board-a", "sticky", "sa")]);
  h.positions.set("board-b", [position("board-b", "sticky", "sb")]);
  h.aiBranches.clear();
  h.boardBGate = null;
  vi.spyOn(toast, "error").mockImplementation(() => "");
  h.createAiBranch.mockReset();
  h.getAiBranchSnapshot.mockReset().mockResolvedValue(null);
  h.runAiBranchGeneration.mockReset();
  useGlobalHistoryStore.getState().clear();
  useMapStore.setState({ activeBoardId: null });
  useWorkspaceStore.setState({
    activeWorkspacePath: "/ws",
    workspaceSwitchInProgress: false,
  });
  setCurrentWorkspaceIdentity({ path: "/ws", openRevision: 1 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setCurrentWorkspaceIdentity(null);
});

describe("MapCanvas AI Branch — 確認中の board 切替", () => {
  it("生成中に board を切り替えても元 board に保存し、切替後の画面と履歴には反映しない", async () => {
    const generation = deferred<{ title: string; body: string }[]>();
    h.runAiBranchGeneration.mockReturnValue(generation.promise);
    const created = deferred<ReturnType<typeof newBranchResult>>();
    h.createAiBranch.mockReturnValue(created.promise);

    const user = await renderOnBoardA();
    await openDialogAndType(user);
    await user.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() =>
      expect(h.runAiBranchGeneration).toHaveBeenCalledTimes(1),
    );

    // 生成の最中に board B へ切り替え、B の読み込みが終わるのを待つ。
    act(() => useMapStore.getState().setActiveBoardId("board-b"));
    await waitFor(() => expect(renderedNodeIds()).toEqual(["sticky:sb"]));

    await act(async () => {
      generation.resolve([{ title: "NEW-STICKY", body: "{}" }]);
    });
    await waitFor(() => expect(h.createAiBranch).toHaveBeenCalledTimes(1));

    // (1) 保存先は、生成を始めた board A（切替後の board B ではない）。
    expect(h.createAiBranch.mock.calls[0][0]).toBe("board-a");
    // (4) 送信は 1 回だけで、authority は board A。
    expect(h.runAiBranchGeneration).toHaveBeenCalledTimes(1);
    expect(h.runAiBranchGeneration.mock.calls[0][0].authority.resourceId).toBe(
      "board-a",
    );

    await act(async () => {
      created.resolve(newBranchResult("board-a"));
    });
    expect(renderedNodeIds()).toEqual(["sticky:sb"]);
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
  });
  it("board B の再読込後も board B に枝を表示しない", async () => {
    h.runAiBranchGeneration.mockResolvedValue([
      { title: "NEW-STICKY", body: "{}" },
    ]);
    const created = deferred<ReturnType<typeof newBranchResult>>();
    h.createAiBranch.mockReturnValue(created.promise);

    const user = await renderOnBoardA();
    await openDialogAndType(user);
    await user.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(h.createAiBranch).toHaveBeenCalledTimes(1));

    act(() => useMapStore.getState().setActiveBoardId("board-b"));
    await waitFor(() => expect(renderedNodeIds()).toEqual(["sticky:sb"]));
    await act(async () => {
      created.resolve(newBranchResult("board-a"));
    });
    expect(renderedNodeIds()).toEqual(["sticky:sb"]);

    // board B の読み直し（boardDataVersion の更新）で、DB の内容（board B のもの）に戻る。
    act(() => useMapStore.getState().bumpBoardDataVersion());
    await waitFor(() => expect(renderedNodeIds()).toEqual(["sticky:sb"]));
  });

  it("board B の読み込みが createAiBranch の完了より後でも画面に反映しない", async () => {
    h.runAiBranchGeneration.mockResolvedValue([
      { title: "NEW-STICKY", body: "{}" },
    ]);
    const created = deferred<ReturnType<typeof newBranchResult>>();
    h.createAiBranch.mockReturnValue(created.promise);
    const gate = deferred<void>();

    const user = await renderOnBoardA();
    await openDialogAndType(user);
    await user.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(h.createAiBranch).toHaveBeenCalledTimes(1));

    h.boardBGate = gate.promise;
    act(() => useMapStore.getState().setActiveBoardId("board-b"));
    await act(async () => {
      created.resolve(newBranchResult("board-a"));
    });
    expect(renderedNodeIds()).toEqual(["sticky:sa"]);
    await act(async () => {
      gate.resolve();
    });
    // 読み込みが終わると board B の内容で置き換わり、枝は消える。
    await waitFor(() => expect(renderedNodeIds()).toEqual(["sticky:sb"]));
    expect(h.createAiBranch.mock.calls[0][0]).toBe("board-a");
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
  });

  it("送信前に board を切り替えたら生成を止める", async () => {
    const beforeSend = deferred<void>();
    h.runAiBranchGeneration.mockImplementation(async (input) => {
      await beforeSend.promise;
      input.assertAuthority();
      return [{ title: "NEW-STICKY", body: "{}" }];
    });
    const user = await renderOnBoardA();
    await openDialogAndType(user);
    await user.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() =>
      expect(h.runAiBranchGeneration).toHaveBeenCalledTimes(1),
    );
    act(() => useMapStore.getState().setActiveBoardId("board-b"));
    await waitFor(() => expect(renderedNodeIds()).toEqual(["sticky:sb"]));
    await act(async () => beforeSend.resolve());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(h.createAiBranch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining(
          "board changed before the confirmation completed",
        ),
      }),
    );
  });

  it("同じ board のまま生成した枝と付箋は画面に反映する", async () => {
    h.runAiBranchGeneration.mockResolvedValue([
      { title: "NEW-STICKY", body: "{}" },
    ]);
    h.createAiBranch.mockResolvedValue(newBranchResult("board-a"));
    const user = await renderOnBoardA();
    await openDialogAndType(user);
    await user.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() =>
      expect(renderedNodeIds().sort()).toEqual(
        ["ai_branch:branch-new", "sticky:sa", "sticky:sticky-new"].sort(),
      ),
    );
  });

  it("(5) ダイアログを開いたまま board を切り替えてから確認すると、開始時の検査が拒み、送信も保存もしない", async () => {
    const user = await renderOnBoardA();
    await openDialogAndType(user);

    act(() => useMapStore.getState().setActiveBoardId("board-b"));
    await waitFor(() => expect(renderedNodeIds()).toEqual(["sticky:sb"]));
    await user.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining(
          "board changed before the confirmation completed",
        ),
      }),
    );
    expect(h.runAiBranchGeneration).not.toHaveBeenCalled();
    expect(h.createAiBranch).not.toHaveBeenCalled();
    expect(renderedNodeIds()).toEqual(["sticky:sb"]);
  });
});
