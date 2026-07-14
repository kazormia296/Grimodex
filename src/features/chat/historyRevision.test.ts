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

  it("omits system messages from the imported bootstrap", () => {
    expect(
      buildCodexBootstrapHistory([
        message({ role: "system", content: "volatile prompt" }),
        message({ role: "user", content: "質問" }),
        message({ id: "m2", role: "assistant", content: "回答" }),
      ]),
    ).toBe("[user]\n質問\n\n[assistant]\n回答");
  });
});
