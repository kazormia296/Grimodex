import { describe, expect, it } from "vitest";
import {
  buildCodexCompletionIndex,
  type CodexCompletionSourceEntry,
} from "./codexCompletionIndex";
import { findCodexCompletionMatch } from "./codexCompletionMatch";

function indexFor(...names: string[]) {
  const entries: CodexCompletionSourceEntry[] = names.map((name, i) => ({
    id: `entry-${i}`,
    name,
    type: "character",
    aliases: null,
    excludedAliases: null,
  }));
  return buildCodexCompletionIndex(entries);
}

describe("Codex completion prefix matching", () => {
  it("matches a Latin prefix after a word boundary", () => {
    const result = findCodexCompletionMatch("The Set", 7, indexFor("Setsuna"));

    expect(result).toMatchObject({
      prefix: "Set",
      from: 4,
      to: 7,
      candidate: { surface: "Setsuna" },
      suffix: "suna",
    });
  });

  it("matches CJK prefixes without requiring whitespace", () => {
    const result = findCodexCompletionMatch("彼女は刹", 4, indexFor("刹那"));

    expect(result).toMatchObject({
      prefix: "刹",
      from: 3,
      to: 4,
      candidate: { surface: "刹那" },
      suffix: "那",
    });
  });

  it("allows punctuation boundaries but blocks slash and mention prefixes", () => {
    const index = indexFor("Setsuna");

    expect(findCodexCompletionMatch("「Set", 4, index)?.candidate.surface).toBe(
      "Setsuna",
    );
    expect(
      findCodexCompletionMatch("私はSet", 5, index)?.candidate.surface,
    ).toBe("Setsuna");
    expect(findCodexCompletionMatch("/Set", 4, index)).toBeNull();
    expect(findCodexCompletionMatch("@Set", 4, index)).toBeNull();
  });

  it("requires two graphemes for Latin input and handles surrogate pairs", () => {
    const index = indexFor("Setsuna", "😀王国");

    expect(findCodexCompletionMatch("S", 1, index)).toBeNull();
    expect(findCodexCompletionMatch("😀", 2, index)).toBeNull();
    expect(findCodexCompletionMatch("😀王", 3, index)?.suffix).toBe("国");
  });

  it("does not offer a candidate for an exact surface", () => {
    const index = indexFor("Setsuna");

    expect(findCodexCompletionMatch("Setsuna", 7, index)).toBeNull();
  });
});
