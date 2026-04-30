import { describe, it, expect } from "vitest";
import { extractUnplacedBeatPreview } from "./unplacedBeatPreview";

type UnplacedBeatLike = { content: { text?: string }[] };

const beat = (text: string): UnplacedBeatLike => ({
  content: [{ text }],
});

describe("extractUnplacedBeatPreview", () => {
  it("0件のとき空文字を返す", () => {
    expect(extractUnplacedBeatPreview([])).toBe("");
  });

  it("1件の短いビートをそのまま返す", () => {
    expect(extractUnplacedBeatPreview([beat("Hello")])).toBe("Hello");
  });

  it("40文字を超えるテキストは切り詰める", () => {
    const long = "あ".repeat(50);
    const result = extractUnplacedBeatPreview([beat(long)]);
    expect(result).toBe("あ".repeat(40));
  });

  it("先頭3件のみ使用する", () => {
    const beats = [beat("A"), beat("B"), beat("C"), beat("D"), beat("E")];
    const result = extractUnplacedBeatPreview(beats);
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("A");
    expect(lines[1]).toBe("B");
    expect(lines[2]).toBe("C");
  });

  it("改行で連結する", () => {
    const result = extractUnplacedBeatPreview([beat("X"), beat("Y")]);
    expect(result).toBe("X\nY");
  });

  it("content が空の場合はスキップする", () => {
    const beatsWithEmpty = [{ content: [] } as UnplacedBeatLike, beat("有効")];
    const result = extractUnplacedBeatPreview(beatsWithEmpty);
    expect(result).toBe("有効");
  });

  it("text プロパティが undefined の場合はスキップする", () => {
    const beatsWithNoText = [
      { content: [{}] } as UnplacedBeatLike,
      beat("有効"),
    ];
    const result = extractUnplacedBeatPreview(beatsWithNoText);
    expect(result).toBe("有効");
  });

  it("null を渡された場合は空文字を返す", () => {
    expect(
      extractUnplacedBeatPreview(null as unknown as UnplacedBeatLike[]),
    ).toBe("");
  });
});
