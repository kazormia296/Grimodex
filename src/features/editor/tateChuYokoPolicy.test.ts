import { describe, it, expect } from "vitest";
import {
  TATE_CHU_YOKO_RUN,
  tateChuYokoRunAllowed,
  runLengthAllowed,
  type TateChuYokoPolicy,
} from "./tateChuYokoPolicy";

/** テキストから「実際に縦中横対象になる run」だけを取り出すヘルパ。 */
function targetRuns(text: string, policy: TateChuYokoPolicy): string[] {
  return [...text.matchAll(TATE_CHU_YOKO_RUN)]
    .map((m) => m[0])
    .filter((run) => tateChuYokoRunAllowed(run, policy));
}

describe("tateChuYokoRunAllowed - 半角数字（従来ポリシー維持）", () => {
  it("policy=all は2桁以上を対象、1桁は対象外", () => {
    expect(tateChuYokoRunAllowed("2026", "all")).toBe(true);
    expect(tateChuYokoRunAllowed("12", "all")).toBe(true);
    expect(tateChuYokoRunAllowed("5", "all")).toBe(false);
  });
  it("policy=2 は2桁のみ、3桁以上は対象外", () => {
    expect(tateChuYokoRunAllowed("12", "2")).toBe(true);
    expect(tateChuYokoRunAllowed("123", "2")).toBe(false);
  });
  it("policy=off は全種類が対象外", () => {
    expect(tateChuYokoRunAllowed("12", "off")).toBe(false);
    expect(tateChuYokoRunAllowed("！？", "off")).toBe(false);
    expect(tateChuYokoRunAllowed("III", "off")).toBe(false);
  });
});

describe("tateChuYokoRunAllowed - 記号クラスタ（！？ ？！ ！！ など）", () => {
  it("全角・半角・混在の2文字以上を常に対象にする（policy 2/all 双方）", () => {
    for (const policy of ["2", "all"] as const) {
      expect(tateChuYokoRunAllowed("！？", policy)).toBe(true);
      expect(tateChuYokoRunAllowed("？！", policy)).toBe(true);
      expect(tateChuYokoRunAllowed("！！", policy)).toBe(true);
      expect(tateChuYokoRunAllowed("？？", policy)).toBe(true);
      expect(tateChuYokoRunAllowed("!?", policy)).toBe(true);
      expect(tateChuYokoRunAllowed("?!", policy)).toBe(true);
      expect(tateChuYokoRunAllowed("！?", policy)).toBe(true); // 全角＋半角混在
    }
  });
  it("単独の記号は候補にすらならない（2文字以上のみ）", () => {
    expect([..."！".matchAll(TATE_CHU_YOKO_RUN)]).toHaveLength(0);
    expect([..."？".matchAll(TATE_CHU_YOKO_RUN)]).toHaveLength(0);
  });
});

describe("tateChuYokoRunAllowed - ローマ数字", () => {
  it("Unicode ローマ数字（Ⅰ..ⅿ）は単独でも対象", () => {
    expect(tateChuYokoRunAllowed("Ⅲ", "all")).toBe(true);
    expect(tateChuYokoRunAllowed("Ⅶ", "all")).toBe(true);
    expect(tateChuYokoRunAllowed("ⅳ", "all")).toBe(true); // 小文字
  });
  it("ASCII 大文字ローマ数字の厳密形（2文字以上）を対象", () => {
    expect(tateChuYokoRunAllowed("II", "all")).toBe(true);
    expect(tateChuYokoRunAllowed("III", "all")).toBe(true);
    expect(tateChuYokoRunAllowed("IV", "all")).toBe(true);
    expect(tateChuYokoRunAllowed("VII", "all")).toBe(true);
    expect(tateChuYokoRunAllowed("XII", "all")).toBe(true);
    // ローマ数字は桁ポリシー非依存（policy=2 でも対象）。
    expect(tateChuYokoRunAllowed("III", "2")).toBe(true);
  });
  it("非厳密な並び（IIII 等）は対象外", () => {
    expect(tateChuYokoRunAllowed("IIII", "all")).toBe(false);
    expect(tateChuYokoRunAllowed("VV", "all")).toBe(false);
  });
  it("単独の ASCII 文字（I / V / X）は候補にならない＝英文の I を誤結合しない", () => {
    expect([..."I".matchAll(TATE_CHU_YOKO_RUN)]).toHaveLength(0);
    expect([..."V".matchAll(TATE_CHU_YOKO_RUN)]).toHaveLength(0);
    expect([..."X".matchAll(TATE_CHU_YOKO_RUN)]).toHaveLength(0);
  });
  it("ローマ字だけの英単語（CIVIL/VIVID/DID/ILL）は厳密判定で弾く", () => {
    expect(tateChuYokoRunAllowed("CIVIL", "all")).toBe(false);
    expect(tateChuYokoRunAllowed("VIVID", "all")).toBe(false);
    expect(tateChuYokoRunAllowed("DID", "all")).toBe(false);
    expect(tateChuYokoRunAllowed("ILL", "all")).toBe(false);
  });
});

describe("TATE_CHU_YOKO_RUN - 文中の複数 run 抽出", () => {
  it("数字・記号・ローマ数字が混在した文から対象 run を正しく拾う", () => {
    const s = "第III章、西暦2026年、そして…本当に！？";
    expect(targetRuns(s, "all")).toEqual(["III", "2026", "！？"]);
  });
  it("互いに素な文字集合なので隣接しても別 run になる", () => {
    // "12" 数字 と "III" ローマ数字 が隣接。
    expect(targetRuns("12III", "all")).toEqual(["12", "III"]);
  });
});

describe("runLengthAllowed - 後方互換（数字専用）", () => {
  it("従来の length ポリシーがそのまま残る", () => {
    expect(runLengthAllowed(2, "2")).toBe(true);
    expect(runLengthAllowed(3, "2")).toBe(false);
    expect(runLengthAllowed(3, "all")).toBe(true);
    expect(runLengthAllowed(1, "all")).toBe(false);
  });
});
