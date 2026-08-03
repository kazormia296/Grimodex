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
const DISPATCH_CONTEXT = {
  operationId: "operation-test",
  projectId: "p1",
  expectedWorkspacePath: "/workspace/original",
  slotIndex: 0,
  configFingerprint: "direct-dispatch",
} as const;

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
    const res = await dispatch(MESSAGES, CONFIG, DISPATCH_CONTEXT);

    expect(res).toEqual({ ok: true, text: "hello" });
    // provider 未指定 (基準枠相当) → provider/apiVariant/endpointId は undefined。
    expect(h.sendChatMessageOnceAb).toHaveBeenCalledWith(
      MESSAGES,
      expect.objectContaining({
        projectId: "p1",
        expectedWorkspacePath: "/workspace/original",
        pathId: "ab_chat",
        operationId: expect.any(String),
        metadata: {
          slotIndex: 0,
          configFingerprint: "direct-dispatch",
        },
      }),
      "model-b",
      undefined,
      undefined,
      undefined,
    );
    expect(h.recordAiUsage).toHaveBeenCalledTimes(1);
    expect(h.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat",
        model: "model-b",
        tokensIn: 10,
        tokensOut: 5,
        projectId: "p1",
        metadata: { abTest: true, provider: null },
      }),
    );
  });

  it("forwards a provider override and resolves sakana → responses variant", async () => {
    h.sendChatMessageOnceAb.mockResolvedValue({
      text: "hi",
      inputTokens: 1,
      outputTokens: 1,
    });
    const dispatch = createChatAbDispatcher("p1");
    await dispatch(
      MESSAGES,
      { provider: "sakana", model: "fugu" },
      DISPATCH_CONTEXT,
    );

    expect(h.sendChatMessageOnceAb).toHaveBeenCalledWith(
      MESSAGES,
      expect.objectContaining({ projectId: "p1", pathId: "ab_chat" }),
      "fugu",
      "sakana",
      "responses",
      undefined,
    );
    expect(h.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { abTest: true, provider: "sakana" },
      }),
    );
  });

  it("non-sakana provider override leaves variant to backend (undefined)", async () => {
    h.sendChatMessageOnceAb.mockResolvedValue({ text: "hi" });
    const dispatch = createChatAbDispatcher("p1");
    await dispatch(
      MESSAGES,
      { provider: "openrouter", model: "x/y" },
      DISPATCH_CONTEXT,
    );

    expect(h.sendChatMessageOnceAb).toHaveBeenCalledWith(
      MESSAGES,
      expect.objectContaining({ projectId: "p1", pathId: "ab_chat" }),
      "x/y",
      "openrouter",
      undefined,
      undefined,
    );
  });

  it("forwards endpointId for an openai-compatible slot", async () => {
    h.sendChatMessageOnceAb.mockResolvedValue({ text: "hi" });
    const dispatch = createChatAbDispatcher("p1");
    await dispatch(
      MESSAGES,
      {
        provider: "openai-compatible",
        model: "local-model",
        endpointId: "ep-2",
      },
      DISPATCH_CONTEXT,
    );

    expect(h.sendChatMessageOnceAb).toHaveBeenCalledWith(
      MESSAGES,
      expect.objectContaining({ projectId: "p1", pathId: "ab_chat" }),
      "local-model",
      "openai-compatible",
      undefined,
      "ep-2",
    );
  });

  it("drops endpointId when the slot provider is not openai-compatible", async () => {
    h.sendChatMessageOnceAb.mockResolvedValue({ text: "hi" });
    const dispatch = createChatAbDispatcher("p1");
    // endpointId on a non-compat provider must never leak to the backend.
    await dispatch(
      MESSAGES,
      {
        provider: "openrouter",
        model: "x/y",
        endpointId: "ep-2",
      },
      DISPATCH_CONTEXT,
    );

    expect(h.sendChatMessageOnceAb).toHaveBeenCalledWith(
      MESSAGES,
      expect.objectContaining({ projectId: "p1", pathId: "ab_chat" }),
      "x/y",
      "openrouter",
      undefined,
      undefined,
    );
  });

  it("normalizes a thrown error to ok:false", async () => {
    h.sendChatMessageOnceAb.mockRejectedValue(new Error("boom"));
    const dispatch = createChatAbDispatcher("p1");
    const res = await dispatch(MESSAGES, CONFIG, DISPATCH_CONTEXT);

    expect(res).toEqual({ ok: false, error: "boom" });
    expect(h.recordAiUsage).not.toHaveBeenCalled();
  });

  it("fails closed before chat provider dispatch when factory and run project authorities differ", async () => {
    const dispatch = createChatAbDispatcher("factory-project");
    const res = await dispatch(MESSAGES, CONFIG, {
      ...DISPATCH_CONTEXT,
      projectId: "run-project",
    });

    expect(res).toEqual({
      ok: false,
      error:
        "AI_AUDIT_PROJECT_CHANGED: expected factory-project, active run-project",
    });
    expect(h.sendChatMessageOnceAb).not.toHaveBeenCalled();
  });
});

describe("createInlineAbDispatcher", () => {
  it("forwards projectId to streamInlineAiText and maps ok:true", async () => {
    h.streamInlineAiText.mockResolvedValue({ ok: true, text: "drafted" });
    const dispatch = createInlineAbDispatcher("p1");
    const res = await dispatch(MESSAGES, CONFIG, DISPATCH_CONTEXT);

    expect(res).toEqual({ ok: true, text: "drafted" });
    expect(h.streamInlineAiText).toHaveBeenCalledWith(
      MESSAGES,
      expect.objectContaining({
        model: "model-b",
        usageSurface: "inline_ai",
        projectId: "p1",
        auditExpectedWorkspacePath: "/workspace/original",
      }),
    );
  });

  it("maps ok:false through verbatim", async () => {
    h.streamInlineAiText.mockResolvedValue({ ok: false, error: "nope" });
    const dispatch = createInlineAbDispatcher("p1");
    const res = await dispatch(MESSAGES, CONFIG, DISPATCH_CONTEXT);

    expect(res).toEqual({ ok: false, error: "nope" });
  });

  it("fails closed before inline provider dispatch when factory and run project authorities differ", async () => {
    const dispatch = createInlineAbDispatcher("factory-project");
    await expect(
      dispatch(MESSAGES, CONFIG, {
        ...DISPATCH_CONTEXT,
        projectId: "run-project",
      }),
    ).rejects.toThrow(
      "AI_AUDIT_PROJECT_CHANGED: expected factory-project, active run-project",
    );
    expect(h.streamInlineAiText).not.toHaveBeenCalled();
  });
});
