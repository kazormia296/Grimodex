import { describe, it, expect } from "vitest";
import {
  buildSceneThreadTracks,
  computeSceneThreadContext,
} from "./sceneThreadTracks";
import type {
  PlotThreadRow,
  PlotThreadBranchRow,
  PlotThreadLinkRow,
} from "./api";

function link(
  over: Partial<PlotThreadLinkRow> & { threadId: string; nodeId: string },
): PlotThreadLinkRow {
  return {
    id: `${over.threadId}-${over.nodeId}`,
    phaseType: "develop",
    note: null,
    sortOrder: null,
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

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
    semanticKey: "",
    version: 0,
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
    version: 0,
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

  it("merge した from スレッドは離脱行で線が切れ、再登場は別 run（Timeline と一致）", () => {
    // 列0=t1(a0), 列1=t2(a1)。t2 は n0,n4 に所属し、n1 で t1 へ merge。
    // 旧実装は n0..n4 を一本線で繋いでいたが、Timeline では n1 で離脱して途切れる。
    const { columns, cellByNode } = buildSceneThreadTracks(
      rows,
      { n0: ["t2"], n2: ["t1"], n4: ["t2"] },
      threadsById,
      [
        branch({
          fromThreadId: "t2",
          toThreadId: "t1",
          atNodeId: "n1",
          kind: "merge",
        }),
      ],
    );
    expect(columns.map((c) => c.id)).toEqual(["t1", "t2"]);
    // 列1=t2: n0=駅+下半線(t) / n1=離脱(上半線・駅なし=B) / n2,n3=線なし(.) / n4=単独駅(o)
    expect(cellByNode.n0[1]).toBe("t");
    expect(cellByNode.n1[1]).toBe("B");
    expect(cellByNode.n2[1]).toBe(".");
    expect(cellByNode.n3[1]).toBe(".");
    expect(cellByNode.n4[1]).toBe("o");
  });

  it("branch の to スレッドは分岐行から線が始まる（最初のマーカー前でも・Timeline と一致）", () => {
    // 列0=t1(from), 列1=t2(to)。branch t1→t2 at n1。t2 の所属は n3 のみ。
    // 旧実装は t2 を n3 単独駅にしてコネクタが宙に浮いたが、Timeline では n1 から線が出る。
    const { cellByNode } = buildSceneThreadTracks(
      rows,
      { n0: ["t1"], n1: ["t1"], n3: ["t2"] },
      threadsById,
      [branch({ fromThreadId: "t1", toThreadId: "t2", atNodeId: "n1" })],
    );
    // 列1=t2: n1=分岐流入(下半線・駅なし=T) / n2=通過(|) / n3=末尾駅(b)
    expect(cellByNode.n1[1]).toBe("T");
    expect(cellByNode.n2[1]).toBe("|");
    expect(cellByNode.n3[1]).toBe("b");
    // 列0=t1 は分岐行に自分のマーカーがあるので離脱せず連続（n0=t, n1=b）
    expect(cellByNode.n0[0]).toBe("t");
    expect(cellByNode.n1[0]).toBe("b");
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

  it("subwaySort=true で列を重要度 center-out 順に並べる（Timeline の行と一致）", () => {
    const tById = new Map<string, PlotThreadRow>([
      ["t1", thread({ id: "t1", sortOrder: "a0" })],
      ["t2", thread({ id: "t2", sortOrder: "a1" })],
      ["t3", thread({ id: "t3", sortOrder: "a2" })],
    ]);
    const sixRows = ["n0", "n1", "n2", "n3", "n4", "n5"].map((id) => ({ id }));
    const membership = {
      n0: ["t1"],
      n1: ["t1"],
      n2: ["t1"], // t1 = 3 シーン（最重要）
      n3: ["t2"], // t2 = 1 シーン
      n4: ["t3"],
      n5: ["t3"], // t3 = 2 シーン
    };
    // 既定（sortOrder 線形）
    const def = buildSceneThreadTracks(sixRows, membership, tById, []);
    expect(def.columns.map((c) => c.id)).toEqual(["t1", "t2", "t3"]);
    // subwaySort: 重要度 t1>t3>t2 → rank[t1,t3,t2] → center-out 視覚順 [t2,t1,t3]
    const sub = buildSceneThreadTracks(sixRows, membership, tById, [], true);
    expect(sub.columns.map((c) => c.id)).toEqual(["t2", "t1", "t3"]);
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

describe("computeSceneThreadContext", () => {
  it("groups the scene's threads with current phase and other markers", () => {
    const links: PlotThreadLinkRow[] = [
      link({ threadId: "t1", nodeId: "s0", phaseType: "introduce" }),
      link({ threadId: "t1", nodeId: "s1", phaseType: "develop" }),
      link({ threadId: "t1", nodeId: "s2", phaseType: "climax" }),
      link({ threadId: "t2", nodeId: "s1", phaseType: "introduce" }),
      link({ threadId: "t2", nodeId: "s3", phaseType: "resolve" }),
    ];
    // s1 は t1(develop) と t2(introduce) に属する
    const ctx = computeSceneThreadContext(links, "s1");
    expect(ctx.map((c) => c.threadId)).toEqual(["t1", "t2"]);
    expect(ctx[0].currentPhases).toEqual(["develop"]);
    expect(ctx[0].others).toEqual([
      { nodeId: "s0", phaseType: "introduce" },
      { nodeId: "s2", phaseType: "climax" },
    ]);
    expect(ctx[1].currentPhases).toEqual(["introduce"]);
    expect(ctx[1].others).toEqual([{ nodeId: "s3", phaseType: "resolve" }]);
  });

  it("collects all current phases when the scene has multiple links on one thread", () => {
    const links: PlotThreadLinkRow[] = [
      link({ threadId: "t1", nodeId: "s0", phaseType: "introduce" }),
      link({ threadId: "t1", nodeId: "s0", phaseType: "develop" }),
      link({ threadId: "t1", nodeId: "s1", phaseType: "climax" }),
    ];
    const ctx = computeSceneThreadContext(links, "s0");
    expect(ctx).toHaveLength(1);
    expect(ctx[0].currentPhases).toEqual(["introduce", "develop"]);
    expect(ctx[0].others).toEqual([{ nodeId: "s1", phaseType: "climax" }]);
  });

  it("dedups other markers by nodeId (keeps first phase)", () => {
    const links: PlotThreadLinkRow[] = [
      link({ threadId: "t1", nodeId: "s0", phaseType: "introduce" }),
      link({ threadId: "t1", nodeId: "s1", phaseType: "develop" }),
      link({ threadId: "t1", nodeId: "s1", phaseType: "climax" }),
    ];
    const ctx = computeSceneThreadContext(links, "s0");
    expect(ctx[0].others).toEqual([{ nodeId: "s1", phaseType: "develop" }]);
  });

  it("returns [] when the scene belongs to no thread", () => {
    const links: PlotThreadLinkRow[] = [link({ threadId: "t1", nodeId: "s0" })];
    expect(computeSceneThreadContext(links, "sX")).toEqual([]);
  });
});
