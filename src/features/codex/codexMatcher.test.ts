import { describe, it, expect } from "vitest";
import {
  createCodexMatcher,
  findMentionedEntries,
  type CodexMatchTarget,
} from "./codexMatcher";

describe("createCodexMatcher", () => {
  it("returns empty array for empty text", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    expect(matcher("")).toEqual([]);
  });

  it("returns empty array for empty entries", () => {
    const matcher = createCodexMatcher([]);
    expect(matcher("太郎は走った")).toEqual([]);
  });

  it("finds a single CJK entry in text", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("太郎は走った");
    expect(matches).toEqual([
      {
        entryId: "codex-1",
        entryName: "太郎",
        entryType: "character",
        from: 0,
        to: 2,
      },
    ]);
  });

  it("finds multiple occurrences of the same entry", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("太郎と花子が会い、太郎は笑った");
    expect(matches).toHaveLength(2);
    expect(matches[0].from).toBe(0);
    expect(matches[0].to).toBe(2);
    expect(matches[1].from).toBe(9);
    expect(matches[1].to).toBe(11);
  });

  it("finds multiple different entries", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
      { id: "codex-2", name: "花子", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("太郎と花子が会った");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ entryId: "codex-1", from: 0, to: 2 });
    expect(matches[1]).toMatchObject({ entryId: "codex-2", from: 3, to: 5 });
  });

  it("prefers longer name when names overlap", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
      { id: "codex-2", name: "山田太郎", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("山田太郎が来た");
    // Should match "山田太郎" (longer), not "太郎" inside it
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      entryId: "codex-2",
      entryName: "山田太郎",
      from: 0,
      to: 4,
    });
  });

  it("matches shorter name when longer name is not present", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
      { id: "codex-2", name: "山田太郎", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("太郎が来た");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ entryId: "codex-1", entryName: "太郎" });
  });

  it("uses word boundary for Latin names", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "Alice", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);

    // Should match standalone "Alice"
    expect(matcher("Alice went home")).toHaveLength(1);
    expect(matcher("Alice went home")[0]).toMatchObject({ from: 0, to: 5 });

    // Should NOT match "Alice" inside "Malice"
    expect(matcher("Malice is evil")).toHaveLength(0);
  });

  it("handles entry names with regex special characters", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "C.C.", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("C.C.は微笑んだ");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ entryId: "codex-1", from: 0, to: 4 });
  });

  it("is case-insensitive for Latin names", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "Alice", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("alice went home");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ entryId: "codex-1", from: 0, to: 5 });
  });

  it("handles mixed CJK and Latin in same text", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
      { id: "codex-2", name: "Alice", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("太郎とAliceが会った");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ entryId: "codex-1", entryName: "太郎" });
    expect(matches[1]).toMatchObject({
      entryId: "codex-2",
      entryName: "Alice",
    });
  });

  it("handles location and item types", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "魔法の森", type: "location" },
      { id: "codex-2", name: "炎の剣", type: "item" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("太郎は魔法の森で炎の剣を見つけた");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({
      entryId: "codex-1",
      entryType: "location",
      entryName: "魔法の森",
    });
    expect(matches[1]).toMatchObject({
      entryId: "codex-2",
      entryType: "item",
      entryName: "炎の剣",
    });
  });

  it("returns matches sorted by position", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-2", name: "花子", type: "character" },
      { id: "codex-1", name: "太郎", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("太郎と花子");
    expect(matches[0].entryId).toBe("codex-1"); // 太郎 appears first
    expect(matches[1].entryId).toBe("codex-2"); // 花子 appears second
  });
});

