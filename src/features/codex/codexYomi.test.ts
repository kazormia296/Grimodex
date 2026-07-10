import { describe, it, expect } from "vitest";
import { parseYomiResponse } from "./codexYomi";

const valid = () =>
  new Map<string, Set<string>>([
    ["e1", new Set(["刹那", "剣聖"])],
    ["e2", new Set(["帝都"])],
  ]);

describe("parseYomiResponse", () => {
  it("有効な読みを id→[{surface,yomi}] に集約する", () => {
    const text =
      '{"readings":[{"id":"e1","surface":"刹那","yomi":"せつな"},{"id":"e2","surface":"帝都","yomi":"ていと"}]}';
    const m = parseYomiResponse(text, valid());
    expect(m.get("e1")).toEqual([{ surface: "刹那", yomi: "せつな" }]);
    expect(m.get("e2")).toEqual([{ surface: "帝都", yomi: "ていと" }]);
  });

  it("同一 id の複数表記をまとめる", () => {
    const text =
      '{"readings":[{"id":"e1","surface":"刹那","yomi":"せつな"},{"id":"e1","surface":"剣聖","yomi":"けんせい"}]}';
    const m = parseYomiResponse(text, valid());
    expect(m.get("e1")).toEqual([
      { surface: "刹那", yomi: "せつな" },
      { surface: "剣聖", yomi: "けんせい" },
    ]);
  });

  it("カタカナ読みはひらがなに正規化する", () => {
    const text = '{"readings":[{"id":"e1","surface":"刹那","yomi":"セツナ"}]}';
    expect(parseYomiResponse(text, valid()).get("e1")).toEqual([
      { surface: "刹那", yomi: "せつな" },
    ]);
  });

  it("未知の id を棄却する (hallucination)", () => {
    const text =
      '{"readings":[{"id":"ghost","surface":"刹那","yomi":"せつな"}]}';
    expect(parseYomiResponse(text, valid()).size).toBe(0);
  });

  it("id に許可されていない surface を棄却する (取り違え)", () => {
    const text = '{"readings":[{"id":"e1","surface":"帝都","yomi":"ていと"}]}';
    expect(parseYomiResponse(text, valid()).size).toBe(0);
  });

  it("空 yomi・漢字を残した yomi (表記エコー) を棄却する", () => {
    const text =
      '{"readings":[{"id":"e1","surface":"刹那","yomi":""},{"id":"e1","surface":"剣聖","yomi":"剣聖"}]}';
    expect(parseYomiResponse(text, valid()).size).toBe(0);
  });

  it("非かな yomi (ローマ字/句読点/中間スペース) を棄却する", () => {
    const text =
      '{"readings":[{"id":"e1","surface":"刹那","yomi":"setsuna"},{"id":"e1","surface":"剣聖","yomi":"けんせい。"},{"id":"e2","surface":"帝都","yomi":"てい と"}]}';
    expect(parseYomiResponse(text, valid()).size).toBe(0);
  });

  it("長音符ーを含むひらがな読みは採用する", () => {
    const v = new Map<string, Set<string>>([["e1", new Set(["瑠璃"])]]);
    const text = '{"readings":[{"id":"e1","surface":"瑠璃","yomi":"るりー"}]}';
    expect(parseYomiResponse(text, v).get("e1")).toEqual([
      { surface: "瑠璃", yomi: "るりー" },
    ]);
  });

  it("同一 (id,surface) の重複は最初の 1 件を採用する", () => {
    const text =
      '{"readings":[{"id":"e1","surface":"刹那","yomi":"せつな"},{"id":"e1","surface":"刹那","yomi":"せちな"}]}';
    expect(parseYomiResponse(text, valid()).get("e1")).toEqual([
      { surface: "刹那", yomi: "せつな" },
    ]);
  });

  it("前置きテキスト付き応答から JSON を抽出する", () => {
    const text =
      'はい、こちらです:\n{"readings":[{"id":"e1","surface":"刹那","yomi":"せつな"}]}';
    expect(parseYomiResponse(text, valid()).get("e1")).toEqual([
      { surface: "刹那", yomi: "せつな" },
    ]);
  });

  it("readings が配列でない / 破損 JSON / 空文字は空マップ", () => {
    expect(parseYomiResponse('{"readings":"nope"}', valid()).size).toBe(0);
    expect(parseYomiResponse("{ broken", valid()).size).toBe(0);
    expect(parseYomiResponse("", valid()).size).toBe(0);
    expect(parseYomiResponse("no json here", valid()).size).toBe(0);
  });

  it("欠損フィールド (id/surface/yomi 非文字列) の要素を飛ばす", () => {
    const text =
      '{"readings":[{"id":"e1","yomi":"せつな"},{"surface":"刹那","yomi":"せつな"},{"id":"e1","surface":"刹那","yomi":123},{"id":"e1","surface":"剣聖","yomi":"けんせい"}]}';
    const m = parseYomiResponse(text, valid());
    expect(m.get("e1")).toEqual([{ surface: "剣聖", yomi: "けんせい" }]);
  });
});
