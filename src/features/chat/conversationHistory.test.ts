import { describe, it, expect } from "vitest";
import type { ChatMessage } from "./chatTypes";
import {
  classifyMessagesForL5,
  shouldSummarize,
  selectSummarizationCandidates,
  isTier2Anchor,
  countTurns,
} from "./conversationHistory";
import { parseChatMessageMetadata } from "./chatTypes";

function msg(
  id: string,
  role: ChatMessage["role"],
  content: string,
  extra?: Partial<ChatMessage>,
): ChatMessage {
  return {
    id,
    sessionId: "s1",
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe("conversationHistory", () => {
  it("protects first user message and last 3 turn-pairs as Tier 1", () => {
    const messages = [
      msg("u1", "user", "first goal"),
      msg("a1", "assistant", "ok"),
      msg("u2", "user", "second"),
      msg("a2", "assistant", "reply2"),
      msg("u3", "user", "third"),
      msg("a3", "assistant", "reply3"),
      msg("u4", "user", "fourth"),
      msg("a4", "assistant", "reply4"),
    ];
    const { tier1, tier3 } = classifyMessagesForL5(messages, 8000);
    expect(tier1.map((m) => m.id)).toContain("u1");
    expect(tier1.map((m) => m.id)).toContain("u4");
    expect(tier1.map((m) => m.id)).toContain("a4");
    expect(tier3.map((m) => m.id)).not.toContain("u1");
  });

  it("treats insertedToEditor as Tier 2 anchor", () => {
    const messages = [
      msg("u1", "user", "hi"),
      msg("a1", "assistant", "draft", {
        metadata: JSON.stringify({ insertedToEditor: true }),
      }),
    ];
    const meta = parseChatMessageMetadata(messages[1].metadata);
    expect(isTier2Anchor(messages[1], meta)).toBe(true);
    const { tier3 } = classifyMessagesForL5(messages, 8000);
    expect(tier3.map((m) => m.id)).not.toContain("a1");
  });

  it("selectSummarizationCandidates returns only Tier 3 assistant messages", () => {
    const messages = [
      msg("u1", "user", "start"),
      msg("a1", "assistant", "old filler"),
      msg("u2", "user", "m2"),
      msg("a2", "assistant", "r2"),
      msg("u3", "user", "m3"),
      msg("a3", "assistant", "r3"),
      msg("u4", "user", "m4"),
      msg("a4", "assistant", "r4"),
      msg("u5", "user", "recent"),
      msg("a5", "assistant", "recent reply"),
    ];
    const candidates = selectSummarizationCandidates(messages, 8000);
    expect(candidates.every((m) => m.role === "assistant")).toBe(true);
    expect(candidates.map((m) => m.id)).toContain("a1");
    expect(candidates.map((m) => m.id)).not.toContain("a5");
  });

  it("shouldSummarize triggers preventive path at >4 turns and >80% budget", () => {
    const long = "x".repeat(4000);
    const messages = [
      msg("u1", "user", long),
      msg("a1", "assistant", long),
      msg("u2", "user", long),
      msg("a2", "assistant", long),
      msg("u3", "user", long),
      msg("a3", "assistant", long),
      msg("u4", "user", long),
      msg("a4", "assistant", long),
      msg("u5", "user", long),
      msg("a5", "assistant", long),
    ];
    expect(countTurns(messages)).toBe(5);
    const l5Budget = 1000;
    const l5Used = 900;
    expect(shouldSummarize(messages, l5Budget, l5Used)).toBe(true);
  });

  it("does not use isStarred for protection", () => {
    const messages = [
      msg("u1", "user", "hi"),
      msg("a1", "assistant", "starred old", { isStarred: 1 }),
      msg("u2", "user", "m2"),
      msg("a2", "assistant", "r2"),
      msg("u3", "user", "m3"),
      msg("a3", "assistant", "r3"),
      msg("u4", "user", "m4"),
      msg("a4", "assistant", "r4"),
    ];
    const candidates = selectSummarizationCandidates(messages, 8000);
    expect(candidates.map((m) => m.id)).toContain("a1");
  });
});