describe("aliases support", () => {
  it("matches an alias in addition to the entry name", () => {
    const entries: CodexMatchTarget[] = [
      {
        id: "codex-1",
        name: "エララ",
        type: "character",
        aliases: ["the apprentice", "見習い"],
      },
    ];
    const matcher = createCodexMatcher(entries);
    expect(matcher("エララが来た")).toHaveLength(1);
    expect(matcher("見習いが来た")[0]).toMatchObject({ entryId: "codex-1" });
    expect(matcher("the apprentice arrived")[0]).toMatchObject({
      entryId: "codex-1",
    });
  });

  it("reports the matched alias text in entryName field", () => {
    const entries: CodexMatchTarget[] = [
      {
        id: "codex-1",
        name: "エララ",
        type: "character",
        aliases: ["見習い"],
      },
    ];
    const matcher = createCodexMatcher(entries);
    const matches = matcher("見習いが走った");
    expect(matches[0].entryName).toBe("エララ");
    expect(matches[0].from).toBe(0);
    expect(matches[0].to).toBe(3);
  });
});

describe("excluded aliases (exclusion patterns)", () => {
  it("excludes matches covered by an exclusion pattern", () => {
    const entries: CodexMatchTarget[] = [
      {
        id: "codex-1",
        name: "青",
        type: "character",
        excludedAliases: ["青い", "青の", "青く"],
      },
    ];
    const matcher = createCodexMatcher(entries);
    // "青い" covers "青" at pos 0 → excluded
    expect(matcher("青い空を見上げた")).toHaveLength(0);
  });

  it("keeps match not covered by exclusion pattern", () => {
    const entries: CodexMatchTarget[] = [
      {
        id: "codex-1",
        name: "青",
        type: "character",
        excludedAliases: ["青い", "青の", "青く"],
      },
    ];
    const matcher = createCodexMatcher(entries);
    // "青は振り返った" — "青は" is not an exclusion pattern
    const matches = matcher("青は振り返った");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ entryId: "codex-1", from: 0, to: 1 });
  });

  it("only applies exclusions to the same entry", () => {
    const entries: CodexMatchTarget[] = [
      {
        id: "codex-1",
        name: "青",
        type: "character",
        excludedAliases: ["青い"],
      },
      { id: "codex-2", name: "空", type: "location", excludedAliases: [] },
    ];
    const matcher = createCodexMatcher(entries);
    // "青い空" — "青" excluded by "青い", but "空" is not
    const matches = matcher("青い空");
    expect(matches).toHaveLength(1);
    expect(matches[0].entryId).toBe("codex-2");
  });
});

describe("CJK boundary checking", () => {
  it("matches 2+ kanji name even when preceded by kanji (left boundary exception)", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    // "山田太郎" — 2文字以上の漢字パターンは左境界の漢字-漢字を許可する。
    // 不一致にしたい場合はExcludedAliasでユーザーが明示的に除外する。
    expect(matcher("山田太郎")).toHaveLength(1);
    // Standalone 太郎 should also match
    expect(matcher("太郎が来た")).toHaveLength(1);
  });

  it("matches katakana name followed by hiragana (valid boundary)", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "エララ", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    expect(matcher("エララが走った")).toHaveLength(1);
  });

  it("does not match katakana name followed by katakana", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "エラ", type: "character" },
    ];
    const matcher = createCodexMatcher(entries);
    // "エラーが" — エラ + ー(katakana) → invalid boundary
    expect(matcher("エラーが出た")).toHaveLength(0);
    // But standalone エラ should match
    expect(matcher("エラが来た")).toHaveLength(1);
  });
});

describe("findMentionedEntries", () => {
  it("returns unique entries mentioned in text", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
      { id: "codex-2", name: "花子", type: "character" },
      { id: "codex-3", name: "次郎", type: "character" },
    ];
    const mentioned = findMentionedEntries(
      "太郎と花子が会い、太郎は笑った",
      entries,
    );
    expect(mentioned).toHaveLength(2);
    expect(mentioned.map((e) => e.id).sort()).toEqual(["codex-1", "codex-2"]);
  });

  it("returns empty array when no entries match", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
    ];
    expect(findMentionedEntries("誰もいない", entries)).toEqual([]);
  });

  it("returns empty array for empty text", () => {
    const entries: CodexMatchTarget[] = [
      { id: "codex-1", name: "太郎", type: "character" },
    ];
    expect(findMentionedEntries("", entries)).toEqual([]);
  });
});
