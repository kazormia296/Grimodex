import { describe, expect, it } from "vitest";
import {
  buildCodexCompletionIndex,
  getSharedCodexCompletionIndex,
  type CodexCompletionSourceEntry,
} from "./codexCompletionIndex";

function entry(
  overrides: Partial<CodexCompletionSourceEntry> = {},
): CodexCompletionSourceEntry {
  return {
    id: "entry-1",
    name: "Setsuna",
    type: "character",
    aliases: null,
    excludedAliases: null,
    ...overrides,
  };
}

describe("Codex completion index", () => {
  it("indexes names and JSON aliases without reading unrelated fields", () => {
    const index = buildCodexCompletionIndex([
      entry({ aliases: JSON.stringify(["Captain Setsuna", "刹那"]) }),
    ]);

    expect(index.all()).toEqual([
      expect.objectContaining({
        entryId: "entry-1",
        surface: "Captain Setsuna",
        source: "alias",
      }),
      expect.objectContaining({
        entryId: "entry-1",
        surface: "Setsuna",
        source: "name",
      }),
      expect.objectContaining({
        entryId: "entry-1",
        surface: "刹那",
        source: "alias",
      }),
    ]);
  });

  it("drops invalid, empty, excluded, and duplicate surfaces", () => {
    const index = buildCodexCompletionIndex([
      entry({
        aliases: JSON.stringify(["Setsuna", "", "刹那"]),
        excludedAliases: JSON.stringify(["刹那"]),
      }),
      entry({ id: "entry-2", name: "Other", aliases: "not-json" }),
    ]);

    expect(index.all().map((candidate) => candidate.surface)).toEqual([
      "Other",
      "Setsuna",
    ]);
    expect(
      index.all().filter((candidate) => candidate.surface === "Setsuna"),
    ).toHaveLength(1);
  });

  it("uses canonical names before aliases and exact casing before case-insensitive matches", () => {
    const index = buildCodexCompletionIndex([
      entry({ aliases: JSON.stringify(["setting sun", "Setuko"]) }),
      entry({ id: "entry-2", name: "Setting", aliases: null }),
    ]);

    expect(index.find("set").map((candidate) => candidate.surface)).toEqual([
      "setting sun",
      "Setsuna",
      "Setting",
      "Setuko",
    ]);
    expect(index.find("Set")[0]?.surface).toBe("Setsuna");
    expect(index.findFirst("Set")).toEqual(index.find("Set")[0]);
    expect(index.findFirst("set")).toEqual(index.find("set")[0]);
    expect(index.findFirst("missing")).toBeNull();
  });

  it("does not return a candidate when the surface is already complete", () => {
    const index = buildCodexCompletionIndex([entry()]);

    expect(index.find("setsuna")).toEqual([]);
    expect(index.find("Setsuna")).toEqual([]);
  });

  it("reuses one immutable index for all editors observing the same targets", () => {
    const targets = [entry()];

    const first = getSharedCodexCompletionIndex(targets);
    const second = getSharedCodexCompletionIndex(targets);
    const refreshed = getSharedCodexCompletionIndex([...targets]);

    expect(second).toBe(first);
    expect(refreshed).not.toBe(first);
  });
});
