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
