import { describe, it, expect } from "vitest";
import {
  normalizeReading,
  hasKanji,
  isHiraganaReading,
  deriveReading,
  needsAiReading,
  surfacesForEntry,
  parseReadings,
  serializeReadings,
  reconcileReadingKeys,
  type ReadingMap,
} from "./reading";

describe("normalizeReading", () => {
  const cases: [string, string][] = [
    ["カタカナ", "かたかな"], // 全角カタカナ→ひらがな
    ["サクラ", "さくら"],
    ["ｶﾀｶﾅ", "かたかな"], // 半角カナ→NFKC→ひらがな
    ["ｶﾞ", "が"], // 半角＋濁点合成→NFKC→が
    ["ラーメン", "らーめん"], // 長音符ーは温存
    ["ヴァイオリン", "ゔぁいおりん"], // ヴ(0x30f4)は範囲内→ゔ
    ["  せつな  ", "せつな"], // trim
    ["ＡＢＣ", "ABC"], // 全角英字→NFKC→半角
    ["ひらがな", "ひらがな"], // ひらがなは不変
    ["アイス・クリーム", "あいす・くりーむ"], // 中黒・は温存
  ];
  it.each(cases)("normalizeReading(%j) === %j", (input, expected) => {
    expect(normalizeReading(input)).toBe(expected);
  });
});

describe("hasKanji", () => {
  it.each([
    ["刹那", true],
    ["見習い", true], // 漢字かな混在
    ["さくら", false],
    ["サクラ", false],
    ["ABC", false],
    ["", false],
  ] as [string, boolean][])("hasKanji(%j) === %j", (input, expected) => {
    expect(hasKanji(input)).toBe(expected);
  });
});

describe("deriveReading", () => {
  it.each([
    ["さくら", "さくら"], // ひらがなのみ→そのまま
    ["サクラ", "さくら"], // カタカナのみ→ひらがな
    ["ﾗｰﾒﾝ", "らーめん"], // 半角カナのみ→ひらがな
    ["Alice", "Alice"], // ASCIIのみ→そのまま
    ["Mr. X", "Mr. X"], // ASCII(空白/記号含む)→そのまま
    ["刹那", null], // 漢字→導出不可
    ["見習い", null], // 漢字かな混在→導出不可
    ["ABC刹那", null], // ASCII漢字混在→導出不可
    ["ヷルキューレ", null], // 平仮名を持たないカタカナ(ヷ)残渣→AI回送
    ["ﾜﾞルド", null], // 半角ﾜﾞ→NFKC→ヷ残渣→AI回送
    ["", null], // 空→null
    ["   ", null], // 空白のみ→null
  ] as [string, string | null][])(
    "deriveReading(%j) === %j",
    (input, expected) => {
      expect(deriveReading(input)).toBe(expected);
    },
  );
});

describe("isHiraganaReading", () => {
  it.each([
    ["せつな", true],
    ["れーざー", true], // 長音符ー許可
    ["あるふぁ・べーた", true], // 中黒・許可
    ["setsuna", false], // ローマ字
    ["セツナ", false], // カタカナ
    ["刹那", false], // 漢字
    ["せつな。", false], // 句読点
    ["ヷ", false], // 平仮名化できないカタカナ
    ["やま だ", false], // 空白
    ["", false], // 空
  ] as [string, boolean][])(
    "isHiraganaReading(%j) === %j",
    (input, expected) => {
      expect(isHiraganaReading(input)).toBe(expected);
    },
  );
});

describe("needsAiReading — カタカナ残渣は AI 対象", () => {
  it("平仮名を持たないカタカナを含む表記は AI 推定対象", () => {
    expect(needsAiReading("ヷルキューレ")).toBe(true);
  });
});

describe("needsAiReading", () => {
  it.each([
    ["刹那", true],
    ["見習い", true], // 漢字を含む混在は AI 対象
    ["さくら", false],
    ["サクラ", false],
    ["ABC", false],
    ["", false],
    ["  ", false],
  ] as [string, boolean][])("needsAiReading(%j) === %j", (input, expected) => {
    expect(needsAiReading(input)).toBe(expected);
  });
});

