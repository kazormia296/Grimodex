import { beforeEach, describe, expect, it, vi } from "vitest";

const response = vi.hoisted(() => ({
  listen: vi.fn(),
  answer: vi.fn(),
  help: {
    getUiStateTool: vi.fn(),
    getAppHelpIndexTool: vi.fn(),
    getAppHelpTool: vi.fn(),
  },
  chatAgent: {
    createAskUserToolHandler: vi.fn(),
    createUiOperationLimitHandler: vi.fn(),
  },
  toolExecutors: { executeTool: vi.fn() },
}));

vi.mock("@/lib/mastraAgentTurn", () => ({
  listenMastraAgentTurnQuestion: response.listen,
  answerMastraAgentTurnQuestion: response.answer,
}));
vi.mock("@/features/chat/agent/appHelpTools", () => response.help);
vi.mock("./chatAgentToolHandlers", () => response.chatAgent);
vi.mock("@/features/chat/agent/toolExecutors", () => response.toolExecutors);
vi.mock("@/features/commands/commandContext", () => ({
  getRegisteredCommandContext: () => ({ phoneWorkspace: false }),
}));
vi.mock("@/features/chat/agent/askUser", () => ({
  dismissedAskUserResult: (toolCallId: string, dismissNote: string) => ({
    toolCallId,
    name: "ask_user",
    content: { answers: [], dismissed: true },
    summary: dismissNote,
    tokensUsed: 0,
  }),
}));

import type { MastraAgentTurnQuestionPayload } from "@/../electron/shared/mastraAgentTurnWire";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { registerMastraAgentTurnResponder } from "./mastraAgentTurnResponder";

