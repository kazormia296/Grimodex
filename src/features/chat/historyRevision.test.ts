import { describe, expect, it } from "vitest";
import {
  buildCodexBootstrapHistory,
  computeChatHistoryRevision,
} from "./historyRevision";
import type { ChatMessage } from "./chatTypes";

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: "m1",
  sessionId: "s1",
  role: "user",
  content: "こんにちは",
  createdAt: "2026-07-14T00:00:00.000Z",
  ...overrides,
});

describe("historyRevision", () => {
  it("is stable and changes when conversation content changes", async () => {
    const first = await computeChatHistoryRevision([message({})]);
    const same = await computeChatHistoryRevision([message({})]);
    const changed = await computeChatHistoryRevision([
      message({ content: "別の内容" }),
    ]);

    expect(first).toBe(same);
    expect(first).not.toBe(changed);
    expect(first).toMatch(/^(?:[0-9a-f]{64}|fnv1a-[0-9a-f]{8})$/);
  });

  it("ignores storage-only fields when computing the revision", async () => {
    const first = await computeChatHistoryRevision([
      message({
        id: "m1",
        model: "model-a",
        metadata: "first",
      }),
    ]);
    const sameConversation = await computeChatHistoryRevision([
      message({
        id: "different-id",
        model: "model-b",
        metadata: "second",
      }),
    ]);

    expect(first).toBe(sameConversation);
  });

  it("uses the same persisted messages for the revision and bootstrap", async () => {
    const activeMessages = [
      message({ role: "user", content: "質問" }),
      message({ id: "m2", role: "assistant", content: "回答" }),
    ];
    const messagesWithExcludedHistory = [
      message({ role: "system", content: "linked session: previous-session" }),
      message({ id: "old", content: "summarized", isSummarized: 1 }),
      message({ id: "blank", content: "   " }),
      ...activeMessages,
    ];

    expect(buildCodexBootstrapHistory(messagesWithExcludedHistory)).toBe(
      "[system]\nlinked session: previous-session\n\n[user]\n質問\n\n[assistant]\n回答",
    );
    expect(
      await computeChatHistoryRevision(messagesWithExcludedHistory),
    ).not.toBe(await computeChatHistoryRevision(activeMessages));
  });

  it("strips pseudo-tool blocks from imported assistant history", async () => {
    const raw = message({
      role: "assistant",
      content: '回答\n<tool_call>{"name":"fake"}</tool_call>',
    });
    const sanitized = message({ role: "assistant", content: "回答" });

    expect(buildCodexBootstrapHistory([raw])).toBe("[assistant]\n回答");
    expect(await computeChatHistoryRevision([raw])).toBe(
      await computeChatHistoryRevision([sanitized]),
    );
  });
});
