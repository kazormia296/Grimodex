import { describe, expect, it } from "vitest";
import type { CodexAppItem } from "@/features/chat/codexAppApi";
import {
  agentContinuationReason,
  streamAssistantMetadata,
} from "./chatStoreSupport";

describe("streamAssistantMetadata", () => {
  it("returns undefined when there is nothing to record", () => {
    expect(
      streamAssistantMetadata({
        stopReason: "end_turn",
        thinking: "",
        codex: null,
      }),
    ).toBeUndefined();
  });

  it.each([
    ["max_tokens", true],
    ["length", true],
    ["end_turn", false],
  ])("marks output truncation for stopReason=%s", (stopReason, truncated) => {
    const metadata = JSON.parse(
      streamAssistantMetadata({ stopReason, thinking: "t", codex: null })!,
    );
    expect(metadata.thinking_blocks).toEqual([{ thinking: "t" }]);
    if (truncated) expect(metadata.output_truncated).toBe(true);
    else expect(metadata).not.toHaveProperty("output_truncated");
  });

  it("marks a stopped stream without the codex fields", () => {
    const metadata = JSON.parse(
      streamAssistantMetadata({
        stopReason: "stopped",
        thinking: "",
        codex: null,
      })!,
    );
    expect(metadata).toEqual({ stopped: true });
  });

  it("records codex app-server items without their raw payload", () => {
    const item: CodexAppItem = {
      id: "item-1",
      type: "command",
      status: "completed",
      command: ["ls"],
      raw: { secret: "raw" },
    };
    const metadata = JSON.parse(
      streamAssistantMetadata({
        stopReason: "end_turn",
        thinking: "",
        codex: {
          threadId: "thread-1",
          turnId: "turn-1",
          items: new Map([[item.id, item]]),
          warnings: ["warn"],
        },
      })!,
    );
    expect(metadata).toEqual({
      runtime: "codex-app-server",
      usage_source: "app-server",
      stop_reason: "end_turn",
      codex_thread_id: "thread-1",
      codex_turn_id: "turn-1",
      codex_item_ids: ["item-1"],
      codex_items: [
        { id: "item-1", type: "command", status: "completed", command: ["ls"] },
      ],
      codex_warnings: ["warn"],
    });
    expect(item.raw).toEqual({ secret: "raw" });
  });

  it("omits empty codex ids, items and warnings", () => {
    const metadata = JSON.parse(
      streamAssistantMetadata({
        stopReason: "end_turn",
        thinking: "",
        codex: {
          threadId: undefined,
          turnId: undefined,
          items: new Map(),
          warnings: [],
        },
      })!,
    );
    expect(metadata).toEqual({
      runtime: "codex-app-server",
      usage_source: "app-server",
      stop_reason: "end_turn",
    });
  });
});

describe("agentContinuationReason", () => {
  it("offers an output continuation only when the turn can continue", () => {
    const result = { outputTruncated: true, stoppedReason: "completed" };
    expect(agentContinuationReason(result, true)).toBe("output");
    expect(agentContinuationReason(result, false)).toBeNull();
  });

  it.each([
    ["limit_calls", "limit"],
    ["limit_tokens", "limit"],
    ["limit_questions", null],
    ["completed", null],
    ["aborted", null],
  ])("maps stoppedReason=%s to %s", (stoppedReason, expected) => {
    expect(
      agentContinuationReason({ outputTruncated: false, stoppedReason }, true),
    ).toBe(expected);
  });
});
