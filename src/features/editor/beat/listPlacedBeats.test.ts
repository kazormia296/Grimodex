import { describe, it, expect } from "vitest";
import { listPlacedBeatsFromJson } from "./listPlacedBeats";

function sceneBeat(
  id: string,
  text: string,
  beatType = "free",
  pov: string | null = null,
) {
  return {
    type: "sceneBeat",
    attrs: { id, beatType, pov, collapsed: false },
    content: [{ type: "text", text }],
  };
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

describe("listPlacedBeatsFromJson", () => {
  it("doc が null/undefined なら空配列を返す", () => {
    expect(listPlacedBeatsFromJson(null)).toEqual([]);
    expect(listPlacedBeatsFromJson(undefined)).toEqual([]);
  });

  it("content を持たない doc は空配列を返す", () => {
    expect(listPlacedBeatsFromJson({ type: "doc" })).toEqual([]);
  });

  it("sceneBeat が無い doc は空配列を返す", () => {
    const doc = {
      type: "doc",
      content: [paragraph("hello"), paragraph("world")],
    };
    expect(listPlacedBeatsFromJson(doc)).toEqual([]);
  });

  it("複数 sceneBeat を doc 順に列挙し index を 1-origin で振る", () => {
    const doc = {
      type: "doc",
      content: [
        paragraph("intro"),
        sceneBeat("b1", "first"),
        paragraph("between"),
        sceneBeat("b2", "second"),
      ],
    };
    const result = listPlacedBeatsFromJson(doc);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      beatId: "b1",
      index: 1,
      instructions: "first",
      beatType: "free",
      povCharacterId: null,
    });
    expect(result[1]).toMatchObject({
      beatId: "b2",
      index: 2,
      instructions: "second",
    });
  });

  it("attrs.id が無い sceneBeat はスキップする", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "sceneBeat",
          attrs: {},
          content: [{ type: "text", text: "no id" }],
        },
        sceneBeat("b1", "with id"),
      ],
    };
    const result = listPlacedBeatsFromJson(doc);
    expect(result).toHaveLength(1);
    expect(result[0].beatId).toBe("b1");
    expect(result[0].index).toBe(1);
  });

  it("不正な beatType は free にフォールバックする", () => {
    const doc = {
      type: "doc",
      content: [sceneBeat("b1", "x", "bogus")],
    };
    expect(listPlacedBeatsFromJson(doc)[0].beatType).toBe("free");
  });

  it("povCharacterId は attrs.pov 文字列のときだけ採用する", () => {
    const doc = {
      type: "doc",
      content: [
        sceneBeat("b1", "x", "free", "char-1"),
        sceneBeat("b2", "y", "free", null),
      ],
    };
    const result = listPlacedBeatsFromJson(doc);
    expect(result[0].povCharacterId).toBe("char-1");
    expect(result[1].povCharacterId).toBeNull();
  });

  it("beatPos は doc 順で単調増加する（順序付け用途）", () => {
    const doc = {
      type: "doc",
      content: [
        paragraph("intro"),
        sceneBeat("b1", "first"),
        paragraph("middle"),
        sceneBeat("b2", "second"),
      ],
    };
    const result = listPlacedBeatsFromJson(doc);
    expect(result[0].beatPos).toBeLessThan(result[1].beatPos);
  });

  it("ネストされた content (text 内に text を持たない) も textContent が抽出できる", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "sceneBeat",
          attrs: { id: "b1", beatType: "free", pov: null },
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    };
    expect(listPlacedBeatsFromJson(doc)[0].instructions).toBe("hello world");
  });
});
