import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MastraTurnExecutionContext } from "./chatTurnMastraEngine";
import { M4_READ_TOOL_NAMES } from "@/../electron/shared/agentReadToolDefinitions";
import { MASTRA_UI_TOOL_NAMES } from "@/../electron/shared/mastraUiToolDefinitions";
import { DEFAULT_MAX_USER_QUESTIONS } from "@/features/chat/agent/agentLoopDefaults";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { shouldAbortMastraTurn } from "./shouldAbortMastraTurn";

const mastraMocks = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  registerQuestion: vi.fn(),
  listenProgress: vi.fn(),
  flushSceneWrites: vi.fn(),
  watchAuthority: vi.fn<(observe: () => void) => () => void>(
    () => () => undefined,
  ),
}));

vi.mock("@/lib/mastraAgentTurn", () => ({
  startMastraAgentTurn: mastraMocks.start,
  cancelMastraAgentTurn: mastraMocks.cancel,
}));
vi.mock("./mastraAgentTurnResponder", () => ({
  registerMastraAgentTurnResponder: mastraMocks.registerQuestion,
  listenMastraAgentTurnProgress: mastraMocks.listenProgress,
}));
vi.mock("@/features/tree/pendingSceneWrites", () => ({
  awaitPendingSceneContentWrite: mastraMocks.flushSceneWrites,
}));
vi.mock("./mastraTurnAuthorityWatcher", () => ({
  watchMastraTurnAuthority: mastraMocks.watchAuthority,
}));
import {
  chatTurnMastraEngine,
  createMastraTurnAttempt as createMastraTurnAttemptWithDependencies,
  loadMastraTurnEngineDependencies,
} from "./chatTurnMastraEngine";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  _pendingAiAuditExecutionCountForTests,
  _resetPendingAiAuditExecutionsForTests,
} from "@/features/ai-audit/executionRegistry";

const eligibility = {
  provider: "openai",
  chatSessionId: "session-1",
  projectId: "project-1",
  tools: ["search_codex"],
  mainToolNames: ["search_codex"],
  gateClosedObserved: false,
  pendingStart: false,
  hasAttachments: false,
  toolProtocol: "openai",
  publicWebSearch: false,
};

const admission = {
  turnId: "mastra-turn",
  provider: "openai",
  chatSessionId: "session-1",
  projectId: "project-1",
  activeSceneId: "scene-1",
  tools: [],
  userMessage: {
    id: "user-1",
    sessionId: "session-1",
    role: "user" as const,
    content: "hello",
    metadata: null,
    createdAt: "",
  },
  toolProtocol: "openai",
  publicWebSearch: false,
  cancelBeforeTransport: () => false,
};

type EngineDependencies = Awaited<
  ReturnType<typeof loadMastraTurnEngineDependencies>
>;
let engineDependencies: EngineDependencies | undefined;

beforeAll(async () => {
  engineDependencies = await loadMastraTurnEngineDependencies();
});

function createMastraTurnAttempt(input: typeof admission, runtime: unknown) {
  if (!engineDependencies)
    throw new Error("Mastra engine dependencies not loaded");
  return createMastraTurnAttemptWithDependencies(
    input,
    runtime as never,
    engineDependencies,
    {
      debugLog,
      errorDetail,
      defaultMaxUserQuestions: DEFAULT_MAX_USER_QUESTIONS,
    },
  );
}

function executionContext(): MastraTurnExecutionContext {
  return {
    turnId: admission.turnId,
    chatSessionId: admission.chatSessionId,
    projectId: admission.projectId,
    currentSceneId: "scene-1",
    chatMessageId: "assistant-1",
    assistantMessage: {
      id: "assistant-1",
      sessionId: "session-1",
      role: "assistant",
      content: "",
      metadata: null,
      createdAt: "",
    },
    messages: [],
    route: {
      provider: "openai",
      model: "gpt-test",
      resolvedEndpointId: null,
      endpointId: null,
      apiVariant: "openai",
      resolvedOllamaEndpoint: null,
      toolProtocol: "openai",
      outputBudget: { requestMaxOutputTokens: 32 },
      wireOutputTokens: 32,
      thinking: {},
    } as never,
    systemCacheSegments: null,
    systemVolatileTail: null,
    fullyInjectedIds: [],
    tokenBudget: 100,
    maxToolCalls: 10,
    contextWindow: 1000,
    language: "en",
    callLimitMessage: "limit",
    tokenBudgetMessage: "budget",
    userQuestionLimitMessage: "questions",
    fallbackSystem: "system",
    tools: [],
    set: vi.fn() as never,
    userQuestionRuntime: {} as never,
    dismissNote: "dismiss",
    assertAuthority: vi.fn(),
    signal: new AbortController().signal,
    checkRunningAuthority: vi.fn(),
    subscribeChat: vi.fn(),
    bindingIsCurrent: () => true,
    routeAuthorityKey: null,
    isCurrentTurn: () => true,
    isAborted: () => false,
    onSendAccepted: vi.fn(),
    onResponseText: vi.fn(),
    updateContextUsage: vi.fn(),
    cancelBeforeTransport: admission.cancelBeforeTransport,
    onLegacyFallback: vi.fn(),
    transitionAgentRunning: vi.fn(),
  };
}

