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

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
}));

import { IpcInvokeError } from "@/lib/tauri";
import { cancelMastraAgentTurn, startMastraAgentTurn } from "./mastraAgentTurn";

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
