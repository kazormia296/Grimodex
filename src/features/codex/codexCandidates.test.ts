import { describe, it, expect } from "vitest";
import {
  candidateKey,
  knownNameSet,
  activeCandidates,
} from "./codexCandidates";
import type { CodexCandidate } from "./candidateExtractor";

function cand(surface: string, count = 2): CodexCandidate {
  return {
    surface,
    lemma: surface,
    count,
    firstSceneId: "s1",
    context: "",
  };
}

describe("candidateKey", () => {
  it("trims and lowercases (Rust normalize_name と一致)", () => {
    expect(candidateKey("  Alice ")).toBe("alice");
    expect(candidateKey("円明")).toBe("円明");
  });

  it("folds NFC and NFD to the same key (dedup holds)", () => {
    // 0x30AC = composed katakana GA; 0x30AB + 0x3099 = KA + combining dakuten.
    const nfc = String.fromCharCode(0x30ac);
    const nfd = String.fromCharCode(0x30ab, 0x3099);
    expect(nfc).not.toBe(nfd);
    expect(candidateKey(nfc)).toBe(candidateKey(nfd));
  });
});

describe("knownNameSet", () => {
  it("collects normalized name + aliases (JSON 文字列)", () => {
    const set = knownNameSet([
      { name: "田中太郎", aliases: '["太郎","タロウ"]' },
      { name: "帝都", aliases: null },
    ]);
    expect(set.has("田中太郎")).toBe(true);
    expect(set.has("太郎")).toBe(true);
    expect(set.has("タロウ")).toBe(true);
    expect(set.has("帝都")).toBe(true);
  });

  it("壊れた aliases JSON は無視 (name だけ採用)", () => {
    const set = knownNameSet([{ name: "円明", aliases: "not-json" }]);
    expect(set.has("円明")).toBe(true);
    expect(set.size).toBe(1);
  });
});

describe("activeCandidates", () => {
  it("既存エントリの name/alias に一致する候補を除外する", () => {
    const candidates = [cand("円明"), cand("帝都"), cand("太郎")];
    const entries = [
      { name: "帝都", aliases: null },
      { name: "田中", aliases: '["太郎"]' }, // alias で太郎を既知化
    ];
    const active = activeCandidates(candidates, entries);
    expect(active.map((c) => c.surface)).toEqual(["円明"]);
  });

  it("entries が空なら全候補が残る", () => {
    const candidates = [cand("円明"), cand("帝都")];
    expect(activeCandidates(candidates, []).length).toBe(2);
  });
});
