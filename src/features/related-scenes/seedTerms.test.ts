import { describe, it, expect } from "vitest";
import { extractProperNounSeeds, buildSparseQuery } from "./seedTerms";

describe("extractProperNounSeeds", () => {
  it("カタカナ連続を抽出する (2 文字以上)", () => {
    const body = "アリアは塔へ向かった。ア、と声が漏れる。";
    // "アリア" は拾い、単独の "ア" は 2 文字未満で除外。
    expect(extractProperNounSeeds(body)).toContain("アリア");
    expect(extractProperNounSeeds(body)).not.toContain("ア");
  });

  it("大文字始まりの Latin 連語を 1 トークンとして抽出する", () => {
    const body = "He held the Iron Crown above the city of Valdor.";
    const seeds = extractProperNounSeeds(body);
    expect(seeds).toContain("Iron Crown");
    expect(seeds).toContain("Valdor");
  });

  it("出現頻度の高い語を優先し、maxTerms で打ち切る", () => {
    const body = "アリア アリア アリア セレネ セレネ ボルド";
    expect(extractProperNounSeeds(body, 2)).toEqual(["アリア", "セレネ"]);
  });

  it("同頻度は出現順で安定化する (決定的)", () => {
    const body = "セレネ アリア"; // どちらも 1 回
    expect(extractProperNounSeeds(body)).toEqual(["セレネ", "アリア"]);
  });

  it("空本文では空配列", () => {
    expect(extractProperNounSeeds("")).toEqual([]);
    expect(extractProperNounSeeds("ひらがなと漢字だけの文。")).toEqual([]);
  });

  it("長音符を含むカタカナ語も 1 語として拾う", () => {
    expect(extractProperNounSeeds("サーシャが笑った")).toContain("サーシャ");
  });
});

describe("buildSparseQuery", () => {
  it("seed があれば tail に改行区切りで連結する", () => {
    const q = buildSparseQuery("……塔の影が伸びる", "アリアとセレネは塔へ");
    expect(q.startsWith("……塔の影が伸びる\n")).toBe(true);
    expect(q).toContain("アリア");
    expect(q).toContain("セレネ");
  });

  it("seed が無ければ tail をそのまま返す", () => {
    const tail = "ひらがなだけの末尾";
    expect(buildSparseQuery(tail, "ひらがなだけの本文")).toBe(tail);
  });
});
