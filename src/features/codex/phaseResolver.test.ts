import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "@/db/schema";
import {
  computeGlobalSceneOrder,
  computeSceneTimeIndex,
  formatTimelineContext,
  resolveCodexState,
} from "./phaseResolver";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNode(
  overrides: Partial<TreeNodeData> & { id: string },
): TreeNodeData {
  return {
    projectId: "proj-1",
    parentId: null,
    nodeType: "scene",
    title: overrides.id,
    synopsis: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

const NOW = new Date().toISOString();

function makePhase(
  overrides: Partial<CodexEntryPhase> & { id: string; entryId: string },
): CodexEntryPhase {
  return {
    anchorNodeId: null,
    label: "",
    summaryOverride: null,
    contentOverride: null,
    contextModeOverride: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeOverride(
  overrides: Partial<CodexPhaseDetailOverride> & {
    id: string;
    phaseId: string;
    definitionId: string;
  },
): CodexPhaseDetailOverride {
  return {
    value: null,
    ...overrides,
  };
}

const BASE_ENTRY = {
  summary: "Base summary",
  content: "{}",
  contextMode: "mentioned",
};

// ---------------------------------------------------------------------------
// computeGlobalSceneOrder
// ---------------------------------------------------------------------------

describe("computeGlobalSceneOrder", () => {
  it("空のノード配列 → 空Map", () => {
    const result = computeGlobalSceneOrder([]);
    expect(result.size).toBe(0);
  });

  it("シーンのみ3つ（フォルダなし）→ sortOrder順で0,1,2", () => {
    const nodes = [
      makeNode({ id: "s1", nodeType: "scene", sortOrder: "a1" }),
      makeNode({ id: "s2", nodeType: "scene", sortOrder: "a3" }),
      makeNode({ id: "s3", nodeType: "scene", sortOrder: "a2" }),
    ];
    const result = computeGlobalSceneOrder(nodes);
    expect(result.get("s1")).toBe(0);
    expect(result.get("s3")).toBe(1);
    expect(result.get("s2")).toBe(2);
  });

  it("フォルダ+シーン構造 → DFSで正しい順序", () => {
    // folder(sortOrder=0) → s1(sortOrder=0), s2(sortOrder=1)
    // s3(sortOrder=1, root)
    const nodes = [
      makeNode({ id: "folder1", nodeType: "folder", sortOrder: "a0" }),
      makeNode({
        id: "s1",
        nodeType: "scene",
        parentId: "folder1",
        sortOrder: "a0",
      }),
      makeNode({
        id: "s2",
        nodeType: "scene",
        parentId: "folder1",
        sortOrder: "a1",
      }),
      makeNode({ id: "s3", nodeType: "scene", sortOrder: "a1" }),
    ];
    const result = computeGlobalSceneOrder(nodes);
    // DFS: folder1 → s1(0), s2(1), then root s3(2)
    expect(result.get("s1")).toBe(0);
    expect(result.get("s2")).toBe(1);
    expect(result.get("s3")).toBe(2);
    // フォルダ自体はMapに含まれない
    expect(result.has("folder1")).toBe(false);
  });

  it("ノートノードはスキップされる", () => {
    const nodes = [
      makeNode({ id: "s1", nodeType: "scene", sortOrder: "a0" }),
      makeNode({ id: "note1", nodeType: "note", sortOrder: "a1" }),
      makeNode({ id: "s2", nodeType: "scene", sortOrder: "a2" }),
    ];
    const result = computeGlobalSceneOrder(nodes);
    expect(result.has("note1")).toBe(false);
    expect(result.get("s1")).toBe(0);
    expect(result.get("s2")).toBe(1);
    expect(result.size).toBe(2);
  });

  it("ネストしたフォルダ構造でもDFSで正しい順序", () => {
    // root: folder1(0), folder2(1)
    // folder1: s1(0), folder1a(1)
    // folder1a: s2(0)
    // folder2: s3(0)
    const nodes = [
      makeNode({ id: "folder1", nodeType: "folder", sortOrder: "a0" }),
      makeNode({ id: "folder2", nodeType: "folder", sortOrder: "a1" }),
      makeNode({
        id: "s1",
        nodeType: "scene",
        parentId: "folder1",
        sortOrder: "a0",
      }),
      makeNode({
        id: "folder1a",
        nodeType: "folder",
        parentId: "folder1",
        sortOrder: "a1",
      }),
      makeNode({
        id: "s2",
        nodeType: "scene",
        parentId: "folder1a",
        sortOrder: "a0",
      }),
      makeNode({
        id: "s3",
        nodeType: "scene",
        parentId: "folder2",
        sortOrder: "a0",
      }),
    ];
    const result = computeGlobalSceneOrder(nodes);
    expect(result.get("s1")).toBe(0);
    expect(result.get("s2")).toBe(1);
    expect(result.get("s3")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// resolveCodexState
// ---------------------------------------------------------------------------

describe("resolveCodexState", () => {
  const sceneOrder = new Map([
    ["scene-1", 0],
    ["scene-2", 1],
    ["scene-3", 2],
  ]);

  it("フェーズなし → Baseのみ返す", () => {
    const result = resolveCodexState(
      BASE_ENTRY,
      [],
      new Map(),
      new Map(),
      "scene-1",
      sceneOrder,
    );
    expect(result.summary).toBe("Base summary");
    expect(result.content).toBe("{}");
    expect(result.contextMode).toBe("mentioned");
    expect(result.appliedPhaseIds).toEqual([]);
  });

  it("currentSceneId=null → Baseのみ返す（フェーズ無視）", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      summaryOverride: "Phase summary",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      null,
      sceneOrder,
    );
    expect(result.summary).toBe("Base summary");
    expect(result.appliedPhaseIds).toEqual([]);
  });

  it("currentSceneIdがsceneOrderにない（シーン削除済み）→ Baseを返す", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      summaryOverride: "Phase summary",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      "scene-deleted",
      sceneOrder,
    );
    expect(result.summary).toBe("Base summary");
    expect(result.appliedPhaseIds).toEqual([]);
  });

  it("アンカー削除済み（sceneOrderにない）→ スキップ", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-deleted",
      summaryOverride: "Phase summary",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      "scene-2",
      sceneOrder,
    );
    expect(result.summary).toBe("Base summary");
    expect(result.appliedPhaseIds).toEqual([]);
  });

  it("anchorNodeId=nullのフェーズ → スキップ", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: null,
      summaryOverride: "Phase summary",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      "scene-2",
      sceneOrder,
    );
    expect(result.summary).toBe("Base summary");
    expect(result.appliedPhaseIds).toEqual([]);
  });

  it("1フェーズ適用（summaryOverride）", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      summaryOverride: "Phase 1 summary",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      "scene-2",
      sceneOrder,
    );
    expect(result.summary).toBe("Phase 1 summary");
    expect(result.appliedPhaseIds).toEqual(["p1"]);
  });

  it("複数フェーズ順次適用（先のフェーズが後で上書き）", () => {
    const phase1 = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      summaryOverride: "Phase 1 summary",
    });
    const phase2 = makePhase({
      id: "p2",
      entryId: "e1",
      anchorNodeId: "scene-2",
      summaryOverride: "Phase 2 summary",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase1, phase2],
      new Map(),
      new Map(),
      "scene-3",
      sceneOrder,
    );
    expect(result.summary).toBe("Phase 2 summary");
    expect(result.appliedPhaseIds).toEqual(["p1", "p2"]);
  });

  it("currentSceneの前のフェーズのみ適用（後のフェーズはスキップ）", () => {
    const phase1 = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      summaryOverride: "Phase 1 summary",
    });
    const phase2 = makePhase({
      id: "p2",
      entryId: "e1",
      anchorNodeId: "scene-3",
      summaryOverride: "Phase 2 summary",
    });
    // currentScene=scene-2 (index=1)、phase2のアンカーはscene-3(index=2) → スキップ
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase1, phase2],
      new Map(),
      new Map(),
      "scene-2",
      sceneOrder,
    );
    expect(result.summary).toBe("Phase 1 summary");
    expect(result.appliedPhaseIds).toEqual(["p1"]);
  });

  it("アンカーシーン自体がcurrentSceneと同じ → フェーズを適用する", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-2",
      summaryOverride: "Phase at current scene",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      "scene-2",
      sceneOrder,
    );
    expect(result.summary).toBe("Phase at current scene");
    expect(result.appliedPhaseIds).toEqual(["p1"]);
  });

  it("NULL vs 空文字の区別: nullは継承、空文字は空にクリア", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      summaryOverride: "", // 空文字でクリア
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      "scene-2",
      sceneOrder,
    );
    expect(result.summary).toBe("");
    expect(result.appliedPhaseIds).toEqual(["p1"]);
  });

  it("summaryOverride=null → summaryは継承（上書きしない）", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      summaryOverride: null, // nullは継承
      contentOverride: "New content",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      "scene-2",
      sceneOrder,
    );
    expect(result.summary).toBe("Base summary"); // 変わらない
    expect(result.content).toBe("New content");
    expect(result.appliedPhaseIds).toEqual(["p1"]);
  });

  it("detailValues上書き: baseDetails + phaseDetails上書き", () => {
    const baseDetails = new Map<string, string | null>([
      ["def-1", "Base value 1"],
      ["def-2", "Base value 2"],
    ]);
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
    });
    const override1 = makeOverride({
      id: "o1",
      phaseId: "p1",
      definitionId: "def-1",
      value: "Overridden value 1",
    });
    const override2 = makeOverride({
      id: "o2",
      phaseId: "p1",
      definitionId: "def-2",
      value: null, // nullでクリア
    });
    const phaseDetails = new Map([["p1", [override1, override2]]]);
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      phaseDetails,
      baseDetails,
      "scene-2",
      sceneOrder,
    );
    expect(result.detailValues.get("def-1")).toBe("Overridden value 1");
    expect(result.detailValues.get("def-2")).toBeNull();
    expect(result.appliedPhaseIds).toEqual(["p1"]);
  });

  it("baseDetailsはフェーズ適用後も元のMapを変更しない（独立コピー）", () => {
    const baseDetails = new Map<string, string | null>([["def-1", "original"]]);
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
    });
    const override = makeOverride({
      id: "o1",
      phaseId: "p1",
      definitionId: "def-1",
      value: "overridden",
    });
    const phaseDetails = new Map([["p1", [override]]]);
    resolveCodexState(
      BASE_ENTRY,
      [phase],
      phaseDetails,
      baseDetails,
      "scene-2",
      sceneOrder,
    );
    // baseDetailsは変更されていない
    expect(baseDetails.get("def-1")).toBe("original");
  });

  it("appliedPhaseIdsに適用済みフェーズIDが含まれる", () => {
    const phase1 = makePhase({
      id: "phase-abc",
      entryId: "e1",
      anchorNodeId: "scene-1",
    });
    const phase2 = makePhase({
      id: "phase-def",
      entryId: "e1",
      anchorNodeId: "scene-2",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase2, phase1], // 順序を逆にしても正しくソートされる
      new Map(),
      new Map(),
      "scene-3",
      sceneOrder,
    );
    expect(result.appliedPhaseIds).toContain("phase-abc");
    expect(result.appliedPhaseIds).toContain("phase-def");
    expect(result.appliedPhaseIds[0]).toBe("phase-abc"); // scene-1が先
    expect(result.appliedPhaseIds[1]).toBe("phase-def"); // scene-2が後
  });

  it("contentOverrideとcontextModeOverrideも正しく上書きされる", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      contentOverride: '{"type":"doc"}',
      contextModeOverride: "always",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      "scene-2",
      sceneOrder,
    );
    expect(result.content).toBe('{"type":"doc"}');
    expect(result.contextMode).toBe("always");
  });
});

