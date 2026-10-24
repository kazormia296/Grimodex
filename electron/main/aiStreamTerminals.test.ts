/**
 * The typed terminals Main synthesizes at stage 2 (DA-2 DR-DA2-18, D-10 (a)).
 */
import { describe, expect, it, vi } from "vitest";

import {
  createAiStreamTerminalTracker,
  MAX_TRACKED_CODEX_TURNS,
} from "./aiStreamTerminals.js";

const STOPPED = "D2A_EGRESS_DENIED: profile-activation-stopped";

describe("AI stream terminals at stage 2", () => {
  it("sends each recorded stream its existing terminal shape once, per sender", () => {
    const send = vi.fn();
    const tracker = createAiStreamTerminalTracker({ send });
    tracker.track(7, "send_chat_message_stream", {
      streamId: "chat-1",
      messages: [{ role: "user", content: "PLAINTEXT_SENTINEL" }],
    });
    tracker.track(7, "send_inline_ai_stream", { streamId: "inline-1" });
    tracker.track(8, "send_cli_chat_stream", { streamId: "cli-1" });
    tracker.track(9, "codex_app_start_turn", {
      projectId: "p",
      sessionId: "s",
      grimodexTurnId: "t",
      prompt: "PLAINTEXT_SENTINEL",
    });

    expect(tracker.terminateAll()).toBe(4);
    expect(send.mock.calls).toEqual([
      [7, "chat:stream-error", { streamId: "chat-1", message: STOPPED }],
      [7, "inline-ai:stream-error", { streamId: "inline-1", message: STOPPED }],
      [8, "cli:stream-error", { streamId: "cli-1", message: STOPPED }],
      [
        9,
        "codex-app:event",
        {
          projectId: "p",
          sessionId: "s",
          grimodexTurnId: "t",
          event: {
            type: "turn-error",
            message: STOPPED,
            code: "D2A_EGRESS_DENIED",
            retryable: false,
          },
        },
      ],
    ]);
    // No plaintext of the request is carried.
    expect(JSON.stringify(send.mock.calls)).not.toContain("PLAINTEXT_SENTINEL");
    // Once: a second stage 2 sends nothing.
    expect(tracker.terminateAll()).toBe(0);
  });

  it("forgets a stream when its invoke settles", () => {
    const send = vi.fn();
    const tracker = createAiStreamTerminalTracker({ send });
    const release = tracker.track(7, "send_chat_message_stream", {
      streamId: "chat-1",
    });
    expect(release).toBeTypeOf("function");
    release!();
    expect(tracker.terminateAll()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("records nothing for other commands or for missing / untrimmed ids", () => {
    const send = vi.fn();
    const tracker = createAiStreamTerminalTracker({ send });
    expect(tracker.track(7, "send_chat_message", { streamId: "x" })).toBeNull();
    expect(tracker.track(7, "send_chat_message_stream", {})).toBeNull();
    expect(
      tracker.track(7, "send_chat_message_stream", { streamId: " x" }),
    ).toBeNull();
    expect(
      tracker.track(7, "codex_app_start_turn", { projectId: "p" }),
    ).toBeNull();
    expect(tracker.terminateAll()).toBe(0);
  });

  it("keeps only the newest Codex turns", () => {
    const send = vi.fn();
    const tracker = createAiStreamTerminalTracker({ send });
    for (let i = 0; i < MAX_TRACKED_CODEX_TURNS + 5; i += 1) {
      tracker.track(1, "codex_app_start_turn", {
        projectId: "p",
        sessionId: "s",
        grimodexTurnId: `t-${i}`,
      });
    }
    expect(tracker.terminateAll()).toBe(MAX_TRACKED_CODEX_TURNS);
    expect(send.mock.calls[0]?.[2]).toMatchObject({ grimodexTurnId: "t-5" });
  });

  it("a failed send does not stop the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("window gone");
      })
      .mockImplementation(() => undefined);
    const tracker = createAiStreamTerminalTracker({ send });
    tracker.track(1, "send_chat_message_stream", { streamId: "a" });
    tracker.track(2, "send_chat_message_stream", { streamId: "b" });
    expect(tracker.terminateAll()).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
