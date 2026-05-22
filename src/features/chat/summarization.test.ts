import { describe, it, expect } from "vitest";
import { buildHandoffMetaComment, parseHandoffMetaComment } from "./conversationHistory";
import { getMaxSummaryGeneration } from "./summarization";
import type { ChatSummary } from "./chatTypes";

describe("summarization helpers", () => {
  it("buildHandoffMetaComment embeds generation metadata", () => {
    const comment = buildHandoffMetaComment({
      generation: 2,
      sourceMsgCount: 5,
      lastMsgId: "msg-5",
      generatedAt: "2026-01-01T00:00:00Z",
    });
    expect(comment).toContain("gen=2");
    expect(comment).toContain("source_msg_count=5");
    expect(comment).toContain("last_msg_id=msg-5");
  });

  it("parseHandoffMetaComment reads embedded metadata", () => {
    const summary = `<!-- gen=3 source_msg_count=8 last_msg_id=abc generated_at=2026-01-01T00:00:00Z -->\n\n## Goals`;
    expect(parseHandoffMetaComment(summary)).toEqual({
      generation: 3,
      sourceMsgCount: 8,
      lastMsgId: "abc",
    });
  });

  it("getMaxSummaryGeneration returns highest generation", () => {
    const summaries: ChatSummary[] = [
      {
        id: "1",
        sessionId: "s",
        summary: "a",
        sourceMessageIds: ["m1"],
        generation: 1,
        sourceMsgCount: 1,
        createdAt: "",
      },
      {
        id: "2",
        sessionId: "s",
        summary: "b",
        sourceMessageIds: ["m2"],
        generation: 4,
        sourceMsgCount: 2,
        createdAt: "",
      },
    ];
    expect(getMaxSummaryGeneration(summaries)).toBe(4);
  });
});
