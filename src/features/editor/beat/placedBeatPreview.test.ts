import { describe, it, expect } from "vitest";
import {
  extractPlacedBeatPreview,
  extractPlacedBeatPreviewFromString,
} from "./placedBeatPreview";

function paragraph(text: string) {
  return { type: "paragraph", content: text ? [{ type: "text", text }] : [] };
}

function sceneBeat(text: string) {
  return { type: "sceneBeat", content: text ? [{ type: "text", text }] : [] };
}

function doc(blocks: object[]) {
  return { type: "doc", content: blocks };
}

describe("extractPlacedBeatPreview", () => {
  it("placed beat なし → '[]'", () => {
    expect(
      extractPlacedBeatPreview(doc([paragraph("intro"), paragraph("body")])),
    ).toBe("[]");
  });

  it("sceneBeat のテキストを doc 順に取り出す", () => {
    const result = extractPlacedBeatPreview(
      doc([sceneBeat("Beat 1"), paragraph("narration"), sceneBeat("Beat 2")]),
    );
    expect(JSON.parse(result)).toEqual(["Beat 1", "Beat 2"]);
  });

  it("空 sceneBeat はスキップする", () => {
    const result = extractPlacedBeatPreview(
      doc([sceneBeat(""), sceneBeat("real")]),
    );
    expect(JSON.parse(result)).toEqual(["real"]);
  });

  it("60 文字超は切り詰める / 改行は空白に正規化される", () => {
    const long = "あ".repeat(80);
    const result = extractPlacedBeatPreview(
      doc([sceneBeat("multi\nline\ttext"), sceneBeat(long)]),
    );
    const items = JSON.parse(result);
    expect(items[0]).toBe("multi line text");
    expect(items[1]).toHaveLength(60);
  });

  it("ネストした構造の中の sceneBeat も拾う", () => {
    const result = extractPlacedBeatPreview({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [sceneBeat("nested")],
        },
      ],
    });
    expect(JSON.parse(result)).toEqual(["nested"]);
  });

  it("非オブジェクト入力は '[]' を返す", () => {
    expect(extractPlacedBeatPreview(null)).toBe("[]");
    expect(extractPlacedBeatPreview(undefined)).toBe("[]");
    expect(extractPlacedBeatPreview("string")).toBe("[]");
  });
});

describe("extractPlacedBeatPreviewFromString", () => {
  it("空文字 / '{}' は '[]'", () => {
    expect(extractPlacedBeatPreviewFromString("")).toBe("[]");
    expect(extractPlacedBeatPreviewFromString("{}")).toBe("[]");
  });

  it("壊れた JSON は '[]'", () => {
    expect(extractPlacedBeatPreviewFromString("not-json")).toBe("[]");
  });

  it("正常な PM JSON 文字列を解釈する", () => {
    const json = JSON.stringify(doc([sceneBeat("from-string")]));
    expect(JSON.parse(extractPlacedBeatPreviewFromString(json))).toEqual([
      "from-string",
    ]);
  });
});
