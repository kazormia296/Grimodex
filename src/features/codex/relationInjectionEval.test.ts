import { describe, it, expect } from "vitest";
import { buildEvalCorpus } from "./relationInjectionEvalSets";
import {
  runEval,
  computeArmMetrics,
  resolveSummaryAtScene,
  formatReport,
} from "./relationInjectionEval";

describe("relation injection 3-arm eval (deterministic)", () => {
  const corpus = buildEvalCorpus();

  it("prints the metric report", () => {
    const results = runEval(corpus);
    // 数値を CI ログに残す（人が読む用。console は vitest が握るので stdout 直書き）
    process.stdout.write("\n" + formatReport(results) + "\n");
    expect(results).toHaveLength(3);
  });

  it("corpus exhibits a real phase change: bob's summary differs at sc4 vs base", () => {
    const base = corpus.entries.find((e) => e.id === "bob")!.summary;
    const atSc4 = resolveSummaryAtScene(corpus, "bob", "sc4");
    const atSc1 = resolveSummaryAtScene(corpus, "bob", "sc1");
    expect(atSc1).toBe(base); // phase 適用前は base のまま
    expect(atSc4).not.toBe(base); // sc3 の phase 適用後は変化
    expect(atSc4).toContain("裏切り者");
  });

  it("mixed auto uses the same safe reading fallback as Phase resolution", () => {
    const base = corpus.entries.find((e) => e.id === "bob")!.summary;
    const bobPhase = corpus.phasesByEntry.get("bob")![0];
    const mixed = {
      ...corpus,
      resolutionMode: "auto" as const,
      nodes: [
        { ...corpus.nodes[0], id: "chapter-1", storyTimeOrder: null },
        { ...corpus.nodes[1], id: "chapter-8", storyTimeOrder: "a0" },
      ],
      phasesByEntry: new Map([
        ["bob", [{ ...bobPhase, anchorNodeId: "chapter-8" }]],
      ]),
    };

    expect(resolveSummaryAtScene(mixed, "bob", "chapter-1")).toBe(base);
  });

  it("off arm injects nothing", () => {
    const m = computeArmMetrics("off", corpus);
    expect(m.injectedCount).toBe(0);
    expect(m.injectedChars).toBe(0);
    expect(m.phaseStaleCount).toBe(0);
  });

  it("label-only (current) injects depth-1 neighbors only, with zero phase-stale leak", () => {
    const m = computeArmMetrics("label-only", corpus);
    // alice の直接の相手 = bob, cara のみ
    const ids = m.injected.map((e) => e.id).sort();
    expect(ids).toEqual(["bob", "cara"]);
    expect(m.depth2Count).toBe(0);
    // summary を出さない → 時点リークは構造的に 0
    expect(m.phaseStaleCount).toBe(0);
    // 関係ラベルは載る（payload は空でない）
    expect(m.injectedChars).toBeGreaterThan(0);
  });

  it("legacy reaches depth-2 and leaks phase-stale summaries; label-only does not", () => {
    const legacy = computeArmMetrics("legacy", corpus);
    const labelOnly = computeArmMetrics("label-only", corpus);

    // legacy は depth2 (dan, eve) まで展開
    const ids = legacy.injected.map((e) => e.id).sort();
    expect(ids).toEqual(["bob", "cara", "dan", "eve"]);
    expect(legacy.depth2Count).toBe(2);

    // legacy は生 summary を注入 → bob(sc3) と dan(sc2) が sc4 時点でリーク
    expect(legacy.phaseStaleCount).toBe(2);
    expect(legacy.staleEntryNames.sort()).toEqual(["ダン", "ボブ"]);

    // 修正の核心: label-only は同じコーパスでリーク 0
    expect(labelOnly.phaseStaleCount).toBe(0);

    // label-only の注入集合は legacy の部分集合（情報を増やさず減らす方向）
    const legacyIds = new Set(legacy.injected.map((e) => e.id));
    for (const e of labelOnly.injected) expect(legacyIds.has(e.id)).toBe(true);

    // payload 量: legacy > label-only（summary 本体の分だけ重い）
    expect(legacy.injectedChars).toBeGreaterThan(labelOnly.injectedChars);
  });
});
