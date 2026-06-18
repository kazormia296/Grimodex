// src/features/codex/resolveCodexStatesFor.test.ts
import { describe, it, expect } from "vitest";
import { resolveCodexStatesFor } from "./resolveCodexStatesFor";
import type { CodexEntryPhase } from "./phaseApi";

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

describe("resolveCodexStatesFor", () => {
  const order = new Map<string, number>([
    ["s1", 0],
    ["s2", 1],
    ["s3", 2],
  ]);

  it("フェーズなし → base summary・phaseLabel なし", () => {
    const out = resolveCodexStatesFor([makeEntry()], {}, {}, order, "s3");
    expect(out.get("e1")).toEqual({ resolvedSummary: "ベース要約" });
  });
  it("現在シーン以下のフェーズで summary を上書きし phaseLabel を返す", () => {
    const phases = { e1: [makePhase({ summaryOverride: "第2幕の姿" })] };
    const out = resolveCodexStatesFor([makeEntry()], phases, {}, order, "s3");
    expect(out.get("e1")).toEqual({
      phaseLabel: "第2幕",
      resolvedSummary: "第2幕の姿",
    });
  });
  it("現在シーンがフェーズ anchor より前なら base のまま", () => {
    const phases = { e1: [makePhase({ summaryOverride: "第2幕の姿" })] };
    const out = resolveCodexStatesFor([makeEntry()], phases, {}, order, "s1");
    expect(out.get("e1")).toEqual({ resolvedSummary: "ベース要約" });
  });
  it("currentSceneId が null なら base のみ", () => {
    const phases = { e1: [makePhase({ summaryOverride: "第2幕の姿" })] };
    const out = resolveCodexStatesFor([makeEntry()], phases, {}, order, null);
    expect(out.get("e1")).toEqual({ resolvedSummary: "ベース要約" });
  });
});