describe("Mastra renderer turn admission", () => {
  it.each([
    ["provider", { provider: "cli" }],
    ["persisted session", { chatSessionId: null }],
    ["default project", { projectId: "default-project" }],
    ["closed gate", { gateClosedObserved: true }],
    ["pending start", { pendingStart: true }],
    ["attachments", { hasAttachments: true }],
    ["Hermes", { toolProtocol: "hermes" }],
    ["public search", { publicWebSearch: true }],
    ["tool outside Main", { tools: ["unhandled_tool"] }],
  ])("refuses an ineligible %s turn", (_reason, override) => {
    expect(
      chatTurnMastraEngine.shouldUse({ ...eligibility, ...override }),
    ).toBe(false);
  });

  it("admits an eligible tool subset", () => {
    expect(chatTurnMastraEngine.shouldUse(eligibility)).toBe(true);
  });

  it("keeps its deferred tool allowlist aligned with the shared definitions", () => {
    expect(chatTurnMastraEngine.mainToolNames).toEqual([
      ...M4_READ_TOOL_NAMES,
      ...MASTRA_UI_TOOL_NAMES,
    ]);
  });

  it("uses the captured persisted session after session creation", () => {
    expect(
      chatTurnMastraEngine.shouldUse({
        ...eligibility,
        chatSessionId: "session-created-for-this-send",
      }),
    ).toBe(true);
  });

  it("derives attachment eligibility from legacy message metadata", () => {
    expect(
      chatTurnMastraEngine.hasAttachments({
        id: "m1",
        sessionId: "s1",
        role: "user",
        content: "hello",
        metadata: null,
        createdAt: "",
      }),
    ).toBe(false);
    expect(
      chatTurnMastraEngine.hasAttachments({
        id: "m2",
        sessionId: "s1",
        role: "user",
        content: "hello",
        metadata: JSON.stringify({ attachments: [{ name: "draft.pdf" }] }),
        createdAt: "",
      }),
    ).toBe(true);
  });

  it("keeps only structurally valid setting proposals from the wire", () => {
    expect(
      chatTurnMastraEngine.toSettingProposal({
        id: "p1",
        key: "editor.fontSize",
        value: "18",
      }),
    ).toEqual({
      id: "p1",
      key: "editor.fontSize",
      value: "18",
    });
    expect(
      chatTurnMastraEngine.toSettingProposal({
        id: "p1",
        key: "editor.fontSize",
      }),
    ).toBeUndefined();
  });
});

describe("Mastra captured-turn cancellation", () => {
  const valid = {
    explicitlyAborted: false,
    isCurrentTurn: true,
    workspaceIsCurrent: true,
    projectIsCurrent: true,
    chatPolicyAllows: true,
    licenseAllows: true,
    quiescenceAllowsMutation: true,
  };

  it("continues through view, scene, and route movement while authority remains", () => {
    expect(shouldAbortMastraTurn(valid)).toBe(false);
  });

  it.each([
    ["Stop", { explicitlyAborted: true }],
    ["current turn", { isCurrentTurn: false }],
    ["workspace", { workspaceIsCurrent: false }],
    ["project", { projectIsCurrent: false }],
    ["chat policy", { chatPolicyAllows: false }],
    ["license", { licenseAllows: false }],
    ["quiescence", { quiescenceAllowsMutation: false }],
  ])("stops when %s authority is lost", (_reason, override) => {
    expect(shouldAbortMastraTurn({ ...valid, ...override })).toBe(true);
  });
});

