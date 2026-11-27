import { describe, expect, it, vi } from "vitest";
import type { ChatContextItem } from "./types";
import {
  rankAndMaterializeApprovedMentionedCodexItems,
  rankApprovedMentionedCodexItems,
} from "./approvedCodexRank";
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
  it("moves approved mentioned items only within cache-position ranges", () => {
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
      "codex-mentioned:a",
      "codex-pin:p",
      "codex-mentioned:c",
      "codex-mentioned:d",
      "codex-always:q",
      "codex-mentioned:e",
      "codex-mentioned:b",
    ]);
  });

  it("keeps the item order when the approved set is empty", () => {
    const items = [item("a", "codex-mentioned"), item("b", "codex-mentioned")];
    expect(rankApprovedMentionedCodexItems(items, new Set())).toEqual(items);
  });

  it("reuses materialized output unless ranking fits within the exact budget", () => {
    const items = [item("a", "codex-mentioned"), item("b", "codex-mentioned")];
    const materialized = { systemTokens: 100 };
    const materialize = vi.fn(() => ({ systemTokens: 101 }));

    const unchanged = rankAndMaterializeApprovedMentionedCodexItems(
      items,
      undefined,
      materialized,
      materialize,
      100,
    );
    expect(unchanged).toEqual({ items, materialized });
    expect(materialize).not.toHaveBeenCalled();

    const rejected = rankAndMaterializeApprovedMentionedCodexItems(
      items,
      new Set(["b"]),
      materialized,
      materialize,
      100,
    );
    expect(rejected).toEqual({ items, materialized });
    expect(materialize).toHaveBeenCalledOnce();
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
