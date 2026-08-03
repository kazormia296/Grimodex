import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./recorder", () => ({
  recordChangeEvent: vi.fn(),
  reserveChangeEvents: vi.fn(),
}));

import { recordChangeEvent, reserveChangeEvents } from "./recorder";
import {
  recordChatMessageAdd,
  recordChatMessageDelete,
  recordChatMessagesDeleteFrom,
  reserveChatMessageAdds,
} from "./captureChat";

const rec = vi.mocked(recordChangeEvent);
const reserve = vi.mocked(reserveChangeEvents);

beforeEach(() => {
  rec.mockClear();
  reserve.mockReset();
});

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
      timestamp: Date.parse("2026-05-30T00:00:00.000Z"),
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

  it("reserves a completed turn as one ordered Chronicle group", () => {
    const reservation = {
      commit: vi.fn(),
      discard: vi.fn(),
    };
    reserve.mockReturnValue(reservation);

    expect(
      reserveChatMessageAdds([
        {
          projectId: "project-1",
          sessionId: "session-1",
          messageId: "user-1",
          role: "user",
          text: "question",
          createdAt: "2026-05-30T00:00:00.000Z",
        },
        {
          projectId: "project-1",
          sessionId: "session-1",
          messageId: "assistant-1",
          role: "assistant",
          text: "answer",
          model: "model-1",
          createdAt: "2026-05-30T00:00:00.001Z",
        },
      ]),
    ).toBe(reservation);
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith([
      {
        domain: "chat",
        opType: "chat.message.add",
        projectId: "project-1",
        entityType: "chat_message",
        entityId: "user-1",
        sceneId: null,
        timestamp: Date.parse("2026-05-30T00:00:00.000Z"),
        payload: {
          sessionId: "session-1",
          messageId: "user-1",
          role: "user",
          text: "question",
          createdAt: "2026-05-30T00:00:00.000Z",
        },
      },
      {
        domain: "chat",
        opType: "chat.message.add",
        projectId: "project-1",
        entityType: "chat_message",
        entityId: "assistant-1",
        sceneId: null,
        timestamp: Date.parse("2026-05-30T00:00:00.001Z"),
        payload: {
          sessionId: "session-1",
          messageId: "assistant-1",
          role: "assistant",
          text: "answer",
          model: "model-1",
          createdAt: "2026-05-30T00:00:00.001Z",
        },
      },
    ]);
    expect(rec).not.toHaveBeenCalled();
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
