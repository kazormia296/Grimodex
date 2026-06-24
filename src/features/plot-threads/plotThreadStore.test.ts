import { describe, it, expect, vi, beforeEach } from "vitest";

const currentProject = { value: "p1" };
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => currentProject.value,
}));
vi.mock("./api", () => ({
  listPlotThreads: vi.fn(async () => []),
  listPlotThreadLinks: vi.fn(async () => []),
  listPlotThreadBranches: vi.fn(async () => []),
  createPlotThread: vi.fn(),
  updatePlotThread: vi.fn(async () => {}),
  deletePlotThread: vi.fn(async () => {}),
  createPlotThreadLink: vi.fn(),
  updatePlotThreadLink: vi.fn(async () => {}),
  deletePlotThreadLink: vi.fn(async () => {}),
  createPlotThreadBranch: vi.fn(),
  updatePlotThreadBranch: vi.fn(async () => {}),
  deletePlotThreadBranch: vi.fn(async () => {}),
}));

import {
  listPlotThreads,
  createPlotThread,
  createPlotThreadLink,
  createPlotThreadBranch,
  type PlotThreadRow,
  type PlotThreadLinkRow,
  type PlotThreadBranchRow,
} from "./api";
import { usePlotThreadStore } from "./plotThreadStore";

const row = (id: string, sortOrder: string): PlotThreadRow => ({
  id,
  projectId: "p1",
  name: id,
  color: null,
  description: null,
  sortOrder,
  createdAt: "",
  updatedAt: "",
});

const linkRow = (id: string): PlotThreadLinkRow => ({
  id,
  threadId: "t1",
  nodeId: "s1",
  phaseType: "develop",
  note: null,
  sortOrder: null,
  createdAt: "",
  updatedAt: "",
});

const branchRow = (
  id: string,
  fromThreadId = "t1",
  toThreadId = "t2",
): PlotThreadBranchRow => ({
  id,
  projectId: "p1",
  fromThreadId,
  toThreadId,
  atNodeId: "s1",
  kind: "branch",
  createdAt: "",
  updatedAt: "",
});

describe("plotThreadStore", () => {
  beforeEach(() => {
    usePlotThreadStore.setState({
      threads: [],
      links: [],
      branches: [],
      loading: false,
    });
    currentProject.value = "p1";
    vi.clearAllMocks();
    (listPlotThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("loads threads and links for the current project", async () => {
    (listPlotThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
      row("t1", "a0"),
    ]);
    await usePlotThreadStore.getState().load("p1");
    expect(usePlotThreadStore.getState().threads).toHaveLength(1);
    expect(usePlotThreadStore.getState().loading).toBe(false);
  });

  it("drops a stale load when the project switched mid-flight", async () => {
    (listPlotThreads as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        currentProject.value = "p2"; // ロード中にプロジェクト切替
        return [row("t1", "a0")];
      },
    );
    await usePlotThreadStore.getState().load("p1");
    // p1 のロード結果は破棄される（現在 p2 のため）
    expect(usePlotThreadStore.getState().threads).toHaveLength(0);
  });

  it("appends a new thread with a sortOrder after the last", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")], links: [] });
    (createPlotThread as ReturnType<typeof vi.fn>).mockImplementation(
      async (data: { sortOrder: string }) => row("t2", data.sortOrder),
    );
    await usePlotThreadStore.getState().addThread("p1", "second");
    const threads = usePlotThreadStore.getState().threads;
    expect(threads).toHaveLength(2);
    // 新キーは末尾（"a0" より後）であること
    expect(threads[1].sortOrder > "a0").toBe(true);
  });

  it("removes a thread and its links locally on delete", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
      links: [
        {
          id: "l1",
          threadId: "t1",
          nodeId: "s1",
          phaseType: "introduce",
          note: null,
          sortOrder: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    await usePlotThreadStore.getState().deleteThread("t1");
    expect(usePlotThreadStore.getState().threads.map((t) => t.id)).toEqual([
      "t2",
    ]);
    expect(usePlotThreadStore.getState().links).toHaveLength(0);
  });

  it("addMarker が作成結果を links に追加する", async () => {
    (createPlotThreadLink as ReturnType<typeof vi.fn>).mockResolvedValue(
      linkRow("l1"),
    );
    await usePlotThreadStore.getState().addMarker("t1", "s1", "develop");
    expect(createPlotThreadLink).toHaveBeenCalledWith({
      threadId: "t1",
      nodeId: "s1",
      phaseType: "develop",
    });
    expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
      "l1",
    ]);
  });

  it("updateMarker が links を楽観更新する", async () => {
    usePlotThreadStore.setState({ links: [linkRow("l1")] });
    await usePlotThreadStore.getState().updateMarker("l1", {
      phaseType: "climax",
    });
    expect(usePlotThreadStore.getState().links[0].phaseType).toBe("climax");
  });

  it("deleteMarker が links から除外する", async () => {
    usePlotThreadStore.setState({ links: [linkRow("l1"), linkRow("l2")] });
    await usePlotThreadStore.getState().deleteMarker("l1");
    expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
      "l2",
    ]);
  });

  it("addBranch が作成結果を branches に追加する", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
    });
    (createPlotThreadBranch as ReturnType<typeof vi.fn>).mockResolvedValue(
      branchRow("br1"),
    );
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch",
    });
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br1",
    ]);
  });

  it("addBranch は自己参照(from===to)を弾く", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t1",
      atNodeId: "s1",
      kind: "branch",
    });
    expect(createPlotThreadBranch).not.toHaveBeenCalled();
    expect(usePlotThreadStore.getState().branches).toHaveLength(0);
  });

  it("addBranch は未知スレッド(別 project 等)を弾く", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "ghost", // store に無い
      atNodeId: "s1",
      kind: "branch",
    });
    expect(createPlotThreadBranch).not.toHaveBeenCalled();
  });

  it("addBranch は同一(from,to,atNode,kind)の重複を弾く", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
      branches: [branchRow("br1", "t1", "t2")], // atNode=s1, kind=branch
    });
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch",
    });
    expect(createPlotThreadBranch).not.toHaveBeenCalled();
    expect(usePlotThreadStore.getState().branches).toHaveLength(1);
  });

  it("updateBranch が branches を楽観更新する（at_node・付け替え）", async () => {
    usePlotThreadStore.setState({ branches: [branchRow("br1", "t1", "t2")] });
    await usePlotThreadStore
      .getState()
      .updateBranch("br1", { toThreadId: "t3", atNodeId: "s9" });
    const b = usePlotThreadStore.getState().branches[0];
    expect(b.toThreadId).toBe("t3");
    expect(b.atNodeId).toBe("s9");
  });

  it("deleteBranch が branches から除外する", async () => {
    usePlotThreadStore.setState({
      branches: [branchRow("br1"), branchRow("br2")],
    });
    await usePlotThreadStore.getState().deleteBranch("br1");
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br2",
    ]);
  });

  it("deleteThread が from/to に絡む branch も除外する（CASCADE 反映）", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1"), row("t3", "a2")],
      branches: [
        branchRow("br1", "t1", "t2"), // t1 が from → 消える
        branchRow("br2", "t3", "t1"), // t1 が to → 消える
        branchRow("br3", "t2", "t3"), // t1 無関係 → 残る
      ],
    });
    await usePlotThreadStore.getState().deleteThread("t1");
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br3",
    ]);
  });
});
