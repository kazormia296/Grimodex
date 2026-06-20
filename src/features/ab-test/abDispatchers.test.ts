import { describe, it, expect, vi, beforeEach } from "vitest";

// 依存 3 種 (chat one-shot / usage 台帳 / inline ストリーム) をモックして、
// dispatcher のエラー正規化と recordAiUsage への引数 (surface / projectId) を検証する。
const h = vi.hoisted(() => ({
  sendChatMessageOnceAb: vi.fn(),
  recordAiUsage: vi.fn(),
  streamInlineAiText: vi.fn(),
}));

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageOnceAb: h.sendChatMessageOnceAb,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: h.recordAiUsage,
}));
vi.mock("@/features/editor/beat/streamInlineAiText", () => ({
  streamInlineAiText: h.streamInlineAiText,
}));

import {
  createChatAbDispatcher,
  createInlineAbDispatcher,
} from "./abDispatchers";
import type { AbConfig, AbMessage } from "./abHarness";

const MESSAGES: AbMessage[] = [
  { role: "system", content: "you are a writer" },
  { role: "user", content: "continue the scene" },
];
const CONFIG: AbConfig = { model: "model-b" };

beforeEach(() => {
  h.sendChatMessageOnceAb.mockReset();
  h.recordAiUsage.mockReset();
  h.streamInlineAiText.mockReset();
});

describe("createChatAbDispatcher", () => {
  it("returns ok:true and records usage with surface chat + projectId", async () => {
    h.sendChatMessageOnceAb.mockResolvedValue({
      text: "hello",
      inputTokens: 10,
      outputTokens: 5,
    });
    const dispatch = createChatAbDispatcher("p1");
    const res = await dispatch(MESSAGES, CONFIG);

    expect(res).toEqual({ ok: true, text: "hello" });
    expect(h.sendChatMessageOnceAb).toHaveBeenCalledWith(MESSAGES, "model-b");
    expect(h.recordAiUsage).toHaveBeenCalledTimes(1);
    expect(h.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat",
        model: "model-b",
        tokensIn: 10,
        tokensOut: 5,
        projectId: "p1",
        metadata: { abTest: true },
      }),
    );
  });

  it("normalizes a thrown error to ok:false", async () => {
    h.sendChatMessageOnceAb.mockRejectedValue(new Error("boom"));
    const dispatch = createChatAbDispatcher("p1");
    const res = await dispatch(MESSAGES, CONFIG);

    expect(res).toEqual({ ok: false, error: "boom" });
    expect(h.recordAiUsage).not.toHaveBeenCalled();
  });
});

describe("createInlineAbDispatcher", () => {
  it("forwards projectId to streamInlineAiText and maps ok:true", async () => {
    h.streamInlineAiText.mockResolvedValue({ ok: true, text: "drafted" });
    const dispatch = createInlineAbDispatcher("p1");
    const res = await dispatch(MESSAGES, CONFIG);

    expect(res).toEqual({ ok: true, text: "drafted" });
    expect(h.streamInlineAiText).toHaveBeenCalledWith(
      MESSAGES,
      expect.objectContaining({
        model: "model-b",
        usageSurface: "inline_ai",
        projectId: "p1",
      }),
    );
  });

  it("maps ok:false through verbatim", async () => {
    h.streamInlineAiText.mockResolvedValue({ ok: false, error: "nope" });
    const dispatch = createInlineAbDispatcher("p1");
    const res = await dispatch(MESSAGES, CONFIG);

    expect(res).toEqual({ ok: false, error: "nope" });
  });
});