// ---------------------------------------------------------------------------
// formatTimelineContext
// ---------------------------------------------------------------------------

describe("formatTimelineContext", () => {
  const entry = { name: "アリス", type: "character", summary: null };
  const resolved = {
    summary: "現在の状態サマリー",
    content: "{}",
    contextMode: "mentioned",
    detailValues: new Map<string, string | null>(),
    appliedPhaseIds: [],
  };

  it("フェーズなし → 変遷セクション省略", () => {
    const output = formatTimelineContext(entry, [], resolved);
    expect(output).toBe("# アリス (character)\n現在の状態: 現在の状態サマリー");
    expect(output).not.toContain("## 変遷");
  });

  it("フェーズあり → 正しいフォーマット", () => {
    const phases = [
      {
        label: "登場",
        anchorTitle: "第1話",
        summaryOverride: "初登場シーン",
      },
      {
        label: "変化",
        anchorTitle: "第3話",
        summaryOverride: null,
      },
    ];
    const output = formatTimelineContext(entry, phases, resolved);
    expect(output).toContain("# アリス (character)");
    expect(output).toContain("現在の状態: 現在の状態サマリー");
    expect(output).toContain("## 変遷");
    expect(output).toContain("- [登場] @ 第1話: 初登場シーン");
    expect(output).toContain("- [変化] @ 第3話: (変更なし)");
  });

  it("summary=null → (未設定) と表示される", () => {
    const resolvedNoSummary = { ...resolved, summary: null };
    const output = formatTimelineContext(entry, [], resolvedNoSummary);
    expect(output).toContain("現在の状態: (未設定)");
  });

  it("フォーマット全体が正しい構造を持つ（フェーズあり）", () => {
    const phases = [
      { label: "成長", anchorTitle: "第2話", summaryOverride: "成長後" },
    ];
    const output = formatTimelineContext(entry, phases, resolved);
    const lines = output.split("\n");
    expect(lines[0]).toBe("# アリス (character)");
    expect(lines[1]).toBe("現在の状態: 現在の状態サマリー");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("## 変遷");
    expect(lines[4]).toBe("- [成長] @ 第2話: 成長後");
  });
});