describe("registerMastraAgentTurnResponder", () => {
  let receive!: (payload: MastraAgentTurnQuestionPayload) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    response.listen.mockImplementation(async (callback) => {
      receive = callback;
      return vi.fn();
    });
    response.answer.mockResolvedValue({ kind: "accepted", requestId: "req-1" });
    response.help.getUiStateTool.mockResolvedValue({
      name: "get_ui_state",
      content: { settingsOpen: false },
      summary: "Current UI state",
      tokensUsed: 3,
    });
    response.chatAgent.createUiOperationLimitHandler.mockReturnValue(
      () => null,
    );
  });

  it("does not start an expired tool handler", async () => {
    const unregister = await registerMastraAgentTurnResponder(
      "turn-1",
      () => {},
      {} as never,
    );

    receive({
      turnId: "turn-1",
      requestId: "req-1",
      toolCallId: "tool-1",
      toolName: "get_ui_state",
      args: {},
      deadlineAt: Date.now() - 1,
    });

    await vi.waitFor(() => expect(response.answer).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    expect(response.help.getUiStateTool).not.toHaveBeenCalled();
    expect(response.answer).toHaveBeenCalledWith({
      requestId: "req-1",
      result: expect.objectContaining({ error: expect.any(String) }),
    });
    unregister();
  });

  it("refuses a revoked turn before the layout handler can reserve a save", async () => {
    const applyPreset = vi
      .spyOn(useLayoutStore.getState(), "applyPreset")
      .mockImplementation(() => {});
    const assertTurnAuthority = vi.fn(() => {
      if (assertTurnAuthority.mock.calls.length === 3) {
        throw new Error("turn authority changed before handler");
      }
    });
    const unregister = await registerMastraAgentTurnResponder(
      "turn-1",
      assertTurnAuthority,
      {} as never,
    );

    receive({
      turnId: "turn-1",
      requestId: "req-1",
      toolCallId: "tool-1",
      toolName: "apply_layout_preset",
      args: { preset: "builtin:plan" },
      deadlineAt: Date.now() + 10_000,
    });

    await vi.waitFor(() => expect(response.answer).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    expect(applyPreset).not.toHaveBeenCalled();
    expect(response.answer).toHaveBeenCalledWith({
      requestId: "req-1",
      refusal: "authority-revoked",
    });
    expect(assertTurnAuthority).toHaveBeenCalledTimes(3);
    unregister();
    applyPreset.mockRestore();
  });

  it("does not start a handler when unregistered during UI operation setup", async () => {
    const applyPreset = vi
      .spyOn(useLayoutStore.getState(), "applyPreset")
      .mockImplementation(() => {});
    let authorityChecks = 0;
    const assertTurnAuthority = () => {
      authorityChecks++;
      if (authorityChecks === 2) queueMicrotask(() => unregister());
    };
    const unregister = await registerMastraAgentTurnResponder(
      "turn-1",
      assertTurnAuthority,
      {} as never,
    );

    receive({
      turnId: "turn-1",
      requestId: "req-1",
      toolCallId: "tool-1",
      toolName: "apply_layout_preset",
      args: { preset: "builtin:plan" },
      deadlineAt: Date.now() + 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      response.chatAgent.createUiOperationLimitHandler,
    ).not.toHaveBeenCalled();
    expect(applyPreset).not.toHaveBeenCalled();
    expect(response.answer).not.toHaveBeenCalled();
    applyPreset.mockRestore();
  });

  it("ignores a question belonging to another turn", async () => {
    const unregister = await registerMastraAgentTurnResponder(
      "turn-1",
      () => {},
      {} as never,
    );

    receive({
      turnId: "turn-2",
      requestId: "req-2",
      toolCallId: "tool-2",
      toolName: "get_ui_state",
      args: {},
      deadlineAt: Date.now() + 10_000,
    });

    expect(response.answer).not.toHaveBeenCalled();
    expect(response.help.getUiStateTool).not.toHaveBeenCalled();
    unregister();
  });

  it("runs a Main-authorized tree tool through the existing renderer writer and returns its undo id", async () => {
    const authorization = {
      capability: "cap-1",
      executionId: "execution-1",
      chatMessageId: "message-1",
      mainOwnedProvenanceId: "provenance-1",
    };
    response.toolExecutors.executeTool.mockResolvedValue({
      content: {
        createdIds: ["scene-1"],
        movedIds: [],
        renamedIds: [],
        undoId: "undo-1",
      },
      summary: "Applied tree plan",
      tokensUsed: 5,
    });
    const unregister = await registerMastraAgentTurnResponder(
      "turn-1",
      () => {},
      {} as never,
    );

    receive({
      turnId: "turn-1",
      requestId: "req-1",
      toolCallId: "call-tree",
      toolName: "apply_ai_tree_plan",
      args: { kind: "scaffold", ops: [{ op: "create" }] },
      authorization,
      deadlineAt: Date.now() + 10_000,
    });

    await vi.waitFor(() => expect(response.answer).toHaveBeenCalledOnce());
    expect(response.toolExecutors.executeTool).toHaveBeenCalledWith(
      "apply_ai_tree_plan",
      "call-tree",
      { kind: "scaffold", ops: [{ op: "create" }] },
      authorization,
    );
    expect(response.answer).toHaveBeenCalledWith({
      requestId: "req-1",
      result: {
        toolCallId: "call-tree",
        name: "apply_ai_tree_plan",
        content: {
          createdIds: ["scene-1"],
          movedIds: [],
          renamedIds: [],
          undoId: "undo-1",
        },
        summary: "Applied tree plan",
        tokensUsed: 5,
        undoId: "undo-1",
      },
    });
    unregister();
  });

  it("executes a live question and forwards the legacy result with its tool id", async () => {
    const assertTurnAuthority = vi.fn();
    const unregister = await registerMastraAgentTurnResponder(
      "turn-1",
      assertTurnAuthority,
      {} as never,
    );

    receive({
      turnId: "turn-1",
      requestId: "req-1",
      toolCallId: "tool-1",
      toolName: "get_ui_state",
      args: {},
      deadlineAt: Date.now() + 10_000,
    });

    await vi.waitFor(() => expect(response.answer).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    expect(assertTurnAuthority).toHaveBeenCalledTimes(2);
    expect(response.answer).toHaveBeenCalledWith({
      requestId: "req-1",
      result: {
        toolCallId: "tool-1",
        name: "get_ui_state",
        content: { settingsOpen: false },
        summary: "Current UI state",
        tokensUsed: 3,
      },
    });
    unregister();
  });

  it("clears an unanswered ask_user when the turn responder is unregistered", async () => {
    const resolveQuestion: {
      current: ((result: unknown) => void) | null;
    } = { current: null };
    const pendingUserQuestion: { current: unknown } = { current: null };
    const runtime = {
      register: vi.fn((resolve: (result: unknown) => void) => {
        resolveQuestion.current = resolve;
      }),
      resolve: vi.fn(),
      cancel: vi.fn((result: unknown) => resolveQuestion.current?.(result)),
    };
    const set = vi.fn((update: unknown) => {
      if (typeof update === "function") {
        pendingUserQuestion.current = (
          update as (state: { pendingUserQuestion: unknown }) => {
            pendingUserQuestion: unknown;
          }
        )({
          pendingUserQuestion: pendingUserQuestion.current,
        }).pendingUserQuestion;
      } else if (
        update !== null &&
        typeof update === "object" &&
        "pendingUserQuestion" in update
      ) {
        pendingUserQuestion.current = update.pendingUserQuestion;
      }
    });
    response.chatAgent.createAskUserToolHandler.mockImplementation(
      (context: { runtime: typeof runtime; set: typeof set }) =>
        (_name: string, toolCallId: string) =>
          new Promise((resolve) => {
            context.runtime.register(resolve);
            context.set({
              pendingUserQuestion: { toolCallId },
            });
          }),
    );
    const unregister = await registerMastraAgentTurnResponder(
      "turn-1",
      () => {},
      {
        runtime,
        set,
        getSessionId: () => "session-1",
        dismissNote: "Skipped",
      } as never,
    );

    receive({
      turnId: "turn-1",
      requestId: "req-1",
      toolCallId: "tool-1",
      toolName: "ask_user",
      args: { questions: [{ question: "Continue?", kind: "text" }] },
      deadlineAt: Date.now() + 30 * 60_000,
    });
    await vi.waitFor(
      () =>
        expect(pendingUserQuestion.current).toEqual({ toolCallId: "tool-1" }),
      { timeout: 10_000 },
    );

    unregister();
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    expect(pendingUserQuestion.current).toBeNull();
    expect(response.answer).not.toHaveBeenCalled();
  });

  it("does not cancel a different pending ask_user resolver on unregister", async () => {
    const resolveQuestion: {
      current: ((result: unknown) => void) | null;
    } = { current: null };
    const pendingUserQuestion: { current: unknown } = {
      current: { toolCallId: "tool-2" },
    };
    const runtime = {
      register: vi.fn((resolve: (result: unknown) => void) => {
        resolveQuestion.current = resolve;
      }),
      resolve: vi.fn(),
      cancel: vi.fn((result: unknown) => resolveQuestion.current?.(result)),
    };
    const set = vi.fn((update: unknown) => {
      if (typeof update === "function") {
        pendingUserQuestion.current =
          (
            update as (state: { pendingUserQuestion: unknown }) => {
              pendingUserQuestion: unknown;
            }
          )({ pendingUserQuestion: pendingUserQuestion.current })
            .pendingUserQuestion ?? pendingUserQuestion.current;
      }
    });
    response.chatAgent.createAskUserToolHandler.mockImplementation(
      (context: { runtime: typeof runtime; set: typeof set }) =>
        (_name: string, toolCallId: string) =>
          new Promise((resolve) => {
            context.runtime.register(resolve);
            context.set({ pendingUserQuestion: { toolCallId } });
          }),
    );
    const unregister = await registerMastraAgentTurnResponder(
      "turn-1",
      () => {},
      {
        runtime,
        set,
        getSessionId: () => "session-1",
        dismissNote: "Skipped",
      } as never,
    );

    receive({
      turnId: "turn-1",
      requestId: "req-1",
      toolCallId: "tool-1",
      toolName: "ask_user",
      args: { questions: [{ question: "Continue?", kind: "text" }] },
      deadlineAt: Date.now() + 30 * 60_000,
    });
    await vi.waitFor(() => expect(runtime.register).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    pendingUserQuestion.current = { toolCallId: "tool-2" };

    unregister();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(pendingUserQuestion.current).toEqual({ toolCallId: "tool-2" });
  });
});
