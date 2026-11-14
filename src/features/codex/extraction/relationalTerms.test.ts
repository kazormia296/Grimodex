import { describe, expect, it } from "vitest";
import {
  isRelationalTerm,
  relationalTermKind,
  type RelationalTermKind,
} from "./relationalTerms";

describe("relationalTermKind", () => {
  it.each<[string, RelationalTermKind]>([
    ["姉", "kinship"],
    ["姉ちゃん", "kinship"],
    ["お姉さん", "kinship"],
    ["お兄ちゃん", "kinship"],
    ["おじさん", "kinship"],
    ["おじいさん", "kinship"],
    ["じいちゃん", "kinship"],
    ["お父様", "kinship"],
    ["母上", "kinship"],
    ["ダンナ", "kinship"],
    ["パパ", "kinship"],
    ["ママさん", "kinship"],
    ["兄貴", "kinship"],
    ["あなた", "second-person"],
    ["おまえ", "second-person"],
    ["お前", "second-person"],
    ["貴方", "second-person"],
    ["あなたたち", "second-person"],
    ["彼", "third-person"],
    ["彼女", "third-person"],
    ["彼ら", "third-person"],
    ["あいつ", "third-person"],
    ["あの人", "third-person"],
  ])("treats %s as a %s term", (surface, kind) => {
    expect(relationalTermKind(surface)).toBe(kind);
    expect(isRelationalTerm(surface)).toBe(true);
  });

  it("does not match a proper name that merely contains a stem (full-stem match only)", () => {
    for (const surface of [
      "姉小路",
      "兄弟",
      "母国",
      "父島",
      "彼岸",
      "夫婦",
      "ライカ",
      "ライカさん",
      "ライカ姉さん",
      "きみちゃん",
      "あなたちゃん",
    ]) {
      expect(isRelationalTerm(surface), surface).toBe(false);
    }
  });

  it("keeps occupational titles and first-person pronouns out of the list", () => {
    for (const surface of [
      "先生",
      "隊長",
      "団長",
      "私",
      "僕",
      "俺",
      "先生さん",
    ]) {
      expect(isRelationalTerm(surface), surface).toBe(false);
    }
  });

  it("normalizes NFC/NFD but does not fold width or kana variants", () => {
    expect(isRelationalTerm("ダンナ".normalize("NFD"))).toBe(true);
    // 全角・半角・かなの揺れは吸収しない（一覧が各形を持つ）。半角カナは当たらない。
    expect(isRelationalTerm("ﾀﾞﾝﾅ")).toBe(false);
  });

  it("ignores empty and whitespace-only surfaces", () => {
    expect(isRelationalTerm("")).toBe(false);
    expect(isRelationalTerm("  ")).toBe(false);
  });
});
