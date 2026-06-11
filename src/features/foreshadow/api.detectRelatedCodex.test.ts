import { describe, expect, it, beforeEach, vi } from "vitest";
import { useCodexStore } from "@/features/codex/codexStore";
import type { CodexEntry } from "@/features/codex/api";

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: vi.fn(),
}));

import { detectRelatedCodex } from "./api";

function makeEntry(overrides: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id: "c-1",
    projectId: "proj-1",
    parentId: null,
    type: "character",
    name: "朱音",
    summary: "主人公。雨を嫌う。",
    content: "{}",
    icon: null,
    aliases: "[]",
    excludedAliases: "[]",
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  } as CodexEntry;
}

describe("detectRelatedCodex", () => {
  beforeEach(() => {
    useCodexStore.setState({ entries: [] });
  });

  it("テキストに言及されたエントリを id/name/summary で返す", async () => {
    useCodexStore.setState({
      entries: [
        makeEntry({ id: "c-akane", name: "朱音", summary: "主人公。" }),
        makeEntry({ id: "c-rin", name: "凛", summary: "幼馴染。" }),
      ],
    });

    const result = await detectRelatedCodex("朱音が雨の中を歩いた。");

    expect(result).toEqual([
      { id: "c-akane", name: "朱音", summary: "主人公。" },
    ]);
  });

  it("hidden / suppress のエントリは検出対象外", async () => {
    useCodexStore.setState({
      entries: [
        makeEntry({ id: "c-h", name: "朱音", contextMode: "hidden" }),
        makeEntry({ id: "c-s", name: "凛", contextMode: "suppress" }),
      ],
    });

    await expect(detectRelatedCodex("朱音と凛が話した。")).resolves.toEqual([]);
  });

  it("summary が空のエントリは除外する", async () => {
    useCodexStore.setState({
      entries: [makeEntry({ id: "c-1", name: "朱音", summary: "  " })],
    });

    await expect(detectRelatedCodex("朱音が現れた。")).resolves.toEqual([]);
  });

  it("空テキストは検出せず [] を返す", async () => {
    useCodexStore.setState({ entries: [makeEntry()] });
    await expect(detectRelatedCodex("   ")).resolves.toEqual([]);
  });

  it("合計 3000 字を超える summary は打ち切る (inline AI と同水準の cap)", async () => {
    useCodexStore.setState({
      entries: [
        makeEntry({ id: "c-1", name: "朱音", summary: "あ".repeat(2950) }),
        makeEntry({ id: "c-2", name: "凛", summary: "い".repeat(100) }),
      ],
    });

    const result = await detectRelatedCodex("朱音と凛が向かい合う。");

    expect(result.map((e) => e.id)).toEqual(["c-1"]);
  });
});
