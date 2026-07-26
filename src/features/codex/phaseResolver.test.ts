import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "@/db/schema";
import {
  computeGlobalSceneOrder,
  computePhaseExposureBreakdown,
  computeSceneTimeIndex,
  formatTimelineContext,
  resolveCodexState,
} from "./phaseResolver";
import { buildSceneTimeIndex } from "./context/sceneTimeIndex";

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

    intent: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
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

  it("applyAllPhases: null sceneId でも全 valid phase を適用", () => {
    const phase1 = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      summaryOverride: "After phase 1",
    });
    const phase2 = makePhase({
      id: "p2",
      entryId: "e1",
      anchorNodeId: "scene-2",
      summaryOverride: "After phase 2",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase2, phase1],
      new Map(),
      new Map(),
      null,
      sceneOrder,
      { applyAllPhases: true },
    );
    expect(result.summary).toBe("After phase 2");
    expect(result.appliedPhaseIds).toEqual(["p1", "p2"]);
  });

  it("applyAllPhases: anchor 不在 phase は除外", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-deleted",
      summaryOverride: "Should skip",
    });
    const result = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      null,
      sceneOrder,
      { applyAllPhases: true },
    );
    expect(result.summary).toBe("Base summary");
    expect(result.appliedPhaseIds).toEqual([]);
  });

  it("applyAllPhases 未指定時は既存の null=Base の挙動を維持", () => {
    const phase = makePhase({
      id: "p1",
      entryId: "e1",
      anchorNodeId: "scene-1",
      summaryOverride: "Phase summary",
    });
    const withOption = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      null,
      sceneOrder,
      { applyAllPhases: false },
    );
    const withoutOption = resolveCodexState(
      BASE_ENTRY,
      [phase],
      new Map(),
      new Map(),
      null,
      sceneOrder,
    );
    expect(withOption).toEqual(withoutOption);
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

  it("SceneTimeIndex API: safe auto semantics と diagnostics を反映する", () => {
    const nodes = [
      makeNode({ id: "chapter-1", sortOrder: "a0" }),
      makeNode({
        id: "chapter-8",
        sortOrder: "a1",
        storyTimeOrder: "a0",
      }),
    ];
    const result = resolveCodexState(
      BASE_ENTRY,
      [
        makePhase({
          id: "future",
          entryId: "e1",
          anchorNodeId: "chapter-8",
          summaryOverride: "Future truth",
        }),
      ],
      new Map(),
      new Map(),
      { kind: "scene", sceneId: "chapter-1" },
      buildSceneTimeIndex(nodes),
      "auto",
    );

    expect(result.summary).toBe("Base summary");
    expect(result.appliedPhaseIds).toEqual([]);
    expect(result.activePhaseId).toBeNull();
    expect(result.activePhaseLabel).toBeNull();
    expect(result.axisUsed).toBe("reading");
    expect(result.fallbackReason).toBe("auto-incomplete-story-coverage");
  });

  it("SceneTimeIndex API: latest は deterministic 順で全 valid phase を適用する", () => {
    const nodes = [
      makeNode({ id: "s1", sortOrder: "a0" }),
      makeNode({ id: "s2", sortOrder: "a1" }),
    ];
    const result = resolveCodexState(
      BASE_ENTRY,
      [
        makePhase({
          id: "p2",
          entryId: "e1",
          anchorNodeId: "s2",
          label: "Second",
          summaryOverride: "Second",
        }),
        makePhase({
          id: "p1",
          entryId: "e1",
          anchorNodeId: "s1",
          label: "First",
          summaryOverride: "First",
        }),
      ],
      new Map(),
      new Map(),
      { kind: "latest" },
      buildSceneTimeIndex(nodes),
      "reading",
    );

    expect(result.summary).toBe("Second");
    expect(result.appliedPhaseIds).toEqual(["p1", "p2"]);
    expect(result.activePhaseId).toBe("p2");
    expect(result.activePhaseLabel).toBe("Second");
    expect(result.axisUsed).toBe("reading");
  });

  it("SceneTimeIndex API: explicit Phase preview inherits earlier values without later sibling leakage", () => {
    const index = buildSceneTimeIndex([
      makeNode({ id: "shared", sortOrder: "a0" }),
    ]);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const earlier = makePhase({
      id: "a-earlier",
      entryId: "e1",
      anchorNodeId: "shared",
      label: "Earlier",
      contentOverride: '{"type":"doc","from":"earlier"}',
      createdAt,
    });
    const target = makePhase({
      id: "b-target",
      entryId: "e1",
      anchorNodeId: "shared",
      label: "Target",
      summaryOverride: "Target summary",
      createdAt,
    });
    const later = makePhase({
      id: "c-later",
      entryId: "e1",
      anchorNodeId: "shared",
      label: "Later",
      contentOverride: '{"type":"doc","from":"later"}',
      summaryOverride: "Later summary",
      createdAt,
    });

    const result = resolveCodexState(
      BASE_ENTRY,
      [later, target, earlier],
      new Map(),
      new Map(),
      { kind: "phase", phaseId: target.id },
      index,
      "reading",
    );

    expect(result.content).toBe('{"type":"doc","from":"earlier"}');
    expect(result.summary).toBe("Target summary");
    expect(result.appliedPhaseIds).toEqual(["a-earlier", "b-target"]);
    expect(result.activePhaseId).toBe("b-target");
    expect(result.activePhaseLabel).toBe("Target");
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
    activePhaseId: null,
    activePhaseLabel: null,
    axisUsed: "reading" as const,
    fallbackReason: null,
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

  it("lang=en → 見出し/プレースホルダが英語化 (ja 文字は出ない)", () => {
    const phases = [
      {
        label: "intro",
        anchorTitle: "Ch.1",
        summaryOverride: "first appearance",
      },
      { label: "change", anchorTitle: "Ch.3", summaryOverride: null },
    ];
    const resolvedNoSummary = { ...resolved, summary: null };
    const output = formatTimelineContext(
      entry,
      phases,
      resolvedNoSummary,
      "en",
    );
    expect(output).toContain("Current state: (unset)");
    expect(output).toContain("## Changes");
    expect(output).toContain("- [change] @ Ch.3: (no change)");
    // ja 見出し/プレースホルダは en では出ない
    expect(output).not.toContain("現在の状態");
    expect(output).not.toContain("変遷");
    expect(output).not.toContain("未設定");
    expect(output).not.toContain("変更なし");
  });

  it("lang 省略 / ja は従来の日本語出力 (byte 不変)", () => {
    expect(formatTimelineContext(entry, [], resolved)).toBe(
      "# アリス (character)\n現在の状態: 現在の状態サマリー",
    );
    expect(formatTimelineContext(entry, [], resolved, "ja")).toBe(
      "# アリス (character)\n現在の状態: 現在の状態サマリー",
    );
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

  it("auto モード: 部分設定中は project 全体を reading-order に倒す", () => {
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
    const autoResult = computeSceneTimeIndex(nodes, "auto");
    expect(autoResult.get("s1")).toBe(0);
    expect(autoResult.get("s2")).toBe(1);
    expect(autoResult.get("s3")).toBe(2);
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

// ---------------------------------------------------------------------------
// computePhaseExposureBreakdown
// ---------------------------------------------------------------------------

describe("computePhaseExposureBreakdown", () => {
  it("空 phases: total=0, base contextMode を反映する", () => {
    const result = computePhaseExposureBreakdown({
      baseSummary: "Hi",
      baseContextMode: "mentioned",
      phases: [],
    });
    expect(result.total).toBe(0);
    expect(result.aiVisibleCount).toBe(0);
    expect(result.wikiOnlyCount).toBe(0);
    expect(result.baseIsAiVisible).toBe(true);
  });

  it("base=hidden, phases なし: baseIsAiVisible=false", () => {
    const result = computePhaseExposureBreakdown({
      baseSummary: "Hi",
      baseContextMode: "hidden",
      phases: [],
    });
    expect(result.baseIsAiVisible).toBe(false);
  });

  it("base=mentioned, override 無しの phases → 全て AI-visible", () => {
    const phases = [
      makePhase({ id: "p1", entryId: "e1" }),
      makePhase({ id: "p2", entryId: "e1" }),
    ];
    const result = computePhaseExposureBreakdown({
      baseSummary: "S",
      baseContextMode: "mentioned",
      phases,
    });
    expect(result.aiVisibleCount).toBe(2);
    expect(result.wikiOnlyCount).toBe(0);
    expect(result.total).toBe(2);
  });

  it("base=hidden, override 無しの phases → 全て Wiki-only", () => {
    const phases = [
      makePhase({ id: "p1", entryId: "e1" }),
      makePhase({ id: "p2", entryId: "e1" }),
    ];
    const result = computePhaseExposureBreakdown({
      baseSummary: "S",
      baseContextMode: "hidden",
      phases,
    });
    expect(result.aiVisibleCount).toBe(0);
    expect(result.wikiOnlyCount).toBe(2);
  });

  it("中盤の contextMode override は以降の phases にも持ち越される", () => {
    const phases = [
      makePhase({ id: "p1", entryId: "e1" }), // mentioned (継承)
      makePhase({ id: "p2", entryId: "e1", contextModeOverride: "hidden" }),
      makePhase({ id: "p3", entryId: "e1" }), // hidden (継承)
      makePhase({ id: "p4", entryId: "e1", contextModeOverride: "always" }),
    ];
    const result = computePhaseExposureBreakdown({
      baseSummary: "S",
      baseContextMode: "mentioned",
      phases,
    });
    expect(result.aiVisibleCount).toBe(2); // p1 (mentioned), p4 (always)
    expect(result.wikiOnlyCount).toBe(2); // p2 (hidden), p3 (hidden 継承)
  });

  it("suppress も Wiki-only として扱う", () => {
    const phases = [
      makePhase({ id: "p1", entryId: "e1", contextModeOverride: "suppress" }),
    ];
    const result = computePhaseExposureBreakdown({
      baseSummary: "S",
      baseContextMode: "mentioned",
      phases,
    });
    expect(result.wikiOnlyCount).toBe(1);
    expect(result.aiVisibleCount).toBe(0);
  });

  it("maxAiVisibleSummaryChars: base が AI-visible なら base summary 長を含む", () => {
    const result = computePhaseExposureBreakdown({
      baseSummary: "12345678",
      baseContextMode: "mentioned",
      phases: [],
    });
    expect(result.maxAiVisibleSummaryChars).toBe(8);
  });

  it("maxAiVisibleSummaryChars: base が Wiki なら base summary は除外", () => {
    const result = computePhaseExposureBreakdown({
      baseSummary: "12345678",
      baseContextMode: "hidden",
      phases: [],
    });
    expect(result.maxAiVisibleSummaryChars).toBe(0);
  });

  it("maxAiVisibleSummaryChars: AI-visible phase の summaryOverride が base より長ければそちらを採用", () => {
    const phases = [
      makePhase({
        id: "p1",
        entryId: "e1",
        summaryOverride: "very long phase summary text here",
      }),
    ];
    const result = computePhaseExposureBreakdown({
      baseSummary: "short",
      baseContextMode: "mentioned",
      phases,
    });
    expect(result.maxAiVisibleSummaryChars).toBe(
      "very long phase summary text here".length,
    );
  });

  it("maxAiVisibleSummaryChars: Wiki-only phase の summary 長はカウントしない", () => {
    const phases = [
      makePhase({
        id: "p1",
        entryId: "e1",
        contextModeOverride: "hidden",
        summaryOverride: "12345678901234567890",
      }),
    ];
    const result = computePhaseExposureBreakdown({
      baseSummary: "short",
      baseContextMode: "mentioned",
      phases,
    });
    expect(result.maxAiVisibleSummaryChars).toBe(5); // base のみ
  });

  it("summaryOverride=null の phase は前段の summary を継承（長さ維持）", () => {
    const phases = [
      makePhase({
        id: "p1",
        entryId: "e1",
        summaryOverride: "longer summary value here",
      }),
      makePhase({
        id: "p2",
        entryId: "e1",
        // summaryOverride=null → p1 の summary を継承
      }),
    ];
    const result = computePhaseExposureBreakdown({
      baseSummary: "S",
      baseContextMode: "mentioned",
      phases,
    });
    expect(result.maxAiVisibleSummaryChars).toBe(
      "longer summary value here".length,
    );
  });
});
