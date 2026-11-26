import { describe, expect, it, vi } from "vitest";
import type { ChatContextItem } from "./types";
import { rankApprovedMentionedCodexItems } from "./approvedCodexRank";
import { readApprovedCodexEntryIds } from "./approvedCodexRankReader";

function item(
  id: string,
  sourceType: string,
  stability: ChatContextItem["stability"] = "session-stable",
): ChatContextItem {
  return {
    key: `${sourceType}:${id}`,
    kind: "codex",
    authority: "canonical",
    priority: 1,
    stability,
    trim: { mode: "atomic", minTokens: 0, maxTokens: 0 },
    provenance: { sourceType, sourceId: id },
    payload: {
      kind: "codex",
      entry: {
        id,
        type: "character",
        name: id,
        summary: "",
      },
      includePinnedExtras: false,
    },
  };
}

describe("approved Codex rank", () => {
  it("moves approved mentioned items only within their stability slots, stably", () => {
    const items = [
      item("a", "codex-mentioned"),
      item("p", "codex-pin"),
      item("b", "codex-mentioned", "turn-volatile"),
      item("c", "codex-mentioned"),
      item("q", "codex-always"),
      item("d", "codex-mentioned", "turn-volatile"),
      item("e", "codex-mentioned"),
    ];

    expect(
      rankApprovedMentionedCodexItems(items, new Set(["e", "d", "c"])).map(
        (entry) => entry.key,
      ),
    ).toEqual([
      "codex-mentioned:c",
      "codex-pin:p",
      "codex-mentioned:d",
      "codex-mentioned:e",
      "codex-always:q",
      "codex-mentioned:b",
      "codex-mentioned:a",
    ]);
  });

  it("keeps the item order when the approved set is empty", () => {
    const items = [item("a", "codex-mentioned"), item("b", "codex-mentioned")];
    expect(rankApprovedMentionedCodexItems(items, new Set())).toEqual(items);
  });

  it("does not read when disabled and fails closed for unavailable or rejected reads", async () => {
    const read = vi.fn();
    await expect(
      readApprovedCodexEntryIds(false, "/w", "p", ["a"], read),
    ).resolves.toBe(undefined);
    expect(read).not.toHaveBeenCalled();

    read.mockResolvedValueOnce({ status: "unavailable", reason: "closed" });
    await expect(
      readApprovedCodexEntryIds(true, "/w", "p", ["a"], read),
    ).resolves.toBe(undefined);
    read.mockRejectedValueOnce(new Error("IPC failed"));
    await expect(
      readApprovedCodexEntryIds(true, "/w", "p", ["a"], read),
    ).resolves.toBe(undefined);
  });

  it("passes at most 64 candidate ids and returns the available approved set", async () => {
    const read = vi.fn().mockResolvedValue({
      status: "available",
      approvedCodexEntryIds: ["id-0"],
    });
    const result = await readApprovedCodexEntryIds(
      true,
      "/w",
      "p",
      Array.from({ length: 65 }, (_, index) => `id-${index}`),
      read,
    );

    expect(read.mock.calls[0]?.[0].codexEntryIds).toHaveLength(64);
    expect(result).toEqual(new Set(["id-0"]));
  });
});
