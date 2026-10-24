import { describe, expect, it, vi } from "vitest";
import { createChatPersistenceStoreActions } from "./chatPersistenceStoreActions";
import type { ChatState } from "./chatStoreTypes";
import type { ChatMessage } from "@/features/chat/chatTypes";

// CW (DR-DA2B-R2): a user row and the non-system rows after it leave in one
// typed `chat_messages_delete` call (all-or-nothing), for the delete and for
// the edit-and-resend. A failed edit deletion is not silent.

function message(id: string, role: ChatMessage["role"]): ChatMessage {
  return {
    id,
    sessionId: "s1",
    role,
    content: `body ${id}`,
    model: null,
    tokensIn: null,
    tokensOut: null,
    durationMs: null,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as ChatMessage;
}

function setup(deleteMessages = vi.fn(async (_ids: string[]) => {})) {
  let state = {
    activeSessionId: "s1",
    messages: [
      message("u1", "user"),
      message("a1", "assistant"),
      message("u2", "user"),
      message("sys", "system"),
      message("a2", "assistant"),
    ],
  } as unknown as ChatState;
  const runtime = {
    hasPendingCompletedTurnPersistence: () => false,
    hasPendingCompletedTurnPersistenceForMessage: () => false,
    notifyPendingCompletedTurnPersistence: vi.fn(),
    notifySaveFailure: vi.fn(),
    notifyDeleteFailure: vi.fn(),
    reportError: vi.fn(),
    reportWarning: vi.fn(),
    parseMentionedSceneIds: () => undefined,
  };
  const actions = createChatPersistenceStoreActions({
    set: (partial) => {
      state = {
        ...state,
        ...(typeof partial === "function" ? partial(state) : partial),
      };
    },
    get: () => state,
    repository: {
      addMessage: vi.fn(),
      saveMessagePrompt: vi.fn(),
      deleteMessages,
    },
    runtime,
  });
  return { actions, deleteMessages, runtime, state: () => state };
}

describe("chat message deletion through the CW writer", () => {
  it("deletes a user row and the non-system rows after it in one call", async () => {
    const { actions, deleteMessages, state } = setup();
    await actions.deleteMessage("u2");
    expect(deleteMessages.mock.calls).toEqual([[["u2", "a2"]]]);
    expect(state().messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("deletes an assistant row alone", async () => {
    const { actions, deleteMessages } = setup();
    await actions.deleteMessage("a1");
    expect(deleteMessages.mock.calls).toEqual([[["a1"]]]);
  });

  it("edit-and-resend deletes the tail in one call and reports a failure", async () => {
    const failing = vi.fn(async () => {
      throw new Error("CHAT_WRITE_REFUSED:generation-pending");
    });
    const { actions, runtime, state } = setup(failing);
    expect(actions.editUserMessage("u1")).toEqual({ content: "body u1" });
    expect(failing.mock.calls).toEqual([[["u1", "a1", "u2", "a2"]]]);
    expect(state().messages).toEqual([]);
    await vi.waitFor(() =>
      expect(runtime.notifyDeleteFailure).toHaveBeenCalledTimes(1),
    );
    expect(runtime.reportError).toHaveBeenCalledWith(
      "editUserMessage",
      expect.any(Error),
    );
  });
});