describe("Mastra turn wiring", () => {
  const source = [
    "chatTurnStoreActions.ts",
    "chatTurnRuntime.ts",
    "chatTurnMastraEngine.ts",
  ]
    .map((file) => readFileSync(resolve(__dirname, file), "utf8"))
    .join("\n");

  it("checks eligibility only after the persisted session is established", () => {
    expect(
      source.indexOf("let sessionIdForPersist = activeSessionId;"),
    ).toBeGreaterThan(-1);
    expect(
      source.indexOf("let sessionIdForPersist = activeSessionId;"),
    ).toBeLessThan(source.indexOf("turnRuntime.tryMastraTurn({"));
  });

  it("keeps the legacy agent path for a refused or ineligible Mastra turn", () => {
    expect(source).toMatch(/if \(useAgentPath\) \{/);
    expect(source).toMatch(
      /if \(mastraResult\?\.kind === "completed"\)[\s\S]*?else \{[\s\S]*?runAgentLoop\(/,
    );
    expect(source).toMatch(
      /onLegacyFallback: \(\) => \{\s*mastraTurnAdmitted = false;/,
    );
    expect(source.match(/runAgentLoop\(\{/g)).toHaveLength(1);
    expect(
      chatTurnMastraEngine.shouldUse({
        ...eligibility,
        gateClosedObserved: true,
      }),
    ).toBe(false);
  });

  it("loads the engine through one lazy renderer loader", () => {
    expect(source.match(/\bawait import\s*\(/g)).toHaveLength(1);
  });

  it("keeps the start request bound to the captured session and invokes start only after admission", () => {
    expect(source).toMatch(
      /createMastraTurnAttempt\([\s\S]*?startMastraAgentTurn\(\s*request,/,
    );
    expect(source).toMatch(
      /chatSessionId: context.chatSessionId,[\s\S]*?projectId: context.projectId/,
    );
  });

  it("registers and releases response handlers even when the turn exits through finally", () => {
    expect(source).toMatch(
      /registerMastraAgentTurnResponder\([\s\S]*?listenMastraAgentTurnProgress\(/,
    );
    expect(source).toMatch(/finally \{\s*release\(\);/);
  });

  it("closes every audit reservation through complete or abandon, never persistence failure", () => {
    expect(source).not.toContain("failPendingAiAuditPersistence(sendTurnId");
    expect(
      source.match(/completePendingAiAuditExecution\(input\.turnId\)/g),
    ).toHaveLength(5);
    expect(
      source.match(/abandonPendingAiAuditExecution\(input\.turnId\)/g),
    ).toHaveLength(2);
    expect(source).toMatch(
      /if \(startInvoked\) \{[\s\S]*?completePendingAiAuditExecution\(input\.turnId\)[\s\S]*?\} else \{[\s\S]*?abandonPendingAiAuditExecution\(input\.turnId\)/,
    );
  });

  it("reserves and closes the audit registry through the production engine", async () => {
    _resetPendingAiAuditExecutionsForTests();
    mastraMocks.start.mockReset().mockResolvedValue({
      kind: "completed",
      response: { blocks: [] },
    });
    mastraMocks.registerQuestion.mockReset().mockResolvedValue(vi.fn());
    mastraMocks.listenProgress.mockReset().mockResolvedValue(vi.fn());
    mastraMocks.flushSceneWrites.mockReset().mockResolvedValue(undefined);
    const runtime = {
      claimMastraTurn: vi.fn(() => true),
      hasActiveMastraTurn: vi.fn(() => false),
      releaseMastraTurn: vi.fn(),
      setStreamCleanup: vi.fn(),
      clearStreamCleanupIf: vi.fn(),
    };
    const attempt = createMastraTurnAttempt(admission, runtime as never)!;
    await attempt.preflight;
    await expect(attempt.run(executionContext())).resolves.toMatchObject({
      kind: "completed",
    });
    expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
  });
});

describe("Mastra attempt terminal cleanup", () => {
  it("does not start when authority changes during listener registration", async () => {
    const runtime = {
      claimMastraTurn: vi.fn(() => true),
      hasActiveMastraTurn: vi.fn(() => false),
      releaseMastraTurn: vi.fn(),
      setStreamCleanup: vi.fn(),
      clearStreamCleanupIf: vi.fn(),
    };
    mastraMocks.flushSceneWrites.mockReset().mockResolvedValue(undefined);
    let selectedModel = "gpt-test";
    mastraMocks.registerQuestion.mockReset().mockImplementation(async () => {
      selectedModel = "gpt-new";
      return vi.fn();
    });
    mastraMocks.listenProgress.mockReset().mockResolvedValue(vi.fn());
    mastraMocks.start.mockReset();

    const attempt = createMastraTurnAttempt(admission, runtime as never)!;
    await attempt.preflight;
    const context = executionContext();
    context.assertAuthority = vi.fn(() => {
      if (selectedModel !== "gpt-test") throw new Error("model changed");
    });
    context.cancelBeforeTransport = vi.fn(() => true);

    await expect(attempt.run(context)).resolves.toEqual({ kind: "cancelled" });
    expect(mastraMocks.start).not.toHaveBeenCalled();
    expect(context.cancelBeforeTransport).toHaveBeenCalledOnce();
  });

  it.each([
    ["scene-write preflight", "preflight"],
    ["listener registration", "listener"],
  ] as const)(
    "falls back and releases after %s failure",
    async (_label, failure) => {
      const runtime = {
        claimMastraTurn: vi.fn(() => true),
        hasActiveMastraTurn: vi.fn(() => false),
        releaseMastraTurn: vi.fn(),
        setStreamCleanup: vi.fn(),
        clearStreamCleanupIf: vi.fn(),
      };
      const unregisterQuestion = vi.fn();
      mastraMocks.flushSceneWrites.mockReset();
      mastraMocks.registerQuestion.mockReset();
      mastraMocks.listenProgress.mockReset();
      if (failure === "preflight") {
        mastraMocks.flushSceneWrites.mockRejectedValueOnce(new Error("flush"));
      } else {
        mastraMocks.flushSceneWrites.mockResolvedValue(undefined);
        mastraMocks.registerQuestion.mockResolvedValue(unregisterQuestion);
        mastraMocks.listenProgress.mockRejectedValueOnce(new Error("listener"));
      }
      const attempt = createMastraTurnAttempt(admission, runtime as never)!;
      await expect(attempt.preflight).resolves.toBe(false);
      const context = executionContext();
      await expect(attempt.run(context)).resolves.toMatchObject({
        kind: "fallback",
      });
      expect(context.onLegacyFallback).toHaveBeenCalledOnce();
      expect(runtime.releaseMastraTurn).toHaveBeenCalledOnce();
      if (failure === "listener")
        expect(unregisterQuestion).toHaveBeenCalledOnce();
    },
  );

  it("recovers an assistant row in the start session", async () => {
    mastraMocks.start.mockReset().mockResolvedValue({
      kind: "completed",
      response: { blocks: [] },
    });
    mastraMocks.registerQuestion.mockReset().mockResolvedValue(vi.fn());
    mastraMocks.listenProgress.mockReset().mockResolvedValue(vi.fn());
    mastraMocks.flushSceneWrites.mockReset().mockResolvedValue(undefined);
    const runtime = {
      claimMastraTurn: vi.fn(() => true),
      hasActiveMastraTurn: vi.fn(() => false),
      releaseMastraTurn: vi.fn(),
      setStreamCleanup: vi.fn(),
      clearStreamCleanupIf: vi.fn(),
    };
    const attempt = createMastraTurnAttempt(admission, runtime as never)!;
    await attempt.preflight;
    await attempt.run(executionContext());

    expect(
      attempt.recoverAssistant(undefined, "recovered", "gpt-test", "{}"),
    ).toMatchObject({
      sessionId: admission.chatSessionId,
      content: "recovered",
    });
  });

  it.each([
    ["completed", { kind: "completed", response: { blocks: [] } }],
    ["refused", { kind: "refused", reason: "unsupported" }],
    ["overflow", { kind: "context-window-exceeded", usage: {} }],
    ["invalid response", { kind: "invalid-response" }],
    ["rejected start", new Error("start failed")],
  ] as const)("clears audit and listeners after %s", async (name, result) => {
    _resetPendingAiAuditExecutionsForTests();
    const unregisterQuestion = vi.fn();
    const unregisterProgress = vi.fn();
    mastraMocks.start.mockReset();
    mastraMocks.start.mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    mastraMocks.registerQuestion
      .mockReset()
      .mockResolvedValue(unregisterQuestion);
    mastraMocks.listenProgress
      .mockReset()
      .mockResolvedValue(unregisterProgress);
    mastraMocks.flushSceneWrites.mockReset().mockResolvedValue(undefined);
    const runtime = {
      claimMastraTurn: vi.fn(() => true),
      hasActiveMastraTurn: vi.fn(() => false),
      releaseMastraTurn: vi.fn(),
      setStreamCleanup: vi.fn(),
      clearStreamCleanupIf: vi.fn(),
    };
    const attempt = createMastraTurnAttempt(admission, runtime as never);
    expect(attempt).not.toBeNull();
    expect(await attempt!.preflight).toBe(false);

    const context = executionContext();
    if (result instanceof Error) {
      await expect(attempt!.run(context)).rejects.toThrow("start failed");
    } else if (
      result.kind === "invalid-response" ||
      result.kind === "context-window-exceeded"
    ) {
      await expect(attempt!.run(context)).rejects.toThrow();
    } else {
      const outcome = await attempt!.run(context);
      expect(outcome.kind).toBe(name === "refused" ? "fallback" : "completed");
      if (name === "refused") {
        expect(context.onLegacyFallback).toHaveBeenCalledOnce();
      }
    }

    expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
    expect(unregisterQuestion).toHaveBeenCalledOnce();
    expect(unregisterProgress).toHaveBeenCalledOnce();
    expect(runtime.releaseMastraTurn).toHaveBeenCalledOnce();
    attempt!.release();
  });

  it.each(["stop", "authority"] as const)(
    "cancels a dispatched turn once on %s and holds the audit until Main settles",
    async (cause) => {
      const controller = new AbortController();
      const context = executionContext();
      context.signal = controller.signal;
      let expired = false;
      context.checkRunningAuthority = () => {
        if (expired) controller.abort();
      };
      const unwatch = vi.fn();
      let notify!: () => void;
      mastraMocks.watchAuthority.mockImplementationOnce(
        (observe: () => void) => {
          notify = observe;
          return unwatch;
        },
      );
      let finish!: () => void;
      mastraMocks.start.mockImplementationOnce((_, dispatch: () => boolean) => {
        expect(dispatch()).toBe(true);
        context.onSendAccepted();
        return new Promise((resolve) => {
          finish = () =>
            resolve({ kind: "completed", response: { blocks: [] } });
        });
      });
      mastraMocks.cancel
        .mockReset()
        .mockResolvedValue({ kind: "ok", found: true });
      const runtime = {
        claimMastraTurn: () => true,
        hasActiveMastraTurn: () => false,
        releaseMastraTurn: vi.fn(),
      };
      const attempt = createMastraTurnAttempt(admission, runtime)!;
      await attempt.preflight;
      const running = attempt.run(context);
      await vi.waitFor(() => expect(context.onSendAccepted).toHaveBeenCalled());
      notify();
      expect(mastraMocks.cancel).not.toHaveBeenCalled();
      if (cause === "stop") controller.abort();
      else expired = true;
      notify();
      notify();
      expect(mastraMocks.cancel).toHaveBeenCalledExactlyOnceWith({
        turnId: admission.turnId,
      });
      expect(_pendingAiAuditExecutionCountForTests()).toBe(1);
      expect(unwatch).not.toHaveBeenCalled();
      finish();
      await running;
      expect(unwatch).toHaveBeenCalledOnce();
      expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
    },
  );

  it("withdraws a queued start when the lease closes admission", async () => {
    const controller = new AbortController();
    const context = executionContext();
    context.signal = controller.signal;
    context.checkRunningAuthority = () => controller.abort();
    mastraMocks.cancel.mockClear();
    mastraMocks.start.mockImplementationOnce((_, dispatch: () => boolean) => {
      expect(dispatch()).toBe(false);
      return { kind: "cancelled-before-dispatch" };
    });
    const attempt = createMastraTurnAttempt(admission, {
      claimMastraTurn: () => true,
      hasActiveMastraTurn: () => false,
      releaseMastraTurn: vi.fn(),
    })!;
    await attempt.preflight;
    await expect(attempt.run(context)).resolves.toEqual({ kind: "cancelled" });
    expect(mastraMocks.cancel).not.toHaveBeenCalled();
    expect(context.onLegacyFallback).not.toHaveBeenCalled();
    expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
  });

  it("falls back to the legacy path when Main reports Gate L closed", async () => {
    _resetPendingAiAuditExecutionsForTests();
    mastraMocks.start.mockReset().mockResolvedValue({
      kind: "refused",
      reason: "gate-closed",
    });
    mastraMocks.registerQuestion.mockReset().mockResolvedValue(vi.fn());
    mastraMocks.listenProgress.mockReset().mockResolvedValue(vi.fn());
    mastraMocks.flushSceneWrites.mockReset().mockResolvedValue(undefined);
    const runtime = {
      claimMastraTurn: vi.fn(() => true),
      hasActiveMastraTurn: vi.fn(() => false),
      releaseMastraTurn: vi.fn(),
      setStreamCleanup: vi.fn(),
      clearStreamCleanupIf: vi.fn(),
    };
    const attempt = createMastraTurnAttempt(admission, runtime as never);
    expect(attempt).not.toBeNull();
    await attempt!.preflight;
    const context = executionContext();

    await expect(attempt!.run(context)).resolves.toEqual({ kind: "fallback" });
    expect(context.onLegacyFallback).toHaveBeenCalledOnce();
    expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
    expect(createMastraTurnAttempt(admission, runtime as never)).toBeNull();
  });
});
