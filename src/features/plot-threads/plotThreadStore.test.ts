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
  restorePlotThread: vi.fn(async () => {}),
  createPlotThreadLink: vi.fn(),
  updatePlotThreadLink: vi.fn(async () => {}),
  deletePlotThreadLink: vi.fn(async () => {}),
  restorePlotThreadLink: vi.fn(async () => {}),
  createPlotThreadBranch: vi.fn(),
  updatePlotThreadBranch: vi.fn(async () => {}),
  deletePlotThreadBranch: vi.fn(async () => {}),
  restorePlotThreadBranch: vi.fn(async () => {}),
}));

import {
  listPlotThreads,
  createPlotThread,
  updatePlotThread,
  deletePlotThread,
  restorePlotThread,
  createPlotThreadLink,
  updatePlotThreadLink,
  deletePlotThreadLink,
  restorePlotThreadLink,
  createPlotThreadBranch,
  deletePlotThreadBranch,
  restorePlotThreadBranch,
  type PlotThreadRow,
  type PlotThreadLinkRow,
  type PlotThreadBranchRow,
} from "./api";
import { usePlotThreadStore } from "./plotThreadStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import type { PlotPhaseType } from "@/db/schema";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const row = (id: string, sortOrder: string): PlotThreadRow => ({
  id,
  projectId: "p1",
  name: id,
  color: null,
  description: null,
  sortOrder,
  startNodeId: null,
  endNodeId: null,
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
    useGlobalHistoryStore.getState().clear();
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

  it("reorderThread は IPC 完了前に threads の sortOrder を楽観更新する", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
    });
    let resolveIpc: () => void = () => {};
    mock(updatePlotThread).mockImplementationOnce(
      () => new Promise<void>((r) => (resolveIpc = r)),
    );
    // await せずに発火（ドロップ時の void 呼び出しと同じ）。
    const p = usePlotThreadStore.getState().reorderThread("t1", "a2");
    // IPC 未完了でも store の sortOrder は即時反映されている。
    expect(
      usePlotThreadStore.getState().threads.find((t) => t.id === "t1")
        ?.sortOrder,
    ).toBe("a2");
    resolveIpc();
    await p;
    expect(mock(updatePlotThread)).toHaveBeenCalledWith("t1", {
      sortOrder: "a2",
    });
  });

  it("reorderThread は IPC 失敗時に sortOrder を元へ戻す", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
    mock(updatePlotThread).mockRejectedValueOnce(new Error("ipc fail"));
    await expect(
      usePlotThreadStore.getState().reorderThread("t1", "a9"),
    ).rejects.toThrow();
    expect(
      usePlotThreadStore.getState().threads.find((t) => t.id === "t1")
        ?.sortOrder,
    ).toBe("a0");
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

  it("deleteMarker がアンカー側エッジをカスケード削除する（#4）", async () => {
    // br1 = branch(t2→t1)@s1。アンカー側 = to = t1。t1@s1 のマーカー削除で消える。
    usePlotThreadStore.setState({
      links: [linkRow("m1")], // t1 / s1
      branches: [branchRow("br1", "t2", "t1"), branchRow("br2", "t2", "t3")],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadBranch).toHaveBeenCalledWith("br1");
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br2",
    ]);
    expect(usePlotThreadStore.getState().links).toHaveLength(0);
  });

  it("deleteMarker は非アンカー側マーカーの削除ではエッジを残す", async () => {
    // br1 = branch(t1→t2)@s1。アンカー側 = to = t2。from 側(t1)のマーカー削除では消えない。
    usePlotThreadStore.setState({
      links: [linkRow("m1")], // t1 / s1（branch の from 側）
      branches: [branchRow("br1", "t1", "t2")],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadBranch).not.toHaveBeenCalled();
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br1",
    ]);
  });

  it("deleteMarker は同一(thread,scene)に別 phase が残るならエッジを残す（取り残し防止）", async () => {
    // m1/m2 とも t1@s1（別 phase）。br1 のアンカーは to=t1@s1。m1 を消しても m2 が残るので維持。
    usePlotThreadStore.setState({
      links: [linkRow("m1"), { ...linkRow("m2"), phaseType: "turn" }],
      branches: [branchRow("br1", "t2", "t1")],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadBranch).not.toHaveBeenCalled();
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br1",
    ]);
  });

  it("deleteMarker は merge も to 側マーカーでカスケード削除する（統一アンカー）", async () => {
    // br1 = merge(t2→t1)@s1。統一モデルでアンカー = to = t1。t1@s1 のマーカー削除で消える。
    usePlotThreadStore.setState({
      links: [linkRow("m1")], // t1 / s1
      branches: [{ ...branchRow("br1", "t2", "t1"), kind: "merge" }],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadBranch).toHaveBeenCalledWith("br1");
    expect(usePlotThreadStore.getState().branches).toHaveLength(0);
  });

  it("deleteMarker は merge の from 側マーカー削除ではエッジを残す（統一アンカー）", async () => {
    // br1 = merge(t1→t2)@s1。アンカー = to = t2。from 側(t1)のマーカー削除では消えない。
    usePlotThreadStore.setState({
      links: [linkRow("m1")], // t1 / s1（merge の from 側）
      branches: [{ ...branchRow("br1", "t1", "t2"), kind: "merge" }],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadBranch).not.toHaveBeenCalled();
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br1",
    ]);
  });

  // ───────────────────────── Undo / Redo wiring ─────────────────────────
  describe("Undo/Redo (globalHistoryStore wiring)", () => {
    const history = () => useGlobalHistoryStore.getState();

    it("addMarker pushes an undoable entry; undo deletes, redo restores", async () => {
      mock(createPlotThreadLink).mockResolvedValue(linkRow("l1"));
      await usePlotThreadStore.getState().addMarker("t1", "s1", "develop");
      expect(history().canUndo).toBe(true);
      expect(history().past).toHaveLength(1);

      await history().undo();
      expect(deletePlotThreadLink).toHaveBeenCalledWith("l1");
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
      expect(history().canRedo).toBe(true);

      await history().redo();
      expect(restorePlotThreadLink).toHaveBeenCalledWith(
        expect.objectContaining({ id: "l1" }),
      );
      expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
        "l1",
      ]);
    });

    it("updateMarker undo restores the previous fields; redo re-applies", async () => {
      usePlotThreadStore.setState({ links: [linkRow("l1")] }); // phaseType=develop
      await usePlotThreadStore
        .getState()
        .updateMarker("l1", { phaseType: "climax" });
      expect(usePlotThreadStore.getState().links[0].phaseType).toBe("climax");
      expect(history().canUndo).toBe(true);

      await history().undo();
      expect(updatePlotThreadLink).toHaveBeenLastCalledWith("l1", {
        phaseType: "develop",
      });
      expect(usePlotThreadStore.getState().links[0].phaseType).toBe("develop");

      await history().redo();
      expect(usePlotThreadStore.getState().links[0].phaseType).toBe("climax");
    });

    it("deleteMarker undo restores the link AND its cascaded branch", async () => {
      // br1 = branch(t2→t1)@s1。アンカー側 to=t1 → deleteMarker で消える。
      usePlotThreadStore.setState({
        links: [linkRow("m1")], // t1 / s1
        branches: [branchRow("br1", "t2", "t1")],
      });
      await usePlotThreadStore.getState().deleteMarker("m1");
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);
      expect(history().canUndo).toBe(true);

      await history().undo();
      expect(restorePlotThreadLink).toHaveBeenCalledWith(
        expect.objectContaining({ id: "m1" }),
      );
      expect(restorePlotThreadBranch).toHaveBeenCalledWith(
        expect.objectContaining({ id: "br1" }),
      );
      expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
        "m1",
      ]);
      expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
        "br1",
      ]);

      await history().redo();
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);
    });

    it("addBranch undo deletes the branch; redo restores it", async () => {
      usePlotThreadStore.setState({
        threads: [row("t1", "a0"), row("t2", "a1")],
      });
      mock(createPlotThreadBranch).mockResolvedValue(branchRow("br1"));
      await usePlotThreadStore.getState().addBranch({
        projectId: "p1",
        fromThreadId: "t1",
        toThreadId: "t2",
        atNodeId: "s1",
        kind: "branch",
      });
      expect(history().canUndo).toBe(true);

      await history().undo();
      expect(deletePlotThreadBranch).toHaveBeenCalledWith("br1");
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);

      await history().redo();
      expect(restorePlotThreadBranch).toHaveBeenCalledWith(
        expect.objectContaining({ id: "br1" }),
      );
      expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
        "br1",
      ]);
    });

    it("addBranch that is rejected (dup/self) does NOT push history", async () => {
      usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
      await usePlotThreadStore.getState().addBranch({
        projectId: "p1",
        fromThreadId: "t1",
        toThreadId: "t1", // self → rejected
        atNodeId: "s1",
        kind: "branch",
      });
      expect(history().canUndo).toBe(false);
    });

    it("updateBranch undo restores previous endpoints; redo re-applies", async () => {
      usePlotThreadStore.setState({ branches: [branchRow("br1", "t1", "t2")] });
      await usePlotThreadStore
        .getState()
        .updateBranch("br1", { toThreadId: "t3", atNodeId: "s9" });
      expect(usePlotThreadStore.getState().branches[0].toThreadId).toBe("t3");

      await history().undo();
      const restored = usePlotThreadStore.getState().branches[0];
      expect(restored.toThreadId).toBe("t2");
      expect(restored.atNodeId).toBe("s1");

      await history().redo();
      expect(usePlotThreadStore.getState().branches[0].toThreadId).toBe("t3");
    });

    it("deleteBranch undo restores it; redo deletes again", async () => {
      usePlotThreadStore.setState({ branches: [branchRow("br1")] });
      await usePlotThreadStore.getState().deleteBranch("br1");
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);

      await history().undo();
      expect(restorePlotThreadBranch).toHaveBeenCalledWith(
        expect.objectContaining({ id: "br1" }),
      );
      expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
        "br1",
      ]);

      await history().redo();
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);
    });

    it("addThread undo deletes; redo restores with the same id", async () => {
      mock(createPlotThread).mockImplementation(
        async (data: { sortOrder: string }) => row("t1", data.sortOrder),
      );
      await usePlotThreadStore.getState().addThread("p1", "first");
      expect(history().canUndo).toBe(true);

      await history().undo();
      expect(deletePlotThread).toHaveBeenCalledWith("t1");
      expect(usePlotThreadStore.getState().threads).toHaveLength(0);

      await history().redo();
      expect(restorePlotThread).toHaveBeenCalledWith(
        expect.objectContaining({ id: "t1" }),
      );
      expect(usePlotThreadStore.getState().threads.map((t) => t.id)).toEqual([
        "t1",
      ]);
    });

    it("renameThread undo restores the previous name; redo re-applies", async () => {
      usePlotThreadStore.setState({ threads: [row("t1", "a0")] }); // name="t1"
      await usePlotThreadStore.getState().renameThread("t1", "renamed");
      expect(usePlotThreadStore.getState().threads[0].name).toBe("renamed");

      await history().undo();
      expect(updatePlotThread).toHaveBeenLastCalledWith("t1", { name: "t1" });
      expect(usePlotThreadStore.getState().threads[0].name).toBe("t1");

      await history().redo();
      expect(usePlotThreadStore.getState().threads[0].name).toBe("renamed");
    });

    it("setThreadColor undo restores the previous color", async () => {
      usePlotThreadStore.setState({ threads: [row("t1", "a0")] }); // color=null
      await usePlotThreadStore.getState().setThreadColor("t1", "#abc");
      expect(usePlotThreadStore.getState().threads[0].color).toBe("#abc");

      await history().undo();
      expect(usePlotThreadStore.getState().threads[0].color).toBeNull();
    });

    it("deleteThread undo restores thread + its links + its branches (CASCADE)", async () => {
      usePlotThreadStore.setState({
        threads: [row("t1", "a0"), row("t2", "a1")],
        links: [linkRow("l1")], // threadId=t1
        branches: [
          branchRow("br1", "t1", "t2"), // t1 from → cascaded
          branchRow("br2", "t2", "t1"), // t1 to   → cascaded
        ],
      });
      await usePlotThreadStore.getState().deleteThread("t1");
      expect(usePlotThreadStore.getState().threads.map((t) => t.id)).toEqual([
        "t2",
      ]);
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);

      await history().undo();
      expect(restorePlotThread).toHaveBeenCalledWith(
        expect.objectContaining({ id: "t1" }),
      );
      expect(
        usePlotThreadStore
          .getState()
          .threads.map((t) => t.id)
          .sort(),
      ).toEqual(["t1", "t2"]);
      expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
        "l1",
      ]);
      expect(
        usePlotThreadStore
          .getState()
          .branches.map((b) => b.id)
          .sort(),
      ).toEqual(["br1", "br2"]);
    });

    it("compound drag (updateMarker + addBranch) in runAsTransaction is a SINGLE undo", async () => {
      // commitMarkerDrop の主経路: 別スレッドへドロップ → マーカー付け替え + 新規 branch。
      usePlotThreadStore.setState({
        threads: [row("t1", "a0"), row("t2", "a1")],
        links: [linkRow("l1")], // t1 / s1
        branches: [],
      });
      mock(createPlotThreadBranch).mockResolvedValue(
        branchRow("br1", "t1", "t2"),
      );
      const store = usePlotThreadStore.getState();

      await history().runAsTransaction(
        {
          kind: "plot",
          label: "マーカー移動",
        },
        async () => {
          await store.updateMarker("l1", { threadId: "t2", nodeId: "s2" });
          await store.addBranch({
            projectId: "p1",
            fromThreadId: "t1",
            toThreadId: "t2",
            atNodeId: "s2",
            kind: "branch",
          });
        },
      );
      // 2 mutation でも履歴エントリは1つだけ。
      expect(history().past).toHaveLength(1);
      expect(usePlotThreadStore.getState().links[0].threadId).toBe("t2");
      expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
        "br1",
      ]);

      // 1 回の undo で両方戻る。
      await history().undo();
      expect(usePlotThreadStore.getState().links[0].threadId).toBe("t1");
      expect(usePlotThreadStore.getState().links[0].nodeId).toBe("s1");
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);

      // 1 回の redo で両方戻る。
      await history().redo();
      expect(usePlotThreadStore.getState().links[0].threadId).toBe("t2");
      expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
        "br1",
      ]);
    });

    it("importPlotThreads bulk-imports as a SINGLE undo (dedup + phase validation)", async () => {
      let threadSeq = 0;
      mock(createPlotThread).mockImplementation(
        async (data: {
          sortOrder: string;
          name: string;
          description?: string | null;
          projectId: string;
        }) => ({
          ...row(`th${++threadSeq}`, data.sortOrder),
          name: data.name,
          description: data.description ?? null,
        }),
      );
      let linkSeq = 0;
      mock(createPlotThreadLink).mockImplementation(
        async (data: {
          threadId: string;
          nodeId: string;
          phaseType: PlotPhaseType;
          note?: string | null;
        }) => ({
          id: `lk${++linkSeq}`,
          threadId: data.threadId,
          nodeId: data.nodeId,
          phaseType: data.phaseType,
          note: data.note ?? null,
          sortOrder: null,
          createdAt: "",
          updatedAt: "",
        }),
      );

      await usePlotThreadStore.getState().importPlotThreads("p1", [
        {
          name: "Aの真実",
          markers: [
            { nodeId: "s1", phaseType: "introduce" },
            { nodeId: "s1", phaseType: "introduce" }, // 重複 → skip
            { nodeId: "s2", phaseType: "bogus" as PlotPhaseType }, // 不正 phase → skip
            { nodeId: "s3", phaseType: "climax" },
          ],
        },
        // name 空 → skip
        { name: "  ", markers: [{ nodeId: "s9", phaseType: "develop" }] },
      ]);

      const st = usePlotThreadStore.getState();
      expect(st.threads).toHaveLength(1);
      expect(st.threads[0].name).toBe("Aの真実");
      expect(st.links.map((l) => `${l.nodeId}:${l.phaseType}`)).toEqual([
        "s1:introduce",
        "s3:climax",
      ]);
      // 取込全体で履歴エントリは 1 つ。
      expect(history().past).toHaveLength(1);

      await history().undo();
      expect(usePlotThreadStore.getState().threads).toHaveLength(0);
      expect(usePlotThreadStore.getState().links).toHaveLength(0);

      await history().redo();
      expect(usePlotThreadStore.getState().threads).toHaveLength(1);
      expect(usePlotThreadStore.getState().links).toHaveLength(2);
    });

    it("importPlotThreads forwards the per-proposal color to createPlotThread", async () => {
      const seenColors: Array<string | null | undefined> = [];
      mock(createPlotThread).mockImplementation(
        async (data: {
          sortOrder: string;
          name: string;
          color?: string | null;
        }) => {
          seenColors.push(data.color);
          return {
            ...row(`th-${seenColors.length}`, data.sortOrder),
            name: data.name,
          };
        },
      );

      await usePlotThreadStore.getState().importPlotThreads("p1", [
        {
          name: "Blue",
          color: "#2045AA",
          markers: [{ nodeId: "s1", phaseType: "introduce" }],
        },
        {
          name: "Red",
          color: "#AA2020",
          markers: [{ nodeId: "s2", phaseType: "introduce" }],
        },
        // color 未指定 → null にフォールバック
        { name: "Plain", markers: [{ nodeId: "s3", phaseType: "introduce" }] },
      ]);

      expect(seenColors).toEqual(["#2045AA", "#AA2020", null]);
    });

    it("importPlotThreads drops the composite undo when the project switches mid-import (XPROJ)", async () => {
      mock(createPlotThread).mockImplementation(
        async (data: { sortOrder: string; name: string }) => ({
          ...row("th-x", data.sortOrder),
          name: data.name,
        }),
      );
      // 最初のリンク作成中にプロジェクト切替（reloadProjectData 相当）が起きる。
      mock(createPlotThreadLink).mockImplementation(
        async (data: {
          threadId: string;
          nodeId: string;
          phaseType: PlotPhaseType;
        }) => {
          currentProject.value = "p2";
          return {
            id: "lkx",
            threadId: data.threadId,
            nodeId: data.nodeId,
            phaseType: data.phaseType,
            note: null,
            sortOrder: null,
            createdAt: "",
            updatedAt: "",
          };
        },
      );

      await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", [
          { name: "A", markers: [{ nodeId: "s1", phaseType: "introduce" }] },
        ]);

      // 旧プロジェクトの行を参照する合成エントリは新プロジェクト履歴へ commit されない。
      expect(history().past).toHaveLength(0);
    });

    it("does not push a second entry while replaying (undo closures use the API directly)", async () => {
      mock(createPlotThreadLink).mockResolvedValue(linkRow("l1"));
      await usePlotThreadStore.getState().addMarker("t1", "s1", "develop");
      await history().undo();
      // After undo, the entry is in `future`, NOT re-pushed onto `past`.
      expect(history().past).toHaveLength(0);
      expect(history().future).toHaveLength(1);
    });
  });
});
