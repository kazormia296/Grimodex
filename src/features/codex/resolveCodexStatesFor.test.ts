// src/features/codex/resolveCodexStatesFor.test.ts
import { describe, it, expect } from "vitest";
import { resolveCodexStatesFor } from "./resolveCodexStatesFor";
import type { CodexEntryPhase } from "./phaseApi";
import { buildSceneTimeIndex } from "./context/sceneTimeIndex";
import { usePhaseStore } from "./phaseStore";
import type { TreeNodeData } from "@/features/tree/treeStore";

type EntryInput = Parameters<typeof resolveCodexStatesFor>[0][number];

function makeEntry(over: Partial<EntryInput> = {}): EntryInput {
  return {
    id: "e1",
    summary: "ベース要約",
    content: "{}",
    contextMode: "mentioned",
    ...over,
  };
}
function makePhase(over: Partial<CodexEntryPhase> = {}): CodexEntryPhase {
  return {
    id: "p1",
    entryId: "e1",
    label: "第2幕",
    anchorNodeId: "s2",
    summaryOverride: null,
    contentOverride: null,
    contextModeOverride: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...over,
  } as CodexEntryPhase;
}

function scene(
  id: string,
  sortOrder: string,
  storyTimeOrder: string | null = null,
): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

describe("resolveCodexStatesFor", () => {
  const index = buildSceneTimeIndex([
    scene("s1", "a0"),
    scene("s2", "a1"),
    scene("s3", "a2"),
  ]);

  it("フェーズなし → base summary・phaseLabel なし", () => {
    const out = resolveCodexStatesFor([makeEntry()], {}, {}, index, "reading", {
      kind: "scene",
      sceneId: "s3",
    });
    expect(out.get("e1")).toEqual({
      resolvedSummary: "ベース要約",
      appliedPhaseIds: [],
    });
  });
  it("現在シーン以下のフェーズで summary を上書きし phaseLabel を返す", () => {
    const phases = { e1: [makePhase({ summaryOverride: "第2幕の姿" })] };
    const out = resolveCodexStatesFor(
      [makeEntry()],
      phases,
      {},
      index,
      "reading",
      { kind: "scene", sceneId: "s3" },
    );
    expect(out.get("e1")).toEqual({
      phaseLabel: "第2幕",
      resolvedSummary: "第2幕の姿",
      appliedPhaseIds: ["p1"],
    });
  });
  it("現在シーンがフェーズ anchor より前なら base のまま", () => {
    const phases = { e1: [makePhase({ summaryOverride: "第2幕の姿" })] };
    const out = resolveCodexStatesFor(
      [makeEntry()],
      phases,
      {},
      index,
      "reading",
      { kind: "scene", sceneId: "s1" },
    );
    expect(out.get("e1")).toEqual({
      resolvedSummary: "ベース要約",
      appliedPhaseIds: [],
    });
  });
  it("base anchor なら Phase を適用しない", () => {
    const phases = { e1: [makePhase({ summaryOverride: "第2幕の姿" })] };
    const out = resolveCodexStatesFor(
      [makeEntry()],
      phases,
      {},
      index,
      "reading",
      { kind: "base" },
    );
    expect(out.get("e1")).toEqual({
      resolvedSummary: "ベース要約",
      appliedPhaseIds: [],
    });
  });
  it("summaryOverride なしのフェーズでも phaseLabel は返し summary は base のまま", () => {
    const phases = { e1: [makePhase({ contentOverride: "新本文" })] };
    const out = resolveCodexStatesFor(
      [makeEntry()],
      phases,
      {},
      index,
      "reading",
      { kind: "scene", sceneId: "s3" },
    );
    expect(out.get("e1")).toEqual({
      phaseLabel: "第2幕",
      resolvedSummary: "ベース要約",
      appliedPhaseIds: ["p1"],
    });
  });

  it("mixed auto で phaseStore と同じ applied IDs を返す", () => {
    const mixedNodes = [
      scene("chapter-1", "a0"),
      scene("chapter-8", "a1", "a0"),
    ];
    const mixedIndex = buildSceneTimeIndex(mixedNodes);
    const future = makePhase({
      id: "future",
      anchorNodeId: "chapter-8",
      summaryOverride: "未来の姿",
    });
    const phases = { e1: [future] };

    usePhaseStore.setState({
      phasesByEntry: phases,
      detailOverrides: {},
      sceneTimeIndex: mixedIndex,
      resolutionMode: "auto",
    });
    usePhaseStore
      .getState()
      .resolveForScene([makeEntry() as never], new Map(), "chapter-1");
    const storeResolved = usePhaseStore.getState().getResolvedState("e1");

    const badges = resolveCodexStatesFor(
      [makeEntry()],
      phases,
      {},
      mixedIndex,
      "auto",
      { kind: "scene", sceneId: "chapter-1" },
    );
    expect(badges.get("e1")?.appliedPhaseIds).toEqual(
      storeResolved?.appliedPhaseIds,
    );
    expect(badges.get("e1")?.appliedPhaseIds).toEqual([]);
    expect(badges.get("e1")?.resolvedSummary).toBe("ベース要約");
  });
});
