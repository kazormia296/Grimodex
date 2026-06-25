import { describe, it, expect } from "vitest";
import { buildSceneThreadTracks } from "./sceneThreadTracks";
import type { PlotThreadRow, PlotThreadBranchRow } from "./api";

function branch(
  over: Partial<PlotThreadBranchRow> & {
    fromThreadId: string;
    toThreadId: string;
    atNodeId: string;
  },
): PlotThreadBranchRow {
  return {
    id: `${over.fromThreadId}-${over.toThreadId}-${over.atNodeId}`,
    projectId: "p1",
    kind: "branch",
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function thread(over: Partial<PlotThreadRow> & { id: string }): PlotThreadRow {
  return {
    projectId: "p1",
    name: over.id,
    color: null,
    description: null,
    sortOrder: "a0",
    startNodeId: null,
    endNodeId: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const threadsById = new Map<string, PlotThreadRow>([
  ["t1", thread({ id: "t1", sortOrder: "a0", color: "#f00" })],
  ["t2", thread({ id: "t2", sortOrder: "a1", color: "#0f0" })],
]);

// 行順: n0,n1,n2,n3,n4
const rows = ["n0", "n1", "n2", "n3", "n4"].map((id) => ({ id }));

describe("buildSceneThreadTracks", () => {
  it("先頭=t / 中間通過=| / 末尾=b、区間外=. を符号化する", () => {
    // t1 は n0 と n3 に所属（n1,n2 は通過、n4 は区間外）
    const { columns, cellByNode } = buildSceneThreadTracks(
      rows,
      { n0: ["t1"], n3: ["t1"] },
      threadsById,
    );
    expect(columns.map((c) => c.id)).toEqual(["t1"]);
    expect(cellByNode.n0).toBe("t");
    expect(cellByNode.n1).toBe("|");
    expect(cellByNode.n2).toBe("|");
    expect(cellByNode.n3).toBe("b");
    expect(cellByNode.n4).toBe(".");
  });

  it("中間の所属行は s（駅＋全高線）", () => {
    const { cellByNode } = buildSceneThreadTracks(
      rows,
      { n0: ["t1"], n2: ["t1"], n4: ["t1"] },
      threadsById,
    );
    expect(cellByNode.n0).toBe("t");
    expect(cellByNode.n2).toBe("s");
    expect(cellByNode.n4).toBe("b");
  });

  it("単独所属は o（駅のみ・線なし）", () => {
    const { cellByNode } = buildSceneThreadTracks(
      rows,
      { n2: ["t1"] },
      threadsById,
    );
    expect(cellByNode.n2).toBe("o");
    expect(cellByNode.n0).toBe(".");
  });

  it("複数列を sortOrder 順に並べ、各行は列順の文字列を返す", () => {
    // t1(a0): n0..n2、t2(a1): n1..n3
    const { columns, cellByNode } = buildSceneThreadTracks(
      rows,
      { n0: ["t1"], n1: ["t1", "t2"], n2: ["t1"], n3: ["t2"] },
      threadsById,
    );
    expect(columns.map((c) => c.id)).toEqual(["t1", "t2"]);
    // 列0=t1, 列1=t2
    expect(cellByNode.n0).toBe("t."); // t1 先頭 / t2 区間外
    expect(cellByNode.n1).toBe("st"); // t1 中間駅 / t2 先頭駅
    expect(cellByNode.n2).toBe("b|"); // t1 末尾 / t2 通過
    expect(cellByNode.n3).toBe(".b"); // t1 区間外 / t2 末尾
  });

  it("branch/merge を at 行の connectorByNode に符号化（列index>列index:kind）", () => {
    const { connectorByNode } = buildSceneThreadTracks(
      rows,
      { n0: ["t1"], n2: ["t1", "t2"], n4: ["t2"] },
      threadsById,
      [
        branch({ fromThreadId: "t1", toThreadId: "t2", atNodeId: "n2" }),
        branch({
          fromThreadId: "t2",
          toThreadId: "t1",
          atNodeId: "n4",
          kind: "merge",
        }),
      ],
    );
    expect(connectorByNode.n2).toBe("0>1:b"); // t1=列0 → t2=列1 branch
    expect(connectorByNode.n4).toBe("1>0:m"); // t2=列1 → t1=列0 merge
  });

  it("列に無いスレッドが絡む branch は無視", () => {
    const { connectorByNode } = buildSceneThreadTracks(
      rows,
      { n0: ["t1"], n2: ["t1"] },
      threadsById,
      // t2 は所属シーンが無く列にならない → コネクタ無し
      [branch({ fromThreadId: "t1", toThreadId: "t2", atNodeId: "n2" })],
    );
    expect(connectorByNode.n2).toBeUndefined();
  });

  it("所属シーンが無ければ列は空", () => {
    const { columns, cellByNode } = buildSceneThreadTracks(
      rows,
      {},
      threadsById,
    );
    expect(columns).toEqual([]);
    expect(cellByNode).toEqual({});
  });

  it("非所属行（フォルダ等）も区間内なら通過線を引く", () => {
    // n1 はフォルダ想定で nodeThreadIds に無いが t1 区間(n0..n3)内 → '|'
    const { cellByNode } = buildSceneThreadTracks(
      rows,
      { n0: ["t1"], n3: ["t1"] },
      threadsById,
    );
    expect(cellByNode.n1).toBe("|");
  });
});
