import { describe, it, expect } from "vitest";
import { buildVsInstruction } from "./verbalizedSampling";

describe("buildVsInstruction", () => {
  it("ja: 裾サンプリング・構造分岐・典型回避を含み、しきい値を反映する", () => {
    const s = buildVsInstruction("ja", { threshold: 0.1 });
    expect(s).toContain("0.1");
    expect(s).toContain("裾"); // tail sampling
    expect(s).toContain("構造"); // structural divergence (not just wording)
    expect(s).toMatch(/典型|ありがち/); // avoid the mode
  });

  it("en: emits English directives with the given threshold", () => {
    const s = buildVsInstruction("en", { threshold: 0.05 });
    expect(s).toContain("0.05");
    expect(s.toLowerCase()).toContain("tail");
    expect(s.toLowerCase()).toContain("structure");
  });

  it("threshold 省略時は 0.1 を既定にする", () => {
    expect(buildVsInstruction("ja")).toContain("0.1");
    expect(buildVsInstruction("en")).toContain("0.1");
  });

  it("cot=true で『切り口』の前置きを足し、既定では足さない", () => {
    expect(buildVsInstruction("ja", { cot: true })).toContain("切り口");
    expect(buildVsInstruction("ja", { cot: false })).not.toContain("切り口");
    expect(buildVsInstruction("ja")).not.toContain("切り口");
  });

  it("emitProbability=true は確率を添えさせ、既定(false)は数値非出力を指示する", () => {
    const emit = buildVsInstruction("ja", { emitProbability: true });
    const hide = buildVsInstruction("ja", { emitProbability: false });
    expect(emit).toMatch(/確率.*(添え|付け)/);
    expect(emit).not.toMatch(/出力しない|書かない/);
    expect(hide).toMatch(/出力しない|書かない/);
  });

  it("既定では確率を出力させない(emitProbability 既定 false)", () => {
    expect(buildVsInstruction("en")).toMatch(/do not (output|print|include)/i);
  });
});