// ---------------------------------------------------------------------------
// computeSceneTimeIndex
// ---------------------------------------------------------------------------

describe("computeSceneTimeIndex", () => {
  it("reading モード → computeGlobalSceneOrder と同一の結果", () => {
    const nodes = [
      makeNode({ id: "s1", nodeType: "scene", sortOrder: "a1" }),
      makeNode({ id: "s2", nodeType: "scene", sortOrder: "a2" }),
    ];
    const expected = computeGlobalSceneOrder(nodes);
    const result = computeSceneTimeIndex(nodes, "reading");
    expect(result).toEqual(expected);
  });

  it("story モード: storyTimeOrder 順でインデックスを割り当てる", () => {
    // s2 は story-time が早い、s1 は遅い
    const nodes = [
      makeNode({
        id: "s1",
        nodeType: "scene",
        sortOrder: "a1",
        storyTimeOrder: "a2",
      }),
      makeNode({
        id: "s2",
        nodeType: "scene",
        sortOrder: "a2",
        storyTimeOrder: "a1",
      }),
    ];
    const result = computeSceneTimeIndex(nodes, "story");
    expect(result.get("s2")).toBe(0); // storyTimeOrder="a1" が先
    expect(result.get("s1")).toBe(1); // storyTimeOrder="a2" が後
  });

  it("story モード: storyTimeOrder=null のシーンは末尾にreading-order順で並ぶ", () => {
    const nodes = [
      makeNode({
        id: "s1",
        nodeType: "scene",
        sortOrder: "a1",
        storyTimeOrder: "a1",
      }),
      makeNode({
        id: "unscheduled1",
        nodeType: "scene",
        sortOrder: "a2",
        storyTimeOrder: null,
      }),
      makeNode({
        id: "unscheduled2",
        nodeType: "scene",
        sortOrder: "a3",
        storyTimeOrder: null,
      }),
    ];
    const result = computeSceneTimeIndex(nodes, "story");
    expect(result.get("s1")).toBe(0); // scheduled first
    expect(result.get("unscheduled1")).toBe(1); // reading-order: sortOrder="a2"
    expect(result.get("unscheduled2")).toBe(2); // reading-order: sortOrder="a3"
  });

  it("story モード: スケジュール済みが全くない場合はreading-orderと同一", () => {
    const nodes = [
      makeNode({ id: "s1", nodeType: "scene", sortOrder: "a1" }),
      makeNode({ id: "s2", nodeType: "scene", sortOrder: "a2" }),
    ];
    const result = computeSceneTimeIndex(nodes, "story");
    expect(result.get("s1")).toBe(0);
    expect(result.get("s2")).toBe(1);
  });

  it("auto モード: story モードと同一の結果", () => {
    const nodes = [
      makeNode({
        id: "s1",
        nodeType: "scene",
        sortOrder: "a1",
        storyTimeOrder: "a2",
      }),
      makeNode({
        id: "s2",
        nodeType: "scene",
        sortOrder: "a2",
        storyTimeOrder: "a1",
      }),
      makeNode({
        id: "s3",
        nodeType: "scene",
        sortOrder: "a3",
        storyTimeOrder: null,
      }),
    ];
    const storyResult = computeSceneTimeIndex(nodes, "story");
    const autoResult = computeSceneTimeIndex(nodes, "auto");
    expect(autoResult).toEqual(storyResult);
  });

  it("story モード: フォルダ構造内でもstoryTimeOrder順が優先される", () => {
    const nodes = [
      makeNode({ id: "folder1", nodeType: "folder", sortOrder: "a1" }),
      makeNode({
        id: "s1",
        nodeType: "scene",
        parentId: "folder1",
        sortOrder: "a1",
        storyTimeOrder: "a3", // story-time は3番目
      }),
      makeNode({
        id: "s2",
        nodeType: "scene",
        parentId: "folder1",
        sortOrder: "a2",
        storyTimeOrder: "a1", // story-time は1番目
      }),
      makeNode({
        id: "s3",
        nodeType: "scene",
        sortOrder: "a2",
        storyTimeOrder: "a2", // story-time は2番目
      }),
    ];
    const result = computeSceneTimeIndex(nodes, "story");
    expect(result.get("s2")).toBe(0);
    expect(result.get("s3")).toBe(1);
    expect(result.get("s1")).toBe(2);
    expect(result.has("folder1")).toBe(false);
  });

  it("story モード: 空配列 → 空Map", () => {
    const result = computeSceneTimeIndex([], "story");
    expect(result.size).toBe(0);
  });
});