describe("surfacesForEntry", () => {
  it("name + aliases を trim・空除去・重複排除して順序保持", () => {
    expect(surfacesForEntry("刹那", ["セツナ", " 刹那 ", "", "剣士"])).toEqual([
      "刹那",
      "セツナ",
      "剣士",
    ]);
  });
  it("name が null/空でも aliases から構築", () => {
    expect(surfacesForEntry(null, ["別名"])).toEqual(["別名"]);
    expect(surfacesForEntry("", [])).toEqual([]);
  });
});

describe("parseReadings", () => {
  it("正常な JSON をパース", () => {
    expect(parseReadings('{"刹那":["せつな","せちな"]}')).toEqual({
      刹那: ["せつな", "せちな"],
    });
  });
  it("null/空/破損 JSON は空マップ", () => {
    expect(parseReadings(null)).toEqual({});
    expect(parseReadings(undefined)).toEqual({});
    expect(parseReadings("")).toEqual({});
    expect(parseReadings("{ broken")).toEqual({});
  });
  it("配列やプリミティブは空マップ", () => {
    expect(parseReadings("[1,2]")).toEqual({});
    expect(parseReadings('"str"')).toEqual({});
  });
  it("非配列値・非文字列/空読みを弾く", () => {
    expect(
      parseReadings('{"a":["よみ",1,"",null,"  "],"b":"nope","c":[]}'),
    ).toEqual({ a: ["よみ"] });
  });
});

describe("serializeReadings", () => {
  it("trim・重複排除・空読み剪定して JSON 化", () => {
    expect(
      serializeReadings({
        刹那: [" せつな ", "せつな", "せちな", ""],
        empty: [],
        "  ": ["x"],
      }),
    ).toBe(JSON.stringify({ 刹那: ["せつな", "せちな"] }));
  });
  it("round-trip で安定", () => {
    const map = { 刹那: ["せつな"], 剣士: ["けんし"] };
    expect(parseReadings(serializeReadings(map))).toEqual(map);
  });
  it("__proto__ 表記でも prototype を汚さず own プロパティとして往復する", () => {
    // 計算プロパティキーで __proto__ を **own** プロパティとして持たせる
    // (非計算の { __proto__: ... } は prototype を差し替えてしまう)。
    const input: ReadingMap = { ["__proto__"]: ["わるい"] };
    const json = serializeReadings(input);
    const parsed = parseReadings(json);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(parsed["__proto__"]).toEqual(["わるい"]);
    // 通常オブジェクトの prototype が汚染されていない。
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("reconcileReadingKeys", () => {
  it("存続する表記の読みを持ち越す", () => {
    const r = { 刹那: ["せつな"], 剣士: ["けんし"] };
    expect(reconcileReadingKeys(r, ["刹那", "剣士"], ["刹那", "剣士"])).toEqual(
      r,
    );
  });
  it("消えた別名の読みを剪定する", () => {
    expect(
      reconcileReadingKeys(
        { 刹那: ["せつな"], 剣士: ["けんし"] },
        ["刹那", "剣士"],
        ["刹那"],
      ),
    ).toEqual({ 刹那: ["せつな"] });
  });
  it("単一リネームは旧キーの読みを新キーへ移送する", () => {
    expect(
      reconcileReadingKeys({ 刹那: ["せつな"] }, ["刹那"], ["刹那改"]),
    ).toEqual({ 刹那改: ["せつな"] });
  });
  it("新キーに既読みがあれば移送しない", () => {
    expect(
      reconcileReadingKeys(
        { 旧: ["ふる"], 新: ["しん"] },
        ["旧", "新"],
        ["新"],
      ),
    ).toEqual({ 新: ["しん"] });
  });
  it("多重変更は曖昧なので移送せず剪定のみ", () => {
    expect(
      reconcileReadingKeys({ A: ["a"], B: ["b"] }, ["A", "B"], ["C", "D"]),
    ).toEqual({});
  });
  it("追加された表記はキー不在のまま (空 seed しない)", () => {
    expect(
      reconcileReadingKeys({ 刹那: ["せつな"] }, ["刹那"], ["刹那", "剣士"]),
    ).toEqual({ 刹那: ["せつな"] });
  });
});
