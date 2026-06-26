import { describe, it, expect } from "vitest";
import { fitLabelToWidth } from "./threadLabelFit";

const FS = 11; // スレッドヘッダーの fontSize

describe("fitLabelToWidth", () => {
  it("短い名前はそのまま返す", () => {
    expect(fitLabelToWidth("主筋", 86, FS)).toBe("主筋");
    expect(fitLabelToWidth("Plot A", 86, FS)).toBe("Plot A");
  });

  it("全角の長い名前は省略記号付きで打ち切る（カプセル幅 86px に収まる）", () => {
    const out = fitLabelToWidth("主人公の出生をめぐる因縁の物語", 86, FS);
    expect(out.endsWith("…")).toBe(true);
    // 全角は約 1em。86px / 11px ≈ 7 文字 − 省略記号ぶん。元の名前より短い。
    expect([...out].length).toBeLessThan(
      [..."主人公の出生をめぐる因縁の物語"].length,
    );
    // 省略記号を除いた本体＋"…" が利用可能幅に収まる（全角=fontSize 近似）。
    expect(([...out].length - 1) * FS).toBeLessThanOrEqual(86);
  });

  it("半角は全角より多く収まる（幅 0.55em 近似）", () => {
    const cjk = fitLabelToWidth("あ".repeat(40), 86, FS);
    const latin = fitLabelToWidth("a".repeat(40), 86, FS);
    expect([...latin].length).toBeGreaterThan([...cjk].length);
  });

  it("幅 0 以下なら空文字（防御）", () => {
    expect(fitLabelToWidth("xxxx", 0, FS)).toBe("");
  });

  it("サロゲートペアを壊さない", () => {
    const out = fitLabelToWidth("𩸽".repeat(20), 86, FS);
    const body = out.endsWith("…") ? out.slice(0, -1) : out;
    // body は 𩸽 のみで構成され、半端なコードユニットを含まない。
    expect([...body].every((c) => c === "𩸽")).toBe(true);
  });
});
