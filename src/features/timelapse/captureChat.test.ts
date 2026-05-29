import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./recorder", () => ({ recordChangeEvent: vi.fn() }));

import { recordChangeEvent } from "./recorder";
import {
  recordChatMessageAdd,
  recordChatMessageDelete,
  recordChatMessagesDeleteFrom,
} from "./captureChat";

const rec = vi.mocked(recordChangeEvent);

beforeEach(() => rec.mockClear());

describe("captureChat", () => {
  it("records chat.message.add with role/text/sessionId baked inline, sceneId null", () => {
    recordChatMessageAdd({
      sessionId: "sess-1",
      messageId: "msg-1",
      role: "assistant",
      text: "本文だよ",
      model: "claude-opus-4-8",
      createdAt: "2026-05-30T00:00:00.000Z",
    });
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rec).toHaveBeenCalledWith({
      domain: "chat",
      opType: "chat.message.add",
      entityType: "chat_message",
      entityId: "msg-1",
      sceneId: null,
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        role: "assistant",
        text: "本文だよ",
        model: "claude-opus-4-8",
        createdAt: "2026-05-30T00:00:00.000Z",
      },
    });
  });

  it("omits model from add payload when absent", () => {
    recordChatMessageAdd({
      sessionId: "s",
      messageId: "m",
      role: "user",
      text: "hi",
      createdAt: "2026-05-30T00:00:00.000Z",
    });
    const payload = rec.mock.calls[0][0].payload as Record<string, unknown>;
    expect("model" in payload).toBe(false);
    expect(payload.role).toBe("user");
  });

  it("records chat.message.delete with sessionId when provided", () => {
    recordChatMessageDelete({ messageId: "m", sessionId: "s" });
    expect(rec).toHaveBeenCalledWith({
      domain: "chat",
      opType: "chat.message.delete",
      entityType: "chat_message",
      entityId: "m",
      sceneId: null,
      payload: { sessionId: "s", messageId: "m" },
    });
  });

  it("records chat.message.delete with only messageId when sessionId is unknown", () => {
    recordChatMessageDelete({ messageId: "m" });
    const payload = rec.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload).toEqual({ messageId: "m" });
  });

  it("records chat.message.deleteFrom scoped to the session", () => {
    recordChatMessagesDeleteFrom({
      sessionId: "s",
      fromCreatedAt: "2026-05-30T00:00:00.000Z",
    });
    expect(rec).toHaveBeenCalledWith({
      domain: "chat",
      opType: "chat.message.deleteFrom",
      entityType: "chat_session",
      entityId: "s",
      sceneId: null,
      payload: {
        sessionId: "s",
        fromCreatedAt: "2026-05-30T00:00:00.000Z",
      },
    });
  });

  it("never sets a non-null sceneId (FK to treeNodes would break flush)", () => {
    recordChatMessageAdd({
      sessionId: "s",
      messageId: "m",
      role: "user",
      text: "x",
      createdAt: "2026-05-30T00:00:00.000Z",
    });
    recordChatMessageDelete({ messageId: "m" });
    recordChatMessagesDeleteFrom({ sessionId: "s", fromCreatedAt: "z" });
    for (const call of rec.mock.calls) {
      expect(call[0].sceneId).toBeNull();
    }
  });
});
