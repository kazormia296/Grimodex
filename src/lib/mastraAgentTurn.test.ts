// MP-3b (DR-MP3-4): the renderer's wrapper of the Mastra agent turn commands.
// Nothing calls it yet (the engine branch is MP-4); it folds Main's typed
// answers into values and rethrows every other failure.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MASTRA_AGENT_TURN_CANCEL_COMMAND,
  MASTRA_AGENT_TURN_REFUSAL_REASONS,
  MASTRA_AGENT_TURN_START_COMMAND,
  type MastraAgentTurnStartRequest,
} from "@/../electron/shared/mastraAgentTurnWire";
import { MASTRA_AGENT_TURN_PROGRESS_EVENT } from "@/../electron/shared/ipcContract";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  listen: listenMock,
}));

import { IpcInvokeError } from "@/lib/tauri";
import {
  cancelMastraAgentTurn,
  listenMastraAgentTurnProgress,
  startMastraAgentTurn,
} from "./mastraAgentTurn";

const TURN_ID = "8f14e45f-ceea-467e-a5d4-1b9c6d0e2f3a";

const REQUEST: MastraAgentTurnStartRequest = {
  turnId: TURN_ID,
  chatSessionId: "session-1",
  projectId: "project-1",
  currentSceneId: "scene-1",
  chatMessageId: "message-1",
  messages: [{ role: "user", content: "SECRET-CHAT-TEXT" }],
  route: {
    provider: "anthropic",
    model: "claude-x",
    endpointId: null,
    apiVariant: null,
    expectedOllamaEndpoint: null,
    thinking: null,
    effort: null,
    reasoningEnabled: null,
    reasoningEffort: null,
    webSearch: null,
  },
  systemCacheSegments: null,
  systemVolatileTail: null,
  fullyInjectedIds: [],
  loop: {
    tokenBudget: 2000,
    maxToolCalls: 10,
    maxUserQuestions: 8,
    contextWindow: 8000,
    requestMaxOutputTokens: 4096,
    language: "ja",
    controlMessages: {
      callLimitMessage: "calls",
      tokenBudgetMessage: "tokens",
      userQuestionLimitMessage: "questions",
    },
    fallbackSystem: "system",
  },
  tools: [],
};

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("startMastraAgentTurn", () => {
  it("invokes the start command with exactly the request's keys", async () => {
    invokeMock.mockResolvedValue({
      status: "refused",
      command: "start",
      reason: "gate-closed",
    });
    await startMastraAgentTurn(REQUEST);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0] as [string, object];
    // The literal in the wrapper (which the AI path scan reads) is the wire's constant.
    expect(command).toBe(MASTRA_AGENT_TURN_START_COMMAND);
    expect(args).toEqual(REQUEST);
    expect(Object.keys(args)).toEqual(Object.keys(REQUEST));
  });

  it("folds every typed refusal into a value", async () => {
    for (const reason of MASTRA_AGENT_TURN_REFUSAL_REASONS) {
      invokeMock.mockResolvedValue({
        status: "refused",
        command: "start",
        reason,
      });
      await expect(startMastraAgentTurn(REQUEST)).resolves.toEqual({
        kind: "refused",
        reason,
      });
    }
  });

  it("returns the completed turn's execution and raw response", async () => {
    const response = {
      blocks: [{ type: "text", content: "ok" }],
      stopReason: "end_turn",
    };
    invokeMock.mockResolvedValue({
      status: "completed",
      turnId: TURN_ID,
      executionId: "exec-1",
      response,
    });
    await expect(startMastraAgentTurn(REQUEST)).resolves.toEqual({
      kind: "completed",
      turnId: TURN_ID,
      executionId: "exec-1",
      response,
      loopResult: null,
    });
  });

  it("passes loop results through and normalizes their absence to null", async () => {
    const loopResult = {
      finalText: "partial",
      toolCallRecords: [],
      stoppedReason: "aborted",
      usage: { totalTokens: 1, tokensIn: null, tokensOut: null, cost: null },
      citations: [],
      finalThinkingBlocks: [],
    } as const;
    invokeMock.mockResolvedValue({
      status: "completed",
      turnId: TURN_ID,
      executionId: "exec-1",
      response: { blocks: [], stopReason: "tool_use" },
      loopResult,
    });
    await expect(startMastraAgentTurn(REQUEST)).resolves.toMatchObject({
      kind: "completed",
      loopResult,
    });
  });

  it("returns the typed context-window terminal unchanged", async () => {
    const result = {
      status: "context-window-exceeded",
      turnId: TURN_ID,
      usage: {
        contextTokens: 6,
        toolTokens: 2,
        envelopeTokens: 1,
        safetyMarginTokens: 1,
        inputTokens: 9,
        outputReservedTokens: 2,
        reservedTotalTokens: 12,
        contextWindow: 9,
        remainingTokens: -3,
        overflowTokens: 3,
      },
      overflowTokens: 3,
    };
    invokeMock.mockResolvedValue(result);
    await expect(startMastraAgentTurn(REQUEST)).resolves.toEqual({
      kind: "context-window-exceeded",
      turnId: TURN_ID,
      usage: result.usage,
      overflowTokens: 3,
    });
  });

  it("folds a restricted profile's denial into the restricted refusal", async () => {
    invokeMock.mockRejectedValue(
      new IpcInvokeError(MASTRA_AGENT_TURN_START_COMMAND, {
        code: "UNKNOWN",
        message:
          "D2A_EGRESS_DENIED: old-external-ai: route mastra_agent_turn_start is unavailable",
        retryable: false,
        outcome: "failed",
      }),
    );
    await expect(startMastraAgentTurn(REQUEST)).resolves.toEqual({
      kind: "refused",
      reason: "restricted",
    });
  });

  it("rethrows any other failure and never turns it into a refusal", async () => {
    const failure = new Error("IPC_TIMEOUT or anything else");
    invokeMock.mockRejectedValue(failure);
    await expect(startMastraAgentTurn(REQUEST)).rejects.toBe(failure);
  });

  it("an answer that is not of the route is invalid-response", async () => {
    for (const answer of [
      null,
      "x",
      {},
      { status: "refused", command: "cancel", reason: "busy" },
      { status: "refused", command: "start", reason: "nope" },
      { status: "completed", turnId: "t", executionId: "e", response: {} },
    ]) {
      invokeMock.mockResolvedValue(answer);
      await expect(startMastraAgentTurn(REQUEST)).resolves.toEqual({
        kind: "invalid-response",
      });
    }
  });
});

