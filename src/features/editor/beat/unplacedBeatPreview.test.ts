import { describe, it, expect } from "vitest";
import { extractUnplacedBeatPreview } from "./unplacedBeatPreview";

type UnplacedBeatLike = { content: { text?: string }[] };

const beat = (text: string): UnplacedBeatLike => ({
  content: [{ text }],
});

describe("extractUnplacedBeatPreview", () => {
  it("0件のとき空配列JSONを返す", () => {
    expect(extractUnplacedBeatPreview([])).toBe("[]");
  });

  it("1件の短いビートをJSON配列で返す", () => {
    expect(extractUnplacedBeatPreview([beat("Hello")])).toBe('["Hello"]');
  });

  it("40文字を超えるテキストは切り詰める", () => {
    const long = "あ".repeat(50);
    const result = JSON.parse(extractUnplacedBeatPreview([beat(long)]));
    expect(result[0]).toBe("あ".repeat(40));
  });

  it("先頭3件のみ使用する", () => {
    const beats = [beat("A"), beat("B"), beat("C"), beat("D"), beat("E")];
    const result = JSON.parse(extractUnplacedBeatPreview(beats));
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("A");
    expect(result[1]).toBe("B");
    expect(result[2]).toBe("C");
  });

  it("JSON配列として有効な文字列を返す", () => {
    const result = extractUnplacedBeatPreview([beat("X"), beat("Y")]);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toEqual(["X", "Y"]);
  });

  it("content が空の場合はスキップする", () => {
    const beatsWithEmpty = [{ content: [] } as UnplacedBeatLike, beat("有効")];
    const result = JSON.parse(extractUnplacedBeatPreview(beatsWithEmpty));
    expect(result).toEqual(["有効"]);
  });

  it("text プロパティが undefined の場合はスキップする", () => {
    const beatsWithNoText = [
      { content: [{}] } as UnplacedBeatLike,
      beat("有効"),
    ];
    const result = JSON.parse(extractUnplacedBeatPreview(beatsWithNoText));
    expect(result).toEqual(["有効"]);
  });

  it("null を渡された場合は空配列JSONを返す", () => {
    expect(
      extractUnplacedBeatPreview(null as unknown as UnplacedBeatLike[]),
    ).toBe("[]");
  });

  it("改行・タブを半角スペースに正規化する", () => {
    const multiline = beat("line1\nline2\ttab");
    const result = JSON.parse(extractUnplacedBeatPreview([multiline]));
    expect(result[0]).toBe("line1 line2 tab");
  });
});