describe("cancelMastraAgentTurn", () => {
  it("sends only the turn ID and maps the answers", async () => {
    invokeMock.mockResolvedValue({
      status: "ok",
      turnId: TURN_ID,
      found: true,
    });
    await expect(cancelMastraAgentTurn({ turnId: TURN_ID })).resolves.toEqual({
      kind: "ok",
      found: true,
    });
    expect(invokeMock).toHaveBeenCalledWith(MASTRA_AGENT_TURN_CANCEL_COMMAND, {
      turnId: TURN_ID,
    });
    invokeMock.mockResolvedValue({
      status: "ok",
      turnId: TURN_ID,
      found: false,
    });
    await expect(cancelMastraAgentTurn({ turnId: TURN_ID })).resolves.toEqual({
      kind: "ok",
      found: false,
    });
    invokeMock.mockResolvedValue({
      status: "refused",
      command: "cancel",
      reason: "gate-closed",
    });
    await expect(cancelMastraAgentTurn({ turnId: TURN_ID })).resolves.toEqual({
      kind: "refused",
      reason: "gate-closed",
    });
    invokeMock.mockResolvedValue({ status: "ok", turnId: "t", found: true });
    await expect(cancelMastraAgentTurn({ turnId: TURN_ID })).resolves.toEqual({
      kind: "invalid-response",
    });
  });

  it("does not forward anything else a caller put on the request object", async () => {
    invokeMock.mockResolvedValue({
      status: "ok",
      turnId: TURN_ID,
      found: false,
    });
    await cancelMastraAgentTurn({
      turnId: TURN_ID,
      executionId: "exec-1",
    } as never);
    expect(invokeMock.mock.calls[0][1]).toEqual({ turnId: TURN_ID });
  });
});

describe("nothing calls the wrapper yet (the engine branch is MP-4)", () => {
  it("no product source imports it", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const root = resolve(__dirname, "..");
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (
          /\.tsx?$/u.test(entry.name) &&
          !/\.test\.tsx?$/u.test(entry.name) &&
          !full.endsWith(join("lib", "mastraAgentTurn.ts")) &&
          /mastraAgentTurn["']/u.test(readFileSync(full, "utf8"))
        ) {
          importers.push(full.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(importers).toEqual([]);
  });
});

function progressPayload(sequence: number, turnId = TURN_ID) {
  return { turnId, sequence, event: { kind: "stopped", reason: "user-stop" } };
}

describe("listenMastraAgentTurnProgress", () => {
  function captureListener() {
    const handlers: Array<(payload: unknown) => void> = [];
    const remove = vi.fn();
    listenMock.mockImplementation(
      async (
        channel: string,
        handler: (payload: unknown) => void,
      ): Promise<() => void> => {
        expect(channel).toBe(MASTRA_AGENT_TURN_PROGRESS_EVENT);
        handlers.push(handler);
        return remove;
      },
    );
    return { handlers, remove };
  }

  it("parses payloads and ignores malformed events and other turns", async () => {
    const { handlers } = captureListener();
    const callback = vi.fn();
    await listenMastraAgentTurnProgress(TURN_ID, callback);
    expect(listenMock).toHaveBeenCalledExactlyOnceWith(
      MASTRA_AGENT_TURN_PROGRESS_EVENT,
      expect.any(Function),
    );
    handlers[0]({ ...progressPayload(1), extra: true });
    handlers[0](progressPayload(1, "5b2e3d4c-0a1b-42c3-8d4e-5f60718293a4"));
    handlers[0](progressPayload(1));
    expect(callback).toHaveBeenCalledExactlyOnceWith(progressPayload(1));
  });

  it.each([1, 3])(
    "stops applying events after a duplicate or skipped sequence (%i)",
    async (badSequence) => {
      const { handlers } = captureListener();
      const callback = vi.fn();
      await listenMastraAgentTurnProgress(TURN_ID, callback);
      handlers[0](progressPayload(1));
      handlers[0](progressPayload(badSequence));
      handlers[0](progressPayload(2));
      expect(callback).toHaveBeenCalledExactlyOnceWith(progressPayload(1));
    },
  );

  it("unlistens once and blocks callbacks from an already queued event", async () => {
    const { handlers, remove } = captureListener();
    const callback = vi.fn();
    const unlisten = await listenMastraAgentTurnProgress(TURN_ID, callback);
    handlers[0](progressPayload(1));
    unlisten();
    unlisten();
    handlers[0](progressPayload(2));
    expect(remove).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledExactlyOnceWith(progressPayload(1));
  });
});
