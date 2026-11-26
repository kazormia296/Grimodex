// MP-3c (DR-MP3-4, -5, -6, -7, -10, -11, -12, -13): Main's turn owner. The
// runtime here is a stand-in that makes the adapter's calls in the adapter's
// order (begin, dispatched, send, complete or fail) against Main's real audit
// sink; the real Agent and the third bundle are in `mastra/agentRuntime.bundle.test.ts`.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const progressDeliveries = vi.hoisted(() => [] as unknown[][]);
const questionDeliveries = vi.hoisted(() => [] as unknown[][]);
const knownSenderIds = vi.hoisted(() => new Set<number>());
vi.mock("../../src/features/chat/contextBuilder", () => ({
  ensureTokenizer: async () => undefined,
  countTokens: (text: string) => text.length,
}));
vi.mock("../../src/features/chat/agent/toolTurnCache", () => ({
  beginAgentToolTurn: () => undefined,
}));
vi.mock("./events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./events.js")>();
  return {
    ...actual,
    sendMainEventToWindow: (
      ...args: Parameters<typeof actual.sendMainEventToWindow>
    ) => {
      if (args[1] === "mastra:agent-turn-question") {
        questionDeliveries.push(args);
      } else {
        progressDeliveries.push(args);
      }
      return knownSenderIds.has(args[0] as number);
    },
  };
});

import type { AiAuditEventInput } from "../shared/aiAuditEvents.js";
import { MAIN_READ_CALLER_TIMEOUT_MS } from "../shared/ipcCallerTimeouts.js";
import { nativeSqlPolicyV2 } from "./d2aSqlPolicyFixture.js";
import {
  consumeProfileActivation,
  createProfileEgressGate,
} from "./profileEgress.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";
import type { CoreReadContext } from "../shared/mastraRead/ports.js";
import { createReadExecutors } from "../shared/readDomain/core/readExecutors.js";
import type {
  MastraAgentTurnAnswerRequest,
  MastraAgentTurnStartRequest,
  MastraAgentTurnStartResult,
  MastraAgentTurnQuestionPayload,
  MastraAgentTurnQuestionToolName,
  MastraAgentTurnUiToolResult,
} from "../shared/mastraAgentTurnWire.js";
import {
  MASTRA_AGENT_TURN_ASK_USER_TIMEOUT_MS,
  MASTRA_AGENT_TURN_UI_TOOL_TIMEOUT_MS,
} from "../shared/mastraAgentTurnWire.js";
import {
  ALREADY_INJECTED_CODEX_ENTRY_SUMMARY,
  alreadyInjectedCodexEntryContent,
} from "../shared/readDomain/features/codex/alreadyInjectedEntry.js";
import { AgentModelError } from "./mastra/agentModelPolicy.js";
import { createMastraAgentTools } from "./mastra/agentToolAdapter.js";
import { runNativeRead } from "./mastraRead/nativeCall.js";
import type {
  MastraAgentRuntimeModule,
  MastraAgentTurnInput,
} from "./mastra/agentRuntime.js";
import type {
  AgentAuditRequest,
  AgentWireArgs,
  AgentWireResponse,
} from "./mastra/agentWire.js";
import { createPerCodePointTokenizer } from "../shared/mastraRead/tokenizer.testSupport.js";
import {
  createMastraTurnOwner,
  MASTRA_TURN_FALLBACK_PROJECT_ID,
  MASTRA_TURN_FORCED_BOUND_MS,
  MASTRA_TURN_PER_SENDER_MAX,
  MASTRA_TURN_QUIT_BOUND_MS,
  MASTRA_TURN_TOTAL_MAX,
  type MastraTurnInvokeContext,
  type MastraTurnOwner,
  type MastraTurnOwnerOptions,
} from "./mastraTurnOwner.js";

const WORKSPACE = "/work/old";
const TURN_A = "00000000-0000-4000-8000-00000000000a";
const RESPONSE = {
  blocks: [{ type: "text", content: "ok" }],
  stopReason: "end_turn",
};

class FakeSender extends EventEmitter {
  destroyed = false;
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly webContents = {};
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
};

const PROJECT_ID = "project-1";
const CHAT_POLICY_SQL = "SELECT ai_policy FROM projects WHERE id = ? LIMIT 1";

function startRequest(
  turnId: string,
  extra: Partial<MastraAgentTurnStartRequest> = {},
): MastraAgentTurnStartRequest {
  const messages =
    extra.messages ??
    ([
      { role: "system", content: "You write." },
      { role: "user", content: "Continue." },
    ] as MastraAgentTurnStartRequest["messages"]);
  const loop: MastraAgentTurnStartRequest["loop"] = {
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
    ...extra.loop,
    fallbackSystem:
      extra.loop?.fallbackSystem ??
      (messages[0]?.role === "system" ? messages[0].content : "You write."),
  };
  return {
    turnId,
    chatSessionId: `session-${turnId}`,
    projectId: PROJECT_ID,
    currentSceneId: "scene-1",
    chatMessageId: `message-${turnId}`,
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
    tools: [],
    ...extra,
    messages,
    loop,
  };
}

let nextTurn = 0;
let nextToolUseId = 0;
const uuid = (): string =>
  `00000000-0000-4000-8000-${String(100 + nextTurn++).padStart(12, "0")}`;

interface Harness {
  readonly owner: MastraTurnOwner;
  readonly appended: {
    path: string;
    projectId: string | null;
    events: AiAuditEventInput[];
  }[];
  readonly sends: { args: AgentWireArgs; settings: unknown; apiKey: string }[];
  readonly dbQueries: {
    sql: string;
    params: unknown;
    method: string;
    callerIdentity: unknown;
  }[];
  /** Resolves the oldest pending Native send. */
  nativeSends: Deferred<string>[];
  readonly loads: { count: number };
  readonly readBindingLoads: { count: number };
  readonly settingsReads: { count: number };
  readonly issued: Set<unknown>;
  readonly profile: {
    restricted: boolean;
    unavailable: boolean;
    activating: boolean;
  };
  readonly logs: string[];
  appendBehavior: { fail: boolean; hang: Deferred<void> | null };
  /** Runs while an append of the given event type is in flight: the window between the dispatch row and the send. */
  hooks: { onAppend: ((types: string[]) => void) | null };
  newContext(senderId?: number): {
    context: MastraTurnInvokeContext;
    sender: FakeSender;
    win: FakeWindow;
    identity: Record<string, unknown>;
  };
  terminalsOf(executionId?: string): AiAuditEventInput[];
  types(): string[];
}

/**
 * A runtime that calls the sink and the send as the adapter does. `native`
 * decides what Native does: `"hold"` keeps the send pending until the test
 * settles `nativeSends[n]`.
 */
function harness(
  overrides: Partial<Omit<MastraTurnOwnerOptions, "loadReadBindings">> & {
    loadReadBindings?: MastraTurnOwnerOptions["loadReadBindings"] | null;
    native?: "hold" | "immediate";
    loadFails?: boolean;
    responses?: readonly AgentWireResponse[];
    /** Runs in the turn after the dispatch row and before the send (a tool's read, as PR-4 will). */
    runRead?: (owner: MastraTurnOwner) => Promise<unknown>;
    runTurn?: (input: MastraAgentTurnInput) => Promise<void>;
    readDbExecute?: NapiBackendLike["dbExecute"];
    policyDbExecute?: NapiBackendLike["dbExecute"];
    nativeReadMethods?: Partial<
      Pick<
        NapiBackendLike,
        | "ftsSearch"
        | "codexSemanticSearch"
        | "eventsSemanticSearch"
        | "foreshadowListWithLabels"
        | "foreshadowListOpenForContext"
      >
    >;
  } = {},
): Harness {
  const {
    loadReadBindings: readBindingsLoaderOverride,
    policyDbExecute,
    ...ownerOverrides
  } = overrides;
  const appended: Harness["appended"] = [];
  const sends: Harness["sends"] = [];
  const dbQueries: Harness["dbQueries"] = [];
  const nativeSends: Deferred<string>[] = [];
  const loads = { count: 0 };
  const readBindingLoads = { count: 0 };
  const settingsReads = { count: 0 };
  const issued = new Set<unknown>();
  const logs: string[] = [];
  const profile = { restricted: false, unavailable: false, activating: false };
  const appendBehavior: Harness["appendBehavior"] = { fail: false, hang: null };
  const hooks: Harness["hooks"] = { onAppend: null };
  const native = overrides.native ?? "immediate";
  let loadFailuresLeft = overrides.loadFails ? 1 : 0;

  const backend = {
    async aiAuditAppendBatch(
      path: string,
      projectId: string | null,
      events: unknown,
    ): Promise<string> {
      hooks.onAppend?.((events as AiAuditEventInput[]).map((e) => e.eventType));
      if (appendBehavior.hang) await appendBehavior.hang.promise;
      if (appendBehavior.fail) throw new Error("append failed");
      appended.push({ path, projectId, events: events as AiAuditEventInput[] });
      return JSON.stringify({ insertedCount: 1 });
    },
    async dbExecute(
      ...args: Parameters<NapiBackendLike["dbExecute"]>
    ): Promise<string> {
      dbQueries.push({
        sql: args[0],
        params: args[1],
        method: args[2],
        callerIdentity: args[3],
      });
      if (args[0] === CHAT_POLICY_SQL) {
        if (policyDbExecute) return policyDbExecute(...args);
        return JSON.stringify({
          __grimodexDbResultKind: "read",
          rows: [{ ai_policy: null }],
        });
      }
      if (overrides.readDbExecute) return overrides.readDbExecute(...args);
      return JSON.stringify({
        __grimodexDbResultKind: "read",
        rows: [],
      });
    },
    async getAiSettings(): Promise<string> {
      settingsReads.count += 1;
      return JSON.stringify({ provider: "anthropic" });
    },
    async sendAgentMessage(
      args: unknown,
      settings: unknown,
      apiKey: string,
    ): Promise<string> {
      sends.push({ args: args as AgentWireArgs, settings, apiKey });
      if (native === "immediate")
        return JSON.stringify(
          overrides.responses?.[sends.length - 1] ?? RESPONSE,
        );
      const hold = deferred<string>();
      nativeSends.push(hold);
      return hold.promise;
    },
    ...overrides.nativeReadMethods,
  } as unknown as NapiBackendLike;

  const runtimeModule: MastraAgentRuntimeModule = {
    createMastraAgentRuntime: () => ({
      async runTurn(input: MastraAgentTurnInput) {
        if (overrides.runTurn) return overrides.runTurn(input);
        const request = auditRequestFor(input);
        const preparedRequest = input.prepareSend
          ? input.prepareSend(request, { sendIndex: 0, previous: null })
          : request;
        await input.assertSendAllowed?.({ sendIndex: 0, previous: null });
        const handle = await input.audit.begin(preparedRequest);
        let raw;
        try {
          await input.audit.dispatched(handle);
          await overrides.runRead?.(owner);
          raw = await input.send(
            {
              ...preparedRequest,
              // As the adapter's `buildWireArgs` does.
              ...(handle.chatMessageId
                ? { chatMessageId: handle.chatMessageId }
                : {}),
              auditContext: handle.auditContext,
            } as AgentWireArgs,
            { signal: input.signal },
          );
        } catch (error) {
          await input.audit.fail(handle, error);
          throw error instanceof AgentModelError
            ? error
            : new AgentModelError("send-failed", "send failed", error);
        }
        await input.audit.complete(handle, {
          response: raw,
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            cost: null,
            stopReason: raw.stopReason,
          },
        });
        input.observeResponse?.(structuredClone(raw));
      },
    }),
  };

  const owner = createMastraTurnOwner({
    open: true,
    backend,
    tokenizer: createPerCodePointTokenizer(),
    secrets: { resolveApiKeyForRequest: () => "key-1" },
    profile: {
      get restricted() {
        return profile.restricted;
      },
      get unavailable() {
        return profile.unavailable;
      },
      get activating() {
        return profile.activating;
      },
      isIssuedCallerIdentity: (identity) => issued.has(identity),
    },
    loadRuntime: async () => {
      loads.count += 1;
      if (loadFailuresLeft > 0) {
        loadFailuresLeft -= 1;
        throw new Error("MASTRA_LOAD_FAILED");
      }
      return runtimeModule;
    },
    ...(readBindingsLoaderOverride === null
      ? {}
      : {
          loadReadBindings: async () => {
            readBindingLoads.count += 1;
            return (
              readBindingsLoaderOverride ??
              (() => import("./mastraTurnReadBindings.js"))
            )();
          },
        }),
    appVersion: "0.0.0-test",
    log: (_level, message) => logs.push(message),
    randomUUID: uuid,
    ...ownerOverrides,
  });

  let senderSeq = 1;
  return {
    owner,
    appended,
    sends,
    dbQueries,
    nativeSends,
    loads,
    readBindingLoads,
    settingsReads,
    issued,
    profile,
    logs,
    appendBehavior,
    hooks,
    newContext(senderId = senderSeq++) {
      knownSenderIds.add(senderId);
      const sender = new FakeSender(senderId);
      const win = new FakeWindow(senderId + 1000);
      const identity = { senderId, workspaceId: WORKSPACE };
      issued.add(identity);
      return {
        context: { sender, win, callerIdentity: identity },
        sender,
        win,
        identity,
      };
    },
    terminalsOf(executionId) {
      return appended
        .flatMap((call) => call.events)
        .filter(
          (event) =>
            (event.eventType === "execution.failed" ||
              event.eventType === "execution.cancelled" ||
              event.eventType === "execution.succeeded") &&
            (executionId === undefined || event.executionId === executionId),
        );
    },
    types() {
      return appended.flatMap((call) =>
        call.events.map((event) => event.eventType),
      );
    },
  };
}

const completed = (
  value: unknown,
): MastraAgentTurnStartResult & {
  status: "completed";
} => {
  const result = value as MastraAgentTurnStartResult;
  expect(result.status).toBe("completed");
  return result as MastraAgentTurnStartResult & { status: "completed" };
};

const refusalReason = (value: unknown): string => {
  const result = value as { status: string; reason?: string };
  expect(result.status).toBe("refused");
  return result.reason ?? "";
};

const UI_TOOL_CALL_ID = "ui-tool-call-1";
const ASK_USER_ARGS = {
  questions: [{ question: "Which way?", kind: "single", options: ["A", "B"] }],
};

function answerForQuestion(
  question: MastraAgentTurnQuestionPayload,
): Extract<
  MastraAgentTurnAnswerRequest,
  { readonly result: MastraAgentTurnUiToolResult }
> {
  return {
    requestId: question.requestId,
    result: {
      toolCallId: question.toolCallId,
      name: question.toolName,
      content: { answer: "A" },
      summary: "answered",
      tokensUsed: 1,
    },
  };
}

async function startPendingUiQuestion(
  toolName: MastraAgentTurnQuestionToolName = "get_ui_state",
  args: Readonly<Record<string, unknown>> = {},
  ownerOverrides: Partial<Omit<MastraTurnOwnerOptions, "loadReadBindings">> & {
    policyDbExecute?: NapiBackendLike["dbExecute"];
  } = {},
): Promise<{
  readonly h: Harness;
  readonly context: MastraTurnInvokeContext;
  readonly sender: FakeSender;
  readonly win: FakeWindow;
  readonly pending: Promise<MastraAgentTurnUiToolResult>;
  readonly start: Promise<MastraAgentTurnStartResult>;
  readonly question: MastraAgentTurnQuestionPayload;
}> {
  const ownerRef: { owner?: MastraTurnOwner } = {};
  const pendingReady = deferred<{
    readonly pending: Promise<MastraAgentTurnUiToolResult>;
  }>();
  const h = harness({
    ...ownerOverrides,
    runTurn: async (input) => {
      await sendPreparedRequest(input, auditRequestFor(input), 0);
      const pending = ownerRef.owner!.requestUiTool(
        TURN_A,
        UI_TOOL_CALL_ID,
        toolName,
        args,
      );
      pendingReady.resolve({ pending });
      try {
        await pending;
      } catch {
        await sendPreparedRequest(input, auditRequestFor(input), 1);
      }
    },
  });
  ownerRef.owner = h.owner;
  const { context, sender, win } = h.newContext();
  const start = h.owner.start(context, startRequest(TURN_A));
  void start.catch(() => undefined);
  const { pending } = await pendingReady.promise;
  await flush();
  const delivery = questionDeliveries[questionDeliveries.length - 1];
  if (!delivery) throw new Error("MP5_QUESTION_NOT_SENT");
  return {
    h,
    context,
    sender,
    win,
    pending,
    start,
    question: delivery[2] as MastraAgentTurnQuestionPayload,
  };
}

async function startAdapterPendingUiTool(
  toolName: MastraAgentTurnQuestionToolName,
  args: Readonly<Record<string, unknown>>,
  loop: Partial<MastraAgentTurnStartRequest["loop"]> = {},
  toolContext: Record<string, unknown> = {},
): Promise<{
  readonly h: Harness;
  readonly context: MastraTurnInvokeContext;
  readonly sender: FakeSender;
  readonly win: FakeWindow;
  readonly pending: Promise<string>;
  readonly start: Promise<MastraAgentTurnStartResult>;
  readonly question: MastraAgentTurnQuestionPayload;
}> {
  const response: AgentWireResponse = {
    blocks: [
      {
        type: "tool_use",
        id: UI_TOOL_CALL_ID,
        name: toolName,
        input: args,
      },
    ],
    stopReason: "tool_use",
  };
  const pendingReady = deferred<{ readonly pending: Promise<string> }>();
  const h = harness({
    responses: [
      response,
      { blocks: [{ type: "text", content: "Done." }], stopReason: "end_turn" },
    ],
    runTurn: async (input) =>
      driveCoreReadOwnerLoop(
        input,
        true,
        (execution) => {
          const pending = Promise.resolve(execution).then((result) =>
            String(result),
          );
          void pending.catch(() => undefined);
          pendingReady.resolve({
            pending,
          });
        },
        toolContext,
      ),
  });
  const { context, sender, win } = h.newContext();
  const request = startRequest(TURN_A);
  const start = h.owner.start(context, {
    ...request,
    tools: [toolName],
    loop: { ...request.loop, ...loop },
  });
  void start.catch(() => undefined);
  const { pending } = await pendingReady.promise;
  await flush();
  const delivery = questionDeliveries[questionDeliveries.length - 1];
  if (!delivery) throw new Error("MP5_ADAPTER_QUESTION_NOT_SENT");
  return {
    h,
    context,
    sender,
    win,
    pending,
    start,
    question: delivery[2] as MastraAgentTurnQuestionPayload,
  };
}

function auditRequestFor(
  input: MastraAgentTurnInput,
  messages: AgentAuditRequest["messages"] = [...input.messages],
): AgentAuditRequest {
  return {
    messages: [{ role: "system", content: input.instructions }, ...messages],
    tools: input.toolDefinitions ?? [],
    ...input.route,
    systemCacheSegments: input.systemCacheSegments,
    systemVolatileTail: input.systemVolatileTail,
  } as unknown as AgentAuditRequest;
}

async function sendPreparedRequest(
  input: MastraAgentTurnInput,
  request: AgentAuditRequest,
  sendIndex: number,
): Promise<{ response: AgentWireResponse; prepared: AgentAuditRequest }> {
  if (!input.prepareSend) throw new Error("prepareSend missing");
  const prepared = input.prepareSend(request, { sendIndex, previous: null });
  await input.assertSendAllowed?.({ sendIndex, previous: null });
  const handle = await input.audit.begin(prepared);
  let response: AgentWireResponse;
  try {
    await input.audit.dispatched(handle);
    response = await input.send(
      {
        ...prepared,
        ...(handle.chatMessageId
          ? { chatMessageId: handle.chatMessageId }
          : {}),
        auditContext: handle.auditContext,
      } as AgentWireArgs,
      { signal: input.signal },
    );
  } catch (error) {
    await input.audit.fail(handle, error);
    throw error;
  }
  await input.audit.complete(handle, {
    response,
    usage: {
      inputTokens: response.inputTokens ?? null,
      outputTokens: response.outputTokens ?? null,
      cacheReadTokens: response.cacheReadTokens ?? null,
      cacheWriteTokens: response.cacheWriteTokens ?? null,
      cost: response.cost ?? null,
      stopReason: response.stopReason,
    },
  });
  input.observeResponse?.(structuredClone(response));
  return { response, prepared };
}

function textOf(response: AgentWireResponse): string {
  return response.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.content)
    .join("\n");
}

async function driveOwnerLoop(input: MastraAgentTurnInput): Promise<void> {
  const messages: AgentAuditRequest["messages"] = [...input.messages];
  for (let sendIndex = 0; sendIndex < 20; sendIndex += 1) {
    const request = auditRequestFor(input, messages);
    const { response, prepared } = await sendPreparedRequest(
      input,
      request,
      sendIndex,
    );
    if (prepared.messages.length > request.messages.length) return;
    const toolUses =
      response.stopReason === "tool_use"
        ? response.blocks.filter((block) => block.type === "tool_use")
        : [];
    if (toolUses.length === 0) return;
    messages.push({
      role: "assistant",
      content: textOf(response),
      toolUses: toolUses.map(({ id, name, input: params }) => ({
        id,
        name,
        input: params,
      })),
    });
    for (const tool of toolUses) {
      input.onToolStart?.({
        toolCallId: tool.id,
        toolName: tool.name,
      });
      input.onToolResult?.({
        toolCallId: tool.id,
        tokens: 1,
        toolName: tool.name,
        summary: `${tool.name} result`,
      });
      messages.push({
        role: "tool_result",
        toolUseId: tool.id,
        content: `${tool.name} result`,
        isError: false,
      });
    }
  }
  throw new Error("fake runtime exceeded its send bound");
}

async function runLegacyLoop(input: {
  readonly responses: readonly AgentWireResponse[];
  readonly tokenBudget: number;
  readonly maxToolCalls: number;
  readonly maxUserQuestions: number;
  readonly executeTool?: (
    name: string,
    toolCallId: string,
    params: unknown,
  ) => Promise<unknown>;
}): Promise<{
  readonly result: {
    readonly finalThinkingBlocks: readonly unknown[];
    readonly citations: readonly unknown[];
    readonly toolCallRecords: readonly {
      readonly name: string;
      readonly params: Record<string, unknown>;
      readonly resultSummary: string;
      readonly tokensUsed: number;
    }[];
    readonly stoppedReason: string;
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
    readonly cost: number | null;
  };
  readonly sentMessages: unknown[][];
  readonly textChunks: string[];
}> {
  const legacy = await vi.importActual<{
    runAgentLoop(options: never): Promise<never>;
  }>("../../src/features/chat/agent/agentLoop");
  let responseIndex = 0;
  const sentMessages: unknown[][] = [];
  const textChunks: string[] = [];
  const toolNames = [
    ...new Set(
      input.responses.flatMap((response) =>
        response.blocks.flatMap((block) =>
          block.type === "tool_use" ? [block.name] : [],
        ),
      ),
    ),
  ];
  const result = await legacy.runAgentLoop({
    messages: [{ role: "user", content: "Continue." }],
    tools: toolNames.map((name) => ({ name })) as never,
    tokenBudget: input.tokenBudget,
    maxToolCalls: input.maxToolCalls,
    maxUserQuestions: input.maxUserQuestions,
    sendToLLM: async (messages: unknown[]) => {
      sentMessages.push(structuredClone(messages));
      return input.responses[responseIndex++] as never;
    },
    executeTool: async (name: string, toolCallId: string, params: unknown) => {
      if (input.executeTool) return input.executeTool(name, toolCallId, params);
      return {
        name,
        toolCallId,
        content: null,
        summary: `${name} result`,
        tokensUsed: 1,
        params,
      } as never;
    },
    onProgress: () => undefined,
    onTextChunk: (text: string) => textChunks.push(text),
    callLimitMessage: "calls",
    tokenBudgetMessage: "tokens",
    userQuestionLimitMessage: "questions",
  } as never);
  return { result: result as never, sentMessages, textChunks };
}

function responseWith(
  stopReason: string,
  text: string,
  toolNames: readonly string[] = [],
  usage: Partial<AgentWireResponse> = {},
): AgentWireResponse {
  return {
    blocks: [
      ...(text ? [{ type: "text" as const, content: text }] : []),
      ...toolNames.map((name, index) => ({
        type: "tool_use" as const,
        id: `tool-${nextToolUseId++}-${name}`,
        name,
        input: { ordinal: index },
      })),
    ],
    stopReason,
    ...usage,
  };
}

function readAnswer(rows: Record<string, unknown>[] = []): string {
  return JSON.stringify({ __grimodexDbResultKind: "read", rows });
}

function mainReadFixture(title: string): NapiBackendLike["dbExecute"] {
  return async (sql) => {
    if (sql.includes("phase_resolution_mode"))
      return readAnswer([{ phase_resolution_mode: "reading" }]);
    if (sql.includes("tree_nodes") && sql.includes("chronicle_start_time")) {
      return readAnswer([
        {
          id: "scene-1",
          parent_id: null,
          node_type: "scene",
          sort_order: "a0",
          story_time_order: null,
          archived_at: null,
          title,
          chronicle_start_time: null,
          chronicle_start_minute: null,
          chronicle_start_granularity: "minute",
          chronicle_precision: "minute",
        },
      ]);
    }
    if (sql.includes("tree_nodes")) {
      return readAnswer([
        {
          id: "scene-1",
          parent_id: null,
          node_type: "scene",
          title,
          status: "outline",
          sort_order: "a0",
        },
      ]);
    }
    return readAnswer();
  };
}

/** Drives the real T-a tool adapter and the owner's selected core bindings. */
async function driveCoreReadOwnerLoop(
  input: MastraAgentTurnInput,
  continueAfterControl = false,
  onToolExecute?: (execution: Promise<unknown>) => void,
  toolContext: Record<string, unknown> = {},
): Promise<void> {
  const tools = createMastraAgentTools({
    names: (input.toolDefinitions ?? []).map(({ name }) => name),
    bindings: input.bindings ?? [],
    tokenBudget: input.tokenBudget ?? 0,
    countTokens: input.countTokens ?? ((text) => text.length),
    signal: input.signal,
    isToolDeclared: input.isToolDeclared,
    isTurnStopped: input.isTurnStopped,
    onToolStart: input.onToolStart,
    onToolResult: input.onToolResult,
  });
  const messages: AgentAuditRequest["messages"] = [...input.messages];
  for (let sendIndex = 0; sendIndex < 20; sendIndex += 1) {
    const request = auditRequestFor(input, messages);
    const { response, prepared } = await sendPreparedRequest(
      input,
      request,
      sendIndex,
    );
    if (
      !continueAfterControl &&
      prepared.messages.length > request.messages.length
    )
      return;
    const toolUses =
      response.stopReason === "tool_use"
        ? response.blocks.filter((block) => block.type === "tool_use")
        : [];
    if (toolUses.length === 0) return;
    messages.push({
      role: "assistant",
      content: textOf(response),
      toolUses: toolUses.map(({ id, name, input: params }) => ({
        id,
        name,
        input: params,
      })),
    });
    for (const tool of toolUses) {
      const adapter = tools[tool.name];
      if (!adapter?.execute)
        throw new Error(`fake runtime has no tool: ${tool.name}`);
      let content: string;
      let isError = false;
      try {
        const execution = Promise.resolve(
          adapter.execute(tool.input, {
            agent: { toolCallId: tool.id },
            abortSignal: input.signal,
            ...toolContext,
          } as never),
        );
        onToolExecute?.(execution);
        content = String(await execution);
      } catch (error) {
        if (input.signal.aborted) throw error;
        content = `Error: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
      }
      messages.push({
        role: "tool_result",
        toolUseId: tool.id,
        content,
        isError,
      });
    }
  }
  throw new Error("fake runtime exceeded its send bound");
}

beforeEach(() => {
  nextTurn = 0;
  nextToolUseId = 0;
  progressDeliveries.length = 0;
  questionDeliveries.length = 0;
  knownSenderIds.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("start: the turn's route and result", () => {
  it("runs one turn: audit rows in order, the raw response and Main's execution ID come back, settings and key are resolved for the send", async () => {
    const h = harness();
    const { context, identity } = h.newContext();
    const result = completed(
      await h.owner.start(context, startRequest(TURN_A)),
    );
    expect(result.turnId).toBe(TURN_A);
    expect(result.response).toEqual(RESPONSE);
    expect(h.types()).toEqual([
      "execution.started",
      "request.prepared",
      "request.dispatched",
      "response.completed",
      "execution.succeeded",
    ]);
    // Rows are written to the issued identity's workspace, in the request's
    // project chain (the legacy route's `project:<id>`; MP-4a).
    expect(h.appended.every((call) => call.path === identity.workspaceId)).toBe(
      true,
    );
    expect(h.appended.every((call) => call.projectId === PROJECT_ID)).toBe(
      true,
    );
    // The result's execution ID is the one of the rows.
    expect(h.terminalsOf()[0]?.executionId).toBe(result.executionId);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.apiKey).toBe("key-1");
    expect(h.sends[0]?.settings).toEqual({ provider: "anthropic" });
    // Native does not get the caller identity (a legacy permit); the audit context is Main's.
    expect(h.sends[0]?.args).not.toHaveProperty("callerIdentity");
    expect(h.sends[0]?.args.auditContext).toMatchObject({
      expectedWorkspacePath: WORKSPACE,
      // The send names the scope the rows were appended to: Native's dispatch
      // precondition compares the two.
      projectId: PROJECT_ID,
      pathId: "chat_agent_main",
      parentExecutionId: null,
      executionId: result.executionId,
    });
    // The message ID rides the send's arguments (as in the legacy route), not a row.
    expect(h.sends[0]?.args.chatMessageId).toBe(`message-${TURN_A}`);
    expect(JSON.stringify(h.appended)).not.toContain(`message-${TURN_A}`);
    expect(h.owner.activeTurnCount()).toBe(0);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("writes each turn to its own project's chain, and the append and the send name the same scope", async () => {
    const h = harness();
    const { context } = h.newContext();
    const a = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, { projectId: "project-a" }),
      ),
    );
    const b = completed(
      await h.owner.start(
        context,
        startRequest(uuid(), { projectId: "project-b", currentSceneId: null }),
      ),
    );
    for (const [result, projectId] of [
      [a, "project-a"],
      [b, "project-b"],
    ] as const) {
      const rows = h.appended.filter((call) =>
        call.events.some((event) => event.executionId === result.executionId),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((call) => call.projectId === projectId)).toBe(true);
      const send = h.sends.find(
        (candidate) =>
          (candidate.args.auditContext as { executionId?: string })
            .executionId === result.executionId,
      );
      expect(send?.args.auditContext).toMatchObject({ projectId });
    }
  });

  it("refuses the fallback project ID as unsupported: no runtime load, no row, no send, no slot", async () => {
    const h = harness();
    const { context } = h.newContext();
    expect(MASTRA_TURN_FALLBACK_PROJECT_ID).toBe("default-project");
    expect(
      refusalReason(
        await h.owner.start(
          context,
          startRequest(TURN_A, { projectId: MASTRA_TURN_FALLBACK_PROJECT_ID }),
        ),
      ),
    ).toBe("unsupported");
    expect(h.loads.count).toBe(0);
    expect(h.appended).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    expect(h.owner.activeTurnCount()).toBe(0);
    expect(h.owner.slotsInUse()).toBe(0);
    // The same turn with a real project is admitted.
    completed(await h.owner.start(context, startRequest(TURN_A)));
  });

  it("the fallback literal is the renderer's FALLBACK_PROJECT_ID", () => {
    const source = readFileSync(
      new URL(
        "../../src/application/project/currentProjectAuthority.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(
      /export const FALLBACK_PROJECT_ID = "([^"]*)"/u.exec(source)?.[1],
    ).toBe(MASTRA_TURN_FALLBACK_PROJECT_ID);
  });

  it("loads the runtime once for many turns, and a failed load is not cached (no rows; the next start tries again)", async () => {
    const h = harness({ loadFails: true });
    const { context } = h.newContext();
    await expect(h.owner.start(context, startRequest(TURN_A))).rejects.toThrow(
      /MASTRA_LOAD_FAILED/,
    );
    expect(h.appended).toHaveLength(0);
    expect(h.owner.slotsInUse()).toBe(0);
    completed(await h.owner.start(context, startRequest(uuid())));
    completed(await h.owner.start(context, startRequest(uuid())));
    expect(h.loads.count).toBe(2);
  });

  it("a closed gate loads nothing and writes nothing", async () => {
    const h = harness({ open: false });
    const { context } = h.newContext();
    expect(
      refusalReason(await h.owner.start(context, startRequest(TURN_A))),
    ).toBe("gate-closed");
    expect(h.loads.count).toBe(0);
    expect(h.appended).toHaveLength(0);
  });

  it("a provider failure ends the turn with one failed terminal (no ambiguous mark), the cause's message, and no second send", async () => {
    const h = harness({ native: "hold" });
    const { context } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    h.nativeSends[0]!.reject(new Error("provider 500"));
    await expect(started).rejects.toThrow("provider 500");
    expect(h.sends).toHaveLength(1);
    expect(h.types().filter((t) => t === "execution.failed")).toHaveLength(1);
    expect(h.terminalsOf()[0]?.payload).not.toHaveProperty("remoteOutcome");
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("refuses what it cannot run as it is, and does not reassemble the messages", async () => {
    const h = harness();
    const { context } = h.newContext();
    const cases: [string, Partial<MastraAgentTurnStartRequest>][] = [
      ["no system first", { messages: [{ role: "user", content: "hi" }] }],
      [
        "a later system",
        {
          messages: [
            { role: "system", content: "a" },
            { role: "user", content: "b" },
            { role: "system", content: "c" },
            { role: "user", content: "d" },
          ],
        },
      ],
      [
        "the last is not the user's",
        {
          messages: [
            { role: "system", content: "a" },
            { role: "user", content: "b" },
            { role: "assistant", content: "c" },
          ],
        },
      ],
      ["system only", { messages: [{ role: "system", content: "a" }] }],
    ];
    for (const [label, extra] of cases) {
      expect(
        refusalReason(
          await h.owner.start(context, startRequest(uuid(), extra)),
        ),
        label,
      ).toBe("unsupported");
    }
    expect(h.loads.count).toBe(0);
    expect(h.appended).toHaveLength(0);
  });

  it("refuses a sender whose identity is not one Main issued, a destroyed sender and a profile that is closed", async () => {
    const h = harness();
    const { context, identity } = h.newContext();
    h.issued.delete(identity);
    expect(
      refusalReason(await h.owner.start(context, startRequest(uuid()))),
    ).toBe("sender-refused");
    const second = h.newContext();
    second.sender.destroyed = true;
    expect(
      refusalReason(await h.owner.start(second.context, startRequest(uuid()))),
    ).toBe("sender-refused");
    const third = h.newContext();
    h.profile.restricted = true;
    expect(
      refusalReason(await h.owner.start(third.context, startRequest(uuid()))),
    ).toBe("restricted");
    expect(h.loads.count).toBe(0);
  });

  it("a workspace path that is not on the identity is not run (the audit needs it)", async () => {
    const h = harness();
    const { context, identity } = h.newContext();
    identity.workspaceId = null;
    expect(
      refusalReason(await h.owner.start(context, startRequest(uuid()))),
    ).toBe("unsupported");
  });
});

describe("per-send payload finalization (R2-b1)", () => {
  it("sends one ordered send-accepted event per successful send", async () => {
    const h = harness({
      runTurn: async (input) => {
        const request = auditRequestFor(input);
        await sendPreparedRequest(input, request, 0);
        await sendPreparedRequest(input, request, 1);
      },
    });
    const { context } = h.newContext();
    completed(await h.owner.start(context, startRequest(TURN_A)));

    expect(h.sends).toHaveLength(2);
    const events = progressDeliveries.map(
      ([, , payload]) =>
        payload as {
          sequence: number;
          event: { kind: string; sendIndex?: number };
        },
    );
    expect(
      events.map(({ sequence, event }) => [
        sequence,
        event.kind,
        event.sendIndex,
      ]),
    ).toEqual([
      [1, "send-accepted", 1],
      [2, "send-accepted", 2],
    ]);
  });

  it("accepts the exact window boundary and reports one-token overflow before audit begin", async () => {
    const base = startRequest(TURN_A);
    const contextWindow =
      base.loop.fallbackSystem.length +
      JSON.stringify({ role: "user", content: "Continue." }).length +
      8 +
      32;
    const requestAtBoundary = startRequest(TURN_A, {
      route: { ...base.route, requestMaxOutputTokens: 8 },
      loop: {
        ...base.loop,
        contextWindow,
        requestMaxOutputTokens: 8,
      },
    });
    const exact = harness();
    const exactContext = exact.newContext();
    completed(await exact.owner.start(exactContext.context, requestAtBoundary));
    expect(
      (
        progressDeliveries[0]?.[2] as {
          event: { usage: { remainingTokens: number } };
        }
      ).event.usage.remainingTokens,
    ).toBe(0);

    progressDeliveries.length = 0;
    const over = harness();
    const overContext = over.newContext();
    const result = await over.owner.start(
      overContext.context,
      startRequest(TURN_A, {
        route: { ...base.route, requestMaxOutputTokens: 8 },
        loop: {
          ...base.loop,
          contextWindow,
          requestMaxOutputTokens: 8,
        },
        messages: [
          { role: "system", content: "You write." },
          { role: "user", content: "Continued." },
        ],
      }),
    );
    expect(result.status).toBe("context-window-exceeded");
    if (result.status !== "context-window-exceeded")
      throw new Error("expected overflow");
    expect(result.overflowTokens).toBe(1);
    expect(over.appended).toHaveLength(0);
    expect(over.sends).toHaveLength(0);
    const overflowEvents = progressDeliveries.map(
      ([, , payload]) =>
        payload as { event: { kind: string; overflowTokens?: number } },
    );
    expect(overflowEvents).toHaveLength(1);
    expect(overflowEvents[0]?.event).toMatchObject({
      kind: "context-overflow",
      overflowTokens: 1,
    });
  });

  it("reflects a cache budget downgrade in the request before audit begin", async () => {
    const base = startRequest(TURN_A);
    const h = harness();
    const { context } = h.newContext();
    completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, {
          route: { ...base.route, requestMaxOutputTokens: 8 },
          loop: {
            ...base.loop,
            contextWindow: 87,
            requestMaxOutputTokens: 8,
          },
          systemCacheSegments: ["x".repeat(40)],
          systemVolatileTail: "tail",
        }),
      ),
    );
    expect(h.sends[0]?.args.messages[0]).toEqual({
      role: "system",
      content: "You write.",
    });
    expect(h.sends[0]?.args.systemCacheSegments).toBeNull();
    expect(h.sends[0]?.args.systemVolatileTail).toBeNull();
    expect(
      (
        progressDeliveries[0]?.[2] as {
          event: { cacheDowngradeReason: string | null };
        }
      ).event.cacheDowngradeReason,
    ).toBe("budget");
  });

  it("returns one overflow terminal after the prior send, with no audit row for the overflowing send", async () => {
    const base = startRequest(TURN_A);
    const h = harness({
      responses: [responseWith("tool_use", "Earlier answer.", ["get_scene"])],
      runTurn: async (input) => {
        const request = auditRequestFor(input);
        await sendPreparedRequest(input, request, 0);
        input.onToolResult?.({
          toolCallId: "call-1",
          tokens: 1,
          toolName: "get_scene",
          summary: "get_scene result",
        });
        await sendPreparedRequest(
          input,
          {
            ...request,
            messages: [
              ...request.messages,
              { role: "assistant", content: "Earlier answer." },
              { role: "user", content: "x".repeat(100) },
            ],
          },
          1,
        );
      },
    });
    const { context } = h.newContext();
    const result = await h.owner.start(
      context,
      startRequest(TURN_A, {
        route: { ...base.route, requestMaxOutputTokens: 8 },
        loop: {
          ...base.loop,
          contextWindow: 128,
          requestMaxOutputTokens: 8,
        },
        systemCacheSegments: ["a", "b", "c", "d", "e"],
      }),
    );

    expect(result.status).toBe("context-window-exceeded");
    if (result.status !== "context-window-exceeded")
      throw new Error("expected overflow");
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(h.sends).toHaveLength(1);
    expect(
      h.types().filter((type) => type === "request.prepared"),
    ).toHaveLength(1);
    expect(
      h.types().filter((type) => type === "execution.succeeded"),
    ).toHaveLength(1);
    const events = progressDeliveries.map(
      ([, , payload]) =>
        payload as {
          sequence: number;
          event: {
            kind: string;
            sendIndex?: number;
            cacheDowngradeReason?: string | null;
          };
        },
    );
    expect(events).toHaveLength(2);
    expect(events.map(({ event }) => event.kind)).toEqual([
      "send-accepted",
      "context-overflow",
    ]);
    expect(events[0]?.event).toMatchObject({
      sendIndex: 1,
      cacheDowngradeReason: "too-many-blocks",
    });
    expect(events[1]?.event).toMatchObject({
      cacheDowngradeReason: "too-many-blocks",
    });
  });

  it("refuses an unresolved model as invalid and refuses absent or unready tokenizers as unsupported", async () => {
    const model = harness();
    const modelContext = model.newContext();
    const base = startRequest(TURN_A);
    expect(
      refusalReason(
        await model.owner.start(modelContext.context, {
          ...base,
          route: { ...base.route, model: null },
        }),
      ),
    ).toBe("invalid");
    expect(
      refusalReason(
        await model.owner.start(
          modelContext.context,
          startRequest(uuid(), {
            route: { ...base.route, model: "" },
          }),
        ),
      ),
    ).toBe("invalid");
    expect(model.loads.count).toBe(0);

    const absent = harness({ tokenizer: undefined });
    const absentContext = absent.newContext();
    expect(
      refusalReason(
        await absent.owner.start(absentContext.context, startRequest(TURN_A)),
      ),
    ).toBe("unsupported");
    expect(absent.loads.count).toBe(0);

    const ensureReady = vi.fn(() =>
      Promise.reject(new Error("tokenizer unavailable")),
    );
    const unready = harness({
      tokenizer: {
        kind: "test-per-code-point",
        ensureReady,
        countTokens: (text) => Array.from(text).length,
      },
    });
    const unreadyContext = unready.newContext();
    expect(
      refusalReason(
        await unready.owner.start(unreadyContext.context, startRequest(TURN_A)),
      ),
    ).toBe("unsupported");
    expect(ensureReady).toHaveBeenCalledOnce();
    expect(unready.loads.count).toBe(0);
    expect(unready.appended).toHaveLength(0);
    expect(unready.owner.slotsInUse()).toBe(0);
  });
});

describe("turn owner payload and tokenizer guards", () => {
  it("refuses a system mismatch without reserving the turn, then accepts the corrected request", async () => {
    const h = harness();
    const { context } = h.newContext();
    const valid = startRequest(TURN_A);
    expect(
      refusalReason(
        await h.owner.start(context, {
          ...valid,
          loop: { ...valid.loop, fallbackSystem: "not sent" },
        }),
      ),
    ).toBe("invalid");
    expect(h.appended).toHaveLength(0);
    expect(h.owner.slotsInUse()).toBe(0);

    completed(await h.owner.start(context, valid));
    expect(h.owner.slotsInUse()).toBe(0);
    expect(h.sends).toHaveLength(1);
  });

  it("finds a cancel while tokenizer readiness is pending and writes no audit row", async () => {
    const ready = deferred<void>();
    const h = harness({
      tokenizer: {
        ...createPerCodePointTokenizer(),
        ensureReady: () => ready.promise,
      },
    });
    const { context } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();

    expect(h.owner.cancel(context, { turnId: TURN_A })).toMatchObject({
      status: "ok",
      found: true,
    });
    expect(h.owner.slotsInUse()).toBe(1);
    ready.resolve();
    await expect(started).rejects.toThrow(/MASTRA_AGENT_TURN_CANCELLED/);
    expect(h.appended).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("aborts a sender destroyed during tokenizer readiness without writing an audit row", async () => {
    const ready = deferred<void>();
    const h = harness({
      tokenizer: {
        ...createPerCodePointTokenizer(),
        ensureReady: () => ready.promise,
      },
    });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    c.sender.emit("destroyed");
    await flush();
    try {
      expect(
        await Promise.race([outcome, Promise.resolve("still waiting")]),
      ).toMatch(/MASTRA_AGENT_TURN_ABORTED: sender-gone/);
    } finally {
      ready.resolve();
    }
    expect(h.appended).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("lets user stop win when prepareSend detects a context overflow", async () => {
    const cancellation: { run?: () => void; result?: unknown } = {};
    let cancelled = false;
    const h = harness({
      tokenizer: {
        ...createPerCodePointTokenizer(),
        countTokens(text: string) {
          if (!cancelled && text.includes("x".repeat(50))) {
            cancelled = true;
            cancellation.run?.();
          }
          return Array.from(text).length;
        },
      },
    });
    const { context } = h.newContext();
    cancellation.run = () => {
      cancellation.result = h.owner.cancel(context, { turnId: TURN_A });
    };
    const base = startRequest(TURN_A);
    const started = h.owner.start(
      context,
      startRequest(TURN_A, {
        messages: [
          { role: "system", content: "You write." },
          { role: "user", content: "x".repeat(100) },
        ],
        loop: {
          ...base.loop,
          contextWindow: 128,
          requestMaxOutputTokens: 8,
        },
      }),
    );
    await expect(started).rejects.toThrow(/MASTRA_AGENT_TURN_CANCELLED/);
    expect(cancellation.result).toMatchObject({ status: "ok", found: true });
    expect(h.appended).toHaveLength(0);
    expect(
      progressDeliveries.some(
        ([, , payload]) =>
          (payload as { event?: { kind?: string } }).event?.kind ===
          "context-overflow",
      ),
    ).toBe(false);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("returns a stopped aggregate when Stop races a later context overflow", async () => {
    const cancellation: { run?: () => void; result?: unknown } = {};
    let cancelled = false;
    const h = harness({
      responses: [responseWith("tool_use", "Earlier answer.", ["get_scene"])],
      tokenizer: {
        ...createPerCodePointTokenizer(),
        countTokens(text: string) {
          if (!cancelled && text.includes("x".repeat(50))) {
            cancelled = true;
            cancellation.run?.();
          }
          return Array.from(text).length;
        },
      },
      runTurn: async (input) => {
        const first = await sendPreparedRequest(
          input,
          auditRequestFor(input),
          0,
        );
        const firstToolUse = first.response.blocks.find(
          (block) => block.type === "tool_use",
        );
        if (!firstToolUse) throw new Error("get_scene tool use missing");
        input.onToolResult?.({
          toolCallId: firstToolUse.id,
          tokens: 1,
          toolName: "get_scene",
          summary: "get_scene result",
        });
        await sendPreparedRequest(
          input,
          auditRequestFor(input, [
            ...input.messages,
            { role: "assistant", content: textOf(first.response) },
            {
              role: "tool_result",
              toolUseId: firstToolUse.id,
              content: "result",
            },
            { role: "user", content: "x".repeat(100) },
          ]),
          1,
        );
      },
    });
    const { context } = h.newContext();
    cancellation.run = () => {
      cancellation.result = h.owner.cancel(context, { turnId: TURN_A });
    };
    const base = startRequest(TURN_A);
    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, {
          messages: [
            { role: "system", content: "You write." },
            { role: "user", content: "Continue." },
          ],
          route: { ...base.route, requestMaxOutputTokens: 8 },
          loop: {
            ...base.loop,
            contextWindow: 128,
            requestMaxOutputTokens: 8,
          },
        }),
      ),
    );

    expect(cancellation.result).toMatchObject({ status: "ok", found: true });
    expect(result.loopResult).toMatchObject({
      stoppedReason: "aborted",
      finalText: "Earlier answer.",
      usage: { totalTokens: 1 },
      toolCallRecords: [{ name: "get_scene" }],
    });
    expect(h.sends).toHaveLength(1);
    expect(h.types()).toEqual([
      "execution.started",
      "request.prepared",
      "request.dispatched",
      "response.completed",
      "execution.succeeded",
    ]);
    const events = progressDeliveries.map(
      ([, , payload]) =>
        payload as { event: { kind: string; reason?: string } },
    );
    expect(events.map(({ event }) => event.kind)).toEqual([
      "send-accepted",
      "stopped",
    ]);
    expect(events.at(-1)?.event.reason).toBe("user-stop");
    expect(
      events.filter(({ event }) => event.kind === "context-overflow"),
    ).toHaveLength(0);
    expect(h.terminalsOf()).toHaveLength(1);
  });

  it("uses a tokenizer method with its receiver intact", async () => {
    const tokenizer = {
      kind: "test-per-code-point" as const,
      table: new Map<string, number>(),
      ensureReady: () => Promise.resolve(),
      countTokens(text: string) {
        return this.table.get(text) ?? Array.from(text).length;
      },
    };
    const h = harness({ tokenizer });
    const { context } = h.newContext();

    completed(await h.owner.start(context, startRequest(TURN_A)));
    expect(h.sends).toHaveLength(1);
  });

  it("refuses an unknown tool name directly without throwing or reserving a slot", async () => {
    const h = harness();
    const { context } = h.newContext();

    expect(
      refusalReason(
        await h.owner.start(
          context,
          startRequest(TURN_A, { tools: ["not_a_tool"] as never }),
        ),
      ),
    ).toBe("invalid");
    expect(h.appended).toHaveLength(0);
    expect(h.owner.slotsInUse()).toBe(0);
  });
});

describe("M4 read bindings (T-b)", () => {
  it("refuses a failed read-bindings load before runtime or audit, then retries on the next turn", async () => {
    let failuresLeft = 1;
    const h = harness({
      loadReadBindings: async () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("read bindings unavailable");
        }
        return import("./mastraTurnReadBindings.js");
      },
    });
    const { context } = h.newContext();
    expect(
      refusalReason(
        await h.owner.start(
          context,
          startRequest(TURN_A, { tools: ["get_scene"] }),
        ),
      ),
    ).toBe("unsupported");
    expect(h.appended).toEqual([]);
    expect(h.loads.count).toBe(0);

    completed(
      await h.owner.start(
        context,
        startRequest(uuid(), { tools: ["get_scene"] }),
      ),
    );
    expect(h.readBindingLoads.count).toBe(2);
    expect(h.loads.count).toBe(1);
  });

  it("shares one successful loader call across tool turns", async () => {
    const h = harness();
    const { context } = h.newContext();
    completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, { tools: ["get_scene"] }),
      ),
    );
    completed(
      await h.owner.start(
        context,
        startRequest(uuid(), { tools: ["list_chapters"] }),
      ),
    );
    expect(h.readBindingLoads.count).toBe(1);
  });

  it("does not start when the loader is absent", async () => {
    const h = harness({ loadReadBindings: null });
    const { context } = h.newContext();
    expect(
      refusalReason(
        await h.owner.start(
          context,
          startRequest(TURN_A, { tools: ["get_scene"] }),
        ),
      ),
    ).toBe("unsupported");
    expect(h.readBindingLoads.count).toBe(0);
    expect(h.loads.count).toBe(0);
    expect(h.appended).toEqual([]);
  });

  it("checks user Stop after the read-bindings loader settles", async () => {
    const module = deferred<typeof import("./mastraTurnReadBindings.js")>();
    const h = harness({ loadReadBindings: () => module.promise });
    const { context } = h.newContext();
    const started = h.owner.start(
      context,
      startRequest(TURN_A, { tools: ["get_scene"] }),
    );
    await flush();
    expect(h.owner.cancel(context, { turnId: TURN_A })).toMatchObject({
      status: "ok",
      found: true,
    });
    module.resolve(await import("./mastraTurnReadBindings.js"));
    await expect(started).rejects.toThrow(/MASTRA_AGENT_TURN_CANCELLED/);
    expect(h.loads.count).toBe(0);
    expect(h.appended).toEqual([]);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("forced-aborts while the read-bindings loader is pending without writing audit rows", async () => {
    const module = deferred<typeof import("./mastraTurnReadBindings.js")>();
    const h = harness({ loadReadBindings: () => module.promise });
    const { context, sender } = h.newContext();
    const started = h.owner.start(
      context,
      startRequest(TURN_A, { tools: ["get_scene"] }),
    );
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    sender.emit("destroyed");
    await flush();
    expect(
      await Promise.race([outcome, Promise.resolve("still waiting")]),
    ).toMatch(/MASTRA_AGENT_TURN_ABORTED: sender-gone/);
    module.resolve(await import("./mastraTurnReadBindings.js"));
    await flush();
    expect(h.loads.count).toBe(0);
    expect(h.appended).toEqual([]);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("runs only selected shared-core tools through the Main adapters, preserves legacy result text and records, and reports batch counters", async () => {
    const title = `Scene ${"x".repeat(180)}`;
    const chapterContent = [
      {
        id: "scene-1",
        parentId: null,
        nodeType: "scene",
        title,
        status: "outline",
      },
    ];
    const chapterText = JSON.stringify(chapterContent);
    const tokenBudget = 400;
    const truncatedChapterText = `${chapterText.slice(0, 100)}...[truncated: 元 ${chapterText.length} tokens]`;
    const responses: AgentWireResponse[] = [
      {
        blocks: [
          { type: "text", content: "Reading." },
          {
            type: "tool_use",
            id: "tool-call-scene",
            name: "get_scene",
            input: {},
          },
          {
            type: "tool_use",
            id: "tool-call-chapters",
            name: "list_chapters",
            input: {},
          },
        ],
        stopReason: "tool_use",
        inputTokens: 5,
        outputTokens: 2,
        cost: 0.1,
      },
      {
        blocks: [{ type: "text", content: "Done." }],
        stopReason: "end_turn",
        inputTokens: 7,
        outputTokens: 3,
        cost: 0.2,
      },
    ];
    const h = harness({
      responses,
      runTurn: async (input) => {
        expect(input.bindings?.map(({ name }) => name)).toEqual([
          "get_scene",
          "list_chapters",
        ]);
        return driveCoreReadOwnerLoop(input);
      },
      readDbExecute: mainReadFixture(title),
    });
    const { context } = h.newContext();
    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, {
          tools: ["get_scene", "list_chapters"],
          loop: { ...startRequest(TURN_A).loop, tokenBudget },
        }),
      ),
    );
    const ownerLoop = result.loopResult;
    expect(ownerLoop).toBeDefined();
    expect(ownerLoop?.stoppedReason).toBe("completed");
    expect(ownerLoop?.finalText).toBe("Reading.Done.");
    expect(ownerLoop?.toolCallRecords).toEqual([
      {
        name: "get_scene",
        params: {},
        resultSummary: "No id provided",
        tokensUsed: 0,
      },
      {
        name: "list_chapters",
        params: {},
        resultSummary: "1 nodes (parts/chapters/scenes)",
        tokensUsed: chapterText.length,
      },
    ]);
    expect(ownerLoop?.usage).toEqual({
      totalTokens: chapterText.length,
      tokensIn: 12,
      tokensOut: 5,
      cost: 0.1 + 0.2,
    });
    expect(
      h.dbQueries.filter(({ sql }) => sql !== CHAT_POLICY_SQL),
    ).toHaveLength(3);
    expect(
      h.dbQueries.filter(({ sql }) => sql === CHAT_POLICY_SQL),
    ).toHaveLength(2);
    expect(h.sends).toHaveLength(2);
    expect(h.sends[0]?.args.tools?.map(({ name }) => name)).toEqual([
      "get_scene",
      "list_chapters",
    ]);
    const toolResults = h.sends[1]?.args.messages.filter(
      (message) => message.role === "tool_result",
    );
    expect(toolResults?.map(({ content }) => content)).toEqual([
      "No id provided",
      truncatedChapterText,
    ]);
    const events = progressDeliveries.map(
      ([, , payload]) => payload as { event: Record<string, unknown> },
    );
    expect(
      events.map(({ event }) => event).filter((event) => event.kind === "tool"),
    ).toEqual([
      {
        kind: "tool",
        phase: "started",
        toolCallId: "tool-call-scene",
        toolName: "get_scene",
        totalCalls: 2,
        maxCalls: 10,
        tokensUsed: 0,
        tokenBudget,
      },
      {
        kind: "tool",
        phase: "finished",
        toolCallId: "tool-call-scene",
        toolName: "get_scene",
        totalCalls: 2,
        maxCalls: 10,
        tokensUsed: 0,
        tokenBudget,
      },
      {
        kind: "tool",
        phase: "started",
        toolCallId: "tool-call-chapters",
        toolName: "list_chapters",
        totalCalls: 2,
        maxCalls: 10,
        tokensUsed: 0,
        tokenBudget,
      },
      {
        kind: "tool",
        phase: "finished",
        toolCallId: "tool-call-chapters",
        toolName: "list_chapters",
        totalCalls: 2,
        maxCalls: 10,
        tokensUsed: chapterText.length,
        tokenBudget,
      },
    ]);

    const legacy = await runLegacyLoop({
      responses,
      tokenBudget,
      maxToolCalls: 10,
      maxUserQuestions: 8,
      executeTool: async (name, toolCallId, params) => ({
        name,
        toolCallId,
        params,
        content: name === "list_chapters" ? chapterContent : null,
        summary:
          name === "list_chapters"
            ? "1 nodes (parts/chapters/scenes)"
            : "No id provided",
        tokensUsed: name === "list_chapters" ? chapterText.length : 0,
      }),
    });
    expect(ownerLoop?.stoppedReason).toBe(legacy.result.stoppedReason);
    expect(ownerLoop?.toolCallRecords).toEqual(legacy.result.toolCallRecords);
    expect(ownerLoop?.usage).toEqual({
      totalTokens: legacy.result.toolCallRecords.reduce(
        (total, record) => total + record.tokensUsed,
        0,
      ),
      tokensIn: legacy.result.tokensIn,
      tokensOut: legacy.result.tokensOut,
      cost: legacy.result.cost,
    });
    expect(ownerLoop?.finalText).toBe(legacy.textChunks.join(""));
    expect(
      h.sends.map(({ args }) =>
        args.messages.filter((message) => message.role !== "system"),
      ),
    ).toEqual(legacy.sentMessages);
  });

  it("keeps selected binding order when UI and read tools are interleaved", async () => {
    const tools = ["run_app_command", "get_scene"] as const;
    const h = harness({
      runTurn: async (input) => {
        expect(input.bindings?.map(({ name }) => name)).toEqual(tools);
        await sendPreparedRequest(input, auditRequestFor(input), 0);
      },
    });
    const { context } = h.newContext();
    await h.owner.start(context, startRequest(TURN_A, { tools }));
  });

  it("passes null, array, string, and number tool inputs through like the legacy executor", async () => {
    // The renderer's legacy dispatcher invokes this shared executor without input normalization.
    const legacyGetScene = createReadExecutors({
      getDb: () => {
        throw new Error("unexpected DB read for an empty id");
      },
      getTreeState: () => ({
        projectId: PROJECT_ID,
        nodes: [],
        activeSceneId: "scene-1",
      }),
      countTokens: (text: string) => text.length,
    } as unknown as CoreReadContext).get_scene;
    const readBindings = await import("./mastraTurnReadBindings.js");
    const { bindings } = await readBindings.createTurnReadBindings({
      backend: {
        async dbExecute() {
          return readAnswer();
        },
      } as unknown as NapiBackendLike,
      identity: { senderId: 7, workspaceId: WORKSPACE } as never,
      hooks: {},
      request: {
        ...startRequest(TURN_A, { tools: ["get_scene"] }),
        tools: ["get_scene"],
      },
      projectId: PROJECT_ID,
      currentSceneId: "scene-1",
      tokenizer: createPerCodePointTokenizer(),
      toolDefinitions: [{ name: "get_scene", description: "scene" }],
    });
    const mainGetScene = bindings[0]!;
    for (const params of [null, [], "raw", 7]) {
      const [main, legacy] = await Promise.allSettled([
        mainGetScene.execute(params, {
          toolCallId: "input-shape",
          signal: new AbortController().signal,
        }),
        legacyGetScene(params as never),
      ]);
      expect(main.status).toBe(legacy.status);
      if (main.status === "fulfilled" && legacy.status === "fulfilled") {
        expect(main.value).toEqual({
          text:
            legacy.value.content == null
              ? legacy.value.summary || "No result (not found)."
              : JSON.stringify(legacy.value.content),
          tokensUsed: legacy.value.tokensUsed,
          summary: legacy.value.summary,
        });
      } else if (main.status === "rejected" && legacy.status === "rejected") {
        expect((main.reason as Error).message).toBe(
          (legacy.reason as Error).message,
        );
      }
    }
  });

  it("does not let a non-object get_codex_entry input throw in the injected-entry shortcut", async () => {
    const h = harness({
      responses: [
        {
          blocks: [
            {
              type: "tool_use",
              id: "injected-null",
              name: "get_codex_entry",
              input: null as unknown as Record<string, unknown>,
            },
          ],
          stopReason: "tool_use",
        },
        {
          blocks: [{ type: "text", content: "Done." }],
          stopReason: "end_turn",
        },
      ],
      runTurn: driveCoreReadOwnerLoop,
    });
    const { context } = h.newContext();
    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, {
          fullyInjectedIds: ["injected-entry"],
          tools: ["get_codex_entry"],
        }),
      ),
    );

    expect(result.loopResult?.stoppedReason).toBe("completed");
    expect(h.sends[1]?.args.messages).toContainEqual({
      role: "tool_result",
      toolUseId: "injected-null",
      content: "No id provided",
      isError: false,
    });
  });

  it("drops a read result when user Stop arrives after execution without recording or finishing it", async () => {
    let stop = (): void => undefined;
    let executions = 0;
    const h = harness({
      responses: [
        {
          blocks: [
            {
              type: "tool_use",
              id: "stop-after-read",
              name: "get_scene",
              input: {},
            },
          ],
          stopReason: "tool_use",
        },
      ],
      readDbExecute: mainReadFixture("Scene"),
      runTurn: async (input) => {
        const bindings = input.bindings?.map((binding) =>
          binding.name === "get_scene"
            ? {
                ...binding,
                async execute(
                  args: unknown,
                  ctx: {
                    toolCallId: string;
                    signal: AbortSignal;
                  },
                ) {
                  executions += 1;
                  const result = await binding.execute(args, ctx);
                  stop();
                  return result;
                },
              }
            : binding,
        );
        await driveCoreReadOwnerLoop({ ...input, bindings });
      },
    });
    const { context } = h.newContext();
    stop = () => h.owner.cancel(context, { turnId: TURN_A } as never);

    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, { tools: ["get_scene"] }),
      ),
    );
    const toolEvents = progressDeliveries
      .map(
        ([, , payload]) =>
          (payload as { event: Record<string, unknown> }).event,
      )
      .filter((event) => event.kind === "tool");

    expect(executions).toBe(1);
    expect(result.loopResult).toMatchObject({
      stoppedReason: "aborted",
      toolCallRecords: [],
      usage: { totalTokens: 0 },
    });
    expect(toolEvents.map(({ phase }) => phase)).toEqual(["started"]);
    expect(h.sends).toHaveLength(1);
    expect(JSON.stringify(h.sends)).not.toContain(
      "Tool execution skipped because the turn stopped.",
    );
  });

  it("rejects a tool at the execution boundary after the owner's limit removes its declaration", async () => {
    const responses: AgentWireResponse[] = [
      {
        blocks: [
          { type: "tool_use", id: "first-call", name: "get_scene", input: {} },
        ],
        stopReason: "tool_use",
      },
      {
        blocks: [
          {
            type: "tool_use",
            id: "after-limit-call",
            name: "get_scene",
            input: {},
          },
        ],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "text", content: "Done." }], stopReason: "end_turn" },
    ];
    const h = harness({
      responses,
      runTurn: async (input) => {
        const binding = input.bindings?.find(
          ({ name }) => name === "get_scene",
        );
        if (!binding) throw new Error("get_scene binding missing");
        const execution = vi.spyOn(binding, "execute");
        await driveCoreReadOwnerLoop(input, true);
        expect(execution).toHaveBeenCalledTimes(1);
      },
    });
    const { context } = h.newContext();
    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, {
          tools: ["get_scene"],
          loop: { ...startRequest(TURN_A).loop, maxToolCalls: 1 },
        }),
      ),
    );

    expect(result.loopResult?.stoppedReason).toBe("limit_calls");
    expect(
      h.sends[2]?.args.messages.filter(
        (message) => message.role === "tool_result",
      ),
    ).toContainEqual({
      role: "tool_result",
      toolUseId: "after-limit-call",
      content: "Error: Tool not available this turn: get_scene",
      isError: true,
    });
  });

  it("short-circuits a fully injected entry with the legacy handler result", async () => {
    const content = alreadyInjectedCodexEntryContent("injected-entry");
    const legacy = {
      name: "get_codex_entry",
      content,
      summary: ALREADY_INJECTED_CODEX_ENTRY_SUMMARY,
      tokensUsed: JSON.stringify(content).length,
    };
    let toolQueriesAtRun = 0;
    const toolQueryCount = (): number =>
      h.dbQueries.filter(({ sql }) => sql !== CHAT_POLICY_SQL).length;
    const h = harness({
      responses: [
        {
          blocks: [
            {
              type: "tool_use",
              id: "injected-call",
              name: "get_codex_entry",
              input: { id: "injected-entry" },
            },
          ],
          stopReason: "tool_use",
        },
        {
          blocks: [{ type: "text", content: "Done." }],
          stopReason: "end_turn",
        },
      ],
      runTurn: async (input) => {
        toolQueriesAtRun = toolQueryCount();
        await driveCoreReadOwnerLoop(input);
      },
    });
    const { context } = h.newContext();
    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, {
          fullyInjectedIds: ["injected-entry"],
          tools: ["get_codex_entry"],
        }),
      ),
    );

    expect(toolQueryCount()).toBe(toolQueriesAtRun);
    expect(h.sends[1]?.args.messages).toContainEqual({
      role: "tool_result",
      toolUseId: "injected-call",
      content: JSON.stringify(legacy.content),
      isError: false,
    });
    expect(result.loopResult?.toolCallRecords).toEqual([
      {
        name: legacy.name,
        params: { id: "injected-entry" },
        resultSummary: legacy.summary,
        tokensUsed: legacy.tokensUsed,
      },
    ]);
  });

  it("checks chat policy without loading read ports when request.tools is empty", async () => {
    const h = harness({
      runTurn: async (input) => {
        expect(input.bindings).toEqual([]);
        await sendPreparedRequest(input, auditRequestFor(input), 0);
      },
    });
    const { context } = h.newContext();
    completed(await h.owner.start(context, startRequest(TURN_A)));
    expect(h.dbQueries.map(({ sql }) => sql)).toEqual([CHAT_POLICY_SQL]);
    expect(h.readBindingLoads.count).toBe(0);
  });

  it("applies user Stop to an in-flight Main read without recording a tool error", async () => {
    let readCallCount = 0;
    const readStarted = deferred<void>();
    const nativeRead = deferred<string>();
    const h = harness({
      responses: [responseWith("tool_use", "lookup", ["list_chapters"])],
      runTurn: driveCoreReadOwnerLoop,
      readDbExecute: async () => {
        readCallCount += 1;
        if (readCallCount === 3) {
          readStarted.resolve();
          return nativeRead.promise;
        }
        return readAnswer();
      },
    });
    const { context } = h.newContext();
    const started = h.owner.start(
      context,
      startRequest(TURN_A, { tools: ["list_chapters"] }),
    );
    await readStarted.promise;
    expect(h.owner.readsInFlight()).toBe(1);
    expect(h.owner.cancel(context, { turnId: TURN_A })).toMatchObject({
      status: "ok",
      found: true,
    });
    nativeRead.resolve(readAnswer());
    const result = completed(await started);
    await flush();
    expect(result.loopResult).toMatchObject({
      stoppedReason: "aborted",
      toolCallRecords: [],
    });
    const events = progressDeliveries.map(
      ([, , payload]) => (payload as { event: Record<string, unknown> }).event,
    );
    expect(
      events
        .filter((event) => event.kind === "tool")
        .map((event) => event.phase),
    ).toEqual(["started"]);
    expect(
      events.filter(
        (event) => event.kind === "stopped" && event.reason === "user-stop",
      ),
    ).toHaveLength(1);
    expect(h.sends).toHaveLength(1);
    expect(h.owner.readsInFlight()).toBe(0);
  });

  it("applies a forced abort to an in-flight Main read and ignores its late completion", async () => {
    let readCallCount = 0;
    const readStarted = deferred<void>();
    const nativeRead = deferred<string>();
    const h = harness({
      responses: [responseWith("tool_use", "lookup", ["list_chapters"])],
      runTurn: driveCoreReadOwnerLoop,
      readDbExecute: async () => {
        readCallCount += 1;
        if (readCallCount === 3) {
          readStarted.resolve();
          return nativeRead.promise;
        }
        return readAnswer();
      },
    });
    const { context, sender } = h.newContext();
    const outcome = h.owner
      .start(context, startRequest(TURN_A, { tools: ["list_chapters"] }))
      .then(
        () => "resolved",
        (error: Error) => error.message,
      );
    await readStarted.promise;
    expect(h.owner.readsInFlight()).toBe(1);
    sender.emit("destroyed");
    expect(await outcome).toMatch(/ABORTED: sender-gone/);
    const eventCount = progressDeliveries.length;
    nativeRead.resolve(readAnswer());
    await flush();
    expect(h.owner.readsInFlight()).toBe(0);
    expect(progressDeliveries).toHaveLength(eventCount);
  });

  it("keeps typed Native hooks through a user Stop and drops the in-flight result", async () => {
    const readStarted = deferred<void>();
    const nativeRead = deferred<string>();
    const h = harness({
      responses: [
        {
          blocks: [
            {
              type: "tool_use",
              id: "native-call",
              name: "search_events",
              input: { query: "arrival" },
            },
          ],
          stopReason: "tool_use",
        },
      ],
      nativeReadMethods: {
        eventsSemanticSearch: async () => {
          readStarted.resolve();
          return nativeRead.promise;
        },
      },
      runTurn: driveCoreReadOwnerLoop,
    });
    const { context } = h.newContext();
    const started = h.owner.start(
      context,
      startRequest(TURN_A, { tools: ["search_events"] }),
    );
    await readStarted.promise;
    expect(h.owner.readsInFlight()).toBe(1);
    expect(h.owner.cancel(context, { turnId: TURN_A })).toMatchObject({
      status: "ok",
      found: true,
    });
    nativeRead.resolve(JSON.stringify([]));
    const result = completed(await started);

    expect(result.loopResult).toMatchObject({
      stoppedReason: "aborted",
      toolCallRecords: [],
    });
    expect(h.owner.readsInFlight()).toBe(0);
    const events = progressDeliveries.map(
      ([, , payload]) => (payload as { event: Record<string, unknown> }).event,
    );
    expect(
      events
        .filter((event) => event.kind === "tool")
        .map((event) => event.phase),
    ).toEqual(["started"]);
  });

  it("keeps typed Native hooks through a forced abort and ignores the late result", async () => {
    const readStarted = deferred<void>();
    const nativeRead = deferred<string>();
    const h = harness({
      responses: [
        {
          blocks: [
            {
              type: "tool_use",
              id: "native-call",
              name: "search_events",
              input: { query: "arrival" },
            },
          ],
          stopReason: "tool_use",
        },
      ],
      nativeReadMethods: {
        eventsSemanticSearch: async () => {
          readStarted.resolve();
          return nativeRead.promise;
        },
      },
      runTurn: driveCoreReadOwnerLoop,
    });
    const { context, sender } = h.newContext();
    const outcome = h.owner
      .start(context, startRequest(TURN_A, { tools: ["search_events"] }))
      .then(
        () => "resolved",
        (error: Error) => error.message,
      );
    await readStarted.promise;
    expect(h.owner.readsInFlight()).toBe(1);
    sender.emit("destroyed");
    expect(await outcome).toMatch(/ABORTED: sender-gone/);
    expect(h.owner.readsInFlight()).toBe(1);
    const eventCount = progressDeliveries.length;
    nativeRead.resolve(JSON.stringify([]));
    await flush();

    expect(h.owner.readsInFlight()).toBe(0);
    expect(progressDeliveries).toHaveLength(eventCount);
    expect(h.terminalsOf()).toHaveLength(1);
  });
});

describe("loop results (R2-b2)", () => {
  it("matches legacy stop reasons, records, text, usage, and control-message position", async () => {
    const cite = {
      url: "https://example.test/source",
      title: "source",
      citedText: "quote",
    };
    const scenarios = [
      {
        name: "call cap counts an over-limit tool batch and suppresses final tool use",
        responses: [
          responseWith("tool_use", "first", ["get_scene", "search_events"], {
            inputTokens: 2,
            outputTokens: 3,
            cost: 0.25,
            citations: [cite],
          }),
          responseWith("tool_use", "last", ["get_scene"], {
            inputTokens: 4,
            outputTokens: 5,
            cost: 0.75,
            citations: [cite],
            blocks: [
              { type: "text", content: "last" },
              { type: "thinking", content: "final thought", signature: "sig" },
              {
                type: "tool_use",
                id: "tool-final",
                name: "get_scene",
                input: {},
              },
            ],
          }),
        ],
        limits: { tokenBudget: 100, maxToolCalls: 1, maxUserQuestions: 8 },
        tools: ["get_scene", "search_events"],
        stoppedReason: "limit_calls",
        control: "calls",
      },
      {
        name: "question limit keeps priority when all three caps are reached",
        responses: [
          responseWith("tool_use", "question", ["ask_user", "get_scene"]),
          responseWith("end_turn", "answered"),
        ],
        limits: { tokenBudget: 1, maxToolCalls: 1, maxUserQuestions: 1 },
        tools: ["get_scene"],
        stoppedReason: "limit_questions",
        control: "questions",
      },
      {
        name: "completed tool-result tokens select the token control",
        responses: [
          responseWith("tool_use", "lookup", ["get_scene"]),
          responseWith("end_turn", "finished"),
        ],
        limits: { tokenBudget: 1, maxToolCalls: 8, maxUserQuestions: 8 },
        tools: ["get_scene"],
        stoppedReason: "limit_tokens",
        control: "tokens",
      },
      {
        name: "a tool-use block on a non-tool stop reason is ignored",
        responses: [responseWith("end_turn", "text only", ["get_scene"])],
        limits: { tokenBudget: 100, maxToolCalls: 8, maxUserQuestions: 8 },
        tools: ["get_scene"],
        stoppedReason: "completed",
        control: null,
      },
      {
        name: "a plain text-only answer completes",
        responses: [responseWith("end_turn", "plain text")],
        limits: { tokenBudget: 100, maxToolCalls: 8, maxUserQuestions: 8 },
        tools: [],
        stoppedReason: "completed",
        control: null,
      },
    ];

    for (const scenario of scenarios) {
      const h = harness({
        responses: scenario.responses,
        runTurn: driveOwnerLoop,
      });
      const { context } = h.newContext();
      const ownerResult = completed(
        await h.owner.start(
          context,
          startRequest(TURN_A, {
            tools: scenario.tools as MastraAgentTurnStartRequest["tools"],
            loop: { ...startRequest(TURN_A).loop, ...scenario.limits },
          }),
        ),
      );
      const ownerLoop = ownerResult.loopResult;
      expect(ownerLoop, scenario.name).toBeDefined();
      const legacy = await runLegacyLoop({
        responses: scenario.responses,
        ...scenario.limits,
      });

      expect(ownerLoop?.stoppedReason, scenario.name).toBe(
        legacy.result.stoppedReason,
      );
      expect(ownerLoop?.stoppedReason, scenario.name).toBe(
        scenario.stoppedReason,
      );
      expect(
        ownerLoop?.toolCallRecords.map(({ name, params }) => ({
          name,
          params,
        })),
        scenario.name,
      ).toEqual(
        legacy.result.toolCallRecords.map(({ name, params }) => ({
          name,
          params,
        })),
      );
      expect(ownerLoop?.finalText, scenario.name).toBe(
        legacy.textChunks.join(""),
      );
      expect(ownerLoop?.usage, scenario.name).toEqual({
        totalTokens: legacy.result.toolCallRecords.reduce(
          (total, record) => total + record.tokensUsed,
          0,
        ),
        tokensIn: legacy.result.tokensIn,
        tokensOut: legacy.result.tokensOut,
        cost: legacy.result.cost,
      });
      expect(ownerLoop?.citations, scenario.name).toEqual(
        legacy.result.citations,
      );
      expect(ownerLoop?.finalThinkingBlocks, scenario.name).toEqual(
        legacy.result.finalThinkingBlocks,
      );
      expect(h.sends, scenario.name).toHaveLength(legacy.sentMessages.length);
      const ownerFinalMessages = h.sends
        .at(-1)
        ?.args.messages.filter((message) => message.role !== "system");
      if (scenario.control === null) {
        expect(
          ownerFinalMessages?.some(
            (message) =>
              message.role === "user" &&
              ["calls", "tokens", "questions"].includes(message.content),
          ),
        ).toBe(false);
      } else {
        const ownerControls = ownerFinalMessages?.filter(
          (message) =>
            message.role === "user" && message.content === scenario.control,
        );
        const legacyControls = legacy.sentMessages
          .at(-1)
          ?.filter(
            (message): message is { role: string; content: string } =>
              typeof message === "object" &&
              message !== null &&
              "role" in message &&
              "content" in message,
          )
          .filter(
            (message) =>
              message.role === "user" && message.content === scenario.control,
          );
        expect(ownerControls, scenario.name).toHaveLength(1);
        expect(
          ownerFinalMessages?.findIndex(
            (message) =>
              message.role === "user" && message.content === scenario.control,
          ),
          scenario.name,
        ).toBe(
          legacy.sentMessages
            .at(-1)
            ?.findIndex(
              (message) =>
                typeof message === "object" &&
                message !== null &&
                "role" in message &&
                "content" in message &&
                message.role === "user" &&
                message.content === scenario.control,
            ),
        );
        expect(ownerFinalMessages?.at(-1), scenario.name).toMatchObject({
          role: "user",
          content: scenario.control,
        });
        expect(legacyControls, scenario.name).toHaveLength(1);
        expect(legacy.sentMessages.at(-1)?.at(-1), scenario.name).toMatchObject(
          {
            role: "user",
            content: scenario.control,
          },
        );
      }
    }
  });

  it("adds control once, then keeps later sends tool-free", async () => {
    const declaredTools: AgentAuditRequest["tools"] = [
      {
        name: "get_scene",
        description: "",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];
    const responses = [
      responseWith("tool_use", "first", ["get_scene", "search_events"]),
      responseWith("tool_use", "after control", ["get_scene"]),
      responseWith("end_turn", "last"),
    ];
    const h = harness({
      responses,
      runTurn: async (input) => {
        let messages: AgentAuditRequest["messages"] = [...input.messages];
        const request = {
          ...auditRequestFor(input, messages),
          tools: declaredTools,
        };
        const { response } = await sendPreparedRequest(input, request, 0);
        messages.push({ role: "assistant", content: textOf(response) });
        messages.push({
          role: "tool_result",
          toolUseId: "used-1",
          content: "result",
        });
        input.onToolResult?.({
          toolCallId: "call-1",
          tokens: 0,
          toolName: "get_scene",
          summary: "get_scene result",
        });

        const secondRequest = auditRequestFor(input, messages);
        const second = await sendPreparedRequest(
          input,
          { ...secondRequest, tools: declaredTools },
          1,
        );
        expect(h.sends[0]?.args.tools).toEqual(declaredTools);
        expect(
          second.prepared.messages.filter(
            (message) => message.role === "user" && message.content === "calls",
          ),
        ).toHaveLength(1);
        expect(second.prepared.tools).toEqual([]);
        messages = second.prepared.messages.slice(1);

        const third = await sendPreparedRequest(
          input,
          { ...auditRequestFor(input, messages), tools: declaredTools },
          2,
        );
        expect(
          third.prepared.messages.filter(
            (message) => message.role === "user" && message.content === "calls",
          ),
        ).toHaveLength(1);
        expect(third.prepared.tools).toEqual([]);
      },
    });
    const { context } = h.newContext();
    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, {
          tools: ["get_scene", "search_events"],
          loop: { ...startRequest(TURN_A).loop, maxToolCalls: 1 },
        }),
      ),
    );
    expect(result.loopResult?.stoppedReason).toBe("limit_calls");
    expect(h.sends).toHaveLength(3);
  });

  it("reports a limit reached by the final response even when the runtime ends without another send", async () => {
    const h = harness({
      responses: [responseWith("tool_use", "lookup", ["get_scene"])],
      runTurn: async (input) => {
        await sendPreparedRequest(input, auditRequestFor(input), 0);
        input.onToolResult?.({
          toolCallId: "call-1",
          tokens: 1,
          toolName: "get_scene",
          summary: "get_scene result",
        });
      },
    });
    const { context } = h.newContext();
    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, {
          tools: ["get_scene"],
          loop: { ...startRequest(TURN_A).loop, tokenBudget: 1 },
        }),
      ),
    );

    expect(result.loopResult).toMatchObject({
      stoppedReason: "limit_tokens",
      usage: { totalTokens: 1 },
    });
    expect(h.sends).toHaveLength(1);
  });

  it("rejects invalid tool-result tokens synchronously without changing loop state", async () => {
    const invalidTokens = [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY];
    const h = harness({
      runTurn: async (input) => {
        await sendPreparedRequest(input, auditRequestFor(input), 0);
        for (const tokens of invalidTokens) {
          expect(() =>
            input.onToolResult?.({
              toolCallId: "call-1",
              tokens,
              toolName: "get_scene",
              summary: "get_scene result",
            }),
          ).toThrow("MASTRA_AGENT_TOOL_RESULT_TOKENS_INVALID");
        }
        input.onToolResult?.({
          toolCallId: "call-1",
          tokens: 0,
          toolName: "get_scene",
          summary: "get_scene result",
        });
      },
    });
    const { context } = h.newContext();
    const base = startRequest(TURN_A);
    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, {
          loop: { ...base.loop, tokenBudget: 1 },
        }),
      ),
    );

    expect(result.loopResult).toMatchObject({
      stoppedReason: "completed",
      usage: { totalTokens: 0 },
    });
  });

  it("records a duplicate callback for one toolCallId only once", async () => {
    const h = harness({
      responses: [
        {
          blocks: [
            {
              type: "tool_use",
              id: "duplicate-call",
              name: "get_scene",
              input: { id: "scene-1" },
            },
          ],
          stopReason: "tool_use",
        },
      ],
      runTurn: async (input) => {
        await sendPreparedRequest(input, auditRequestFor(input), 0);
        input.onToolStart?.({
          toolCallId: "duplicate-call",
          toolName: "get_scene",
        });
        input.onToolResult?.({
          toolCallId: "duplicate-call",
          toolName: "get_scene",
          tokens: 7,
          summary: "first result",
        });
        input.onToolResult?.({
          toolCallId: "duplicate-call",
          toolName: "get_scene",
          tokens: 11,
          summary: "duplicate result",
        });
      },
    });
    const { context } = h.newContext();
    const result = completed(
      await h.owner.start(
        context,
        startRequest(TURN_A, { tools: ["get_scene"] }),
      ),
    );

    expect(result.loopResult?.toolCallRecords).toEqual([
      {
        name: "get_scene",
        params: { id: "scene-1" },
        resultSummary: "first result",
        tokensUsed: 7,
      },
    ]);
    expect(result.loopResult?.usage.totalTokens).toBe(7);
    const toolEvents = progressDeliveries
      .map(
        ([, , payload]) =>
          (payload as { event: Record<string, unknown> }).event,
      )
      .filter((event) => event.kind === "tool");
    expect(toolEvents.map((event) => event.phase)).toEqual([
      "started",
      "finished",
    ]);
  });
});

describe("re-entry and limits (DR-MP3-4)", () => {
  it("one turn per sender and chat session: a second is `busy`; another session of the same sender runs", async () => {
    const h = harness({ native: "hold" });
    const { context } = h.newContext();
    const first = h.owner.start(
      context,
      startRequest(TURN_A, { chatSessionId: "s1" }),
    );
    first.catch(() => undefined);
    await flush();
    expect(
      refusalReason(
        await h.owner.start(
          context,
          startRequest(uuid(), { chatSessionId: "s1" }),
        ),
      ),
    ).toBe("busy");
    // The same turn ID is not accepted twice either.
    expect(
      refusalReason(
        await h.owner.start(
          context,
          startRequest(TURN_A, { chatSessionId: "s2" }),
        ),
      ),
    ).toBe("busy");
    const other = h.owner.start(
      context,
      startRequest(uuid(), { chatSessionId: "s2" }),
    );
    other.catch(() => undefined);
    await flush();
    expect(h.owner.activeTurnCount()).toBe(2);
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    completed(await first);
    completed(await other);
    // Free again once finished.
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it(`at most ${MASTRA_TURN_PER_SENDER_MAX} turns per sender and ${MASTRA_TURN_TOTAL_MAX} in all`, async () => {
    const h = harness({ native: "hold" });
    const single = h.newContext();
    const running: Promise<unknown>[] = [];
    for (let i = 0; i < MASTRA_TURN_PER_SENDER_MAX; i += 1) {
      const started = h.owner.start(
        single.context,
        startRequest(uuid(), { chatSessionId: `s${i}` }),
      );
      started.catch(() => undefined);
      running.push(started);
    }
    await flush();
    expect(
      refusalReason(
        await h.owner.start(
          single.context,
          startRequest(uuid(), { chatSessionId: "over" }),
        ),
      ),
    ).toBe("busy");
    // Other senders fill the rest; the total stops the next.
    for (
      let i = 0;
      i < MASTRA_TURN_TOTAL_MAX - MASTRA_TURN_PER_SENDER_MAX;
      i += 1
    ) {
      const other = h.newContext();
      const started = h.owner.start(other.context, startRequest(uuid()));
      started.catch(() => undefined);
      running.push(started);
    }
    await flush();
    expect(h.owner.slotsInUse()).toBe(MASTRA_TURN_TOTAL_MAX);
    const last = h.newContext();
    expect(
      refusalReason(await h.owner.start(last.context, startRequest(uuid()))),
    ).toBe("busy");
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    await Promise.all(running);
    expect(h.owner.slotsInUse()).toBe(0);
  });
});

describe("user-stop (a cancel; DR-MP3-6)", () => {
  it("before the dispatch: no send, one `execution.cancelled` terminal with no ambiguous mark, and the start ends as cancelled", async () => {
    const h = harness({ native: "hold" });
    const { context } = h.newContext();
    // The append of the begin batch is held so the cancel lands before the dispatch.
    h.appendBehavior.hang = deferred<void>();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    expect(h.owner.cancel(context, { turnId: TURN_A })).toEqual({
      status: "ok",
      turnId: TURN_A,
      found: true,
    });
    h.appendBehavior.hang.resolve();
    await expect(started).rejects.toThrow(/MASTRA_AGENT_TURN_CANCELLED/);
    expect(h.sends).toHaveLength(0);
    expect(h.types()).toEqual([
      "execution.started",
      "request.prepared",
      "execution.cancelled",
    ]);
    expect(h.terminalsOf()[0]?.payload).not.toHaveProperty("remoteOutcome");
  });

  it("stopped while the runtime loads: no row at all, and the runtime is not run", async () => {
    const gate = deferred<void>();
    const h = harness({
      loadRuntime: async () => {
        await gate.promise;
        return {
          createMastraAgentRuntime: () => ({
            runTurn: () => Promise.reject(new Error("must not run")),
          }),
        };
      },
    });
    const { context } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    expect(
      (h.owner.cancel(context, { turnId: TURN_A }) as { found: boolean }).found,
    ).toBe(true);
    gate.resolve();
    await expect(started).rejects.toThrow(/MASTRA_AGENT_TURN_CANCELLED/);
    expect(h.appended).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  });

  it("after the dispatch the send is not cut: the turn completes normally", async () => {
    const h = harness({ native: "hold" });
    const { context } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    expect(h.sends).toHaveLength(1);
    expect(
      (h.owner.cancel(context, { turnId: TURN_A }) as { found: boolean }).found,
    ).toBe(true);
    h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
    completed(await started);
    expect(h.types()).toContain("execution.succeeded");
  });

  it("returns an aborted aggregate when Stop lands between sends", async () => {
    const h = harness({
      native: "hold",
      runTurn: async (input) => {
        const request = auditRequestFor(input);
        await sendPreparedRequest(input, request, 0);
        await sendPreparedRequest(input, request, 1);
      },
    });
    const { context } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    expect(h.sends).toHaveLength(1);
    expect(h.owner.cancel(context, { turnId: TURN_A })).toMatchObject({
      status: "ok",
      found: true,
    });
    const partial = responseWith("tool_use", "partial", ["get_scene"]);
    h.nativeSends[0]!.resolve(JSON.stringify(partial));

    const result = completed(await started);
    expect(result.response).toEqual(partial);
    expect(result.loopResult).toMatchObject({
      stoppedReason: "aborted",
      finalText: "partial",
    });
    expect(h.sends).toHaveLength(1);
    expect(
      h.types().filter((type) => type === "request.prepared"),
    ).toHaveLength(1);
    expect(
      h.types().filter((type) => type === "execution.started"),
    ).toHaveLength(1);
    expect(h.terminalsOf()).toHaveLength(1);
    expect(
      progressDeliveries
        .map(
          ([, , payload]) =>
            (payload as { event?: { kind?: string } }).event?.kind,
        )
        .filter((kind) => kind === "stopped"),
    ).toHaveLength(1);
  });

  it("only the sender that started a turn (in its own window) can stop it", async () => {
    const h = harness({ native: "hold" });
    const owner = h.newContext();
    const started = h.owner.start(owner.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    const stranger = h.newContext();
    expect(
      (
        h.owner.cancel(stranger.context, { turnId: TURN_A }) as {
          found: boolean;
        }
      ).found,
    ).toBe(false);
    expect(
      (
        h.owner.cancel(
          { ...owner.context, win: new FakeWindow(99) },
          { turnId: TURN_A },
        ) as { found: boolean }
      ).found,
    ).toBe(false);
    expect(
      (h.owner.cancel(owner.context, { turnId: uuid() }) as { found: boolean })
        .found,
    ).toBe(false);
    h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
    completed(await started);
  });
});

describe("a sender that is gone (DR-MP3-7)", () => {
  for (const [label, trigger] of [
    [
      "destroyed",
      (c: { sender: FakeSender; win: FakeWindow }) =>
        c.sender.emit("destroyed"),
    ],
    [
      "render-process-gone",
      (c: { sender: FakeSender; win: FakeWindow }) =>
        c.sender.emit("render-process-gone"),
    ],
    [
      "a main-frame navigation (a reload)",
      (c: { sender: FakeSender; win: FakeWindow }) =>
        c.sender.emit("did-start-navigation", {
          isMainFrame: true,
          isSameDocument: false,
        }),
    ],
    [
      "the window's closed",
      (c: { sender: FakeSender; win: FakeWindow }) => c.win.emit("closed"),
    ],
  ] as const) {
    it(`${label}: the start settles at once, one ambiguous terminal is written, and the late Native settle is dropped`, async () => {
      const h = harness({ native: "hold" });
      const c = h.newContext();
      const started = h.owner.start(c.context, startRequest(TURN_A));
      const outcome = started.then(
        () => "resolved",
        (error: Error) => error.message,
      );
      await flush();
      trigger(c);
      expect(await outcome).toMatch(/MASTRA_AGENT_TURN_ABORTED: sender-gone/);
      await flush();
      const terminals = h.terminalsOf();
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.payload).toMatchObject({
        remoteOutcome: "unknown",
        conservative: true,
        captureState: "partial",
        responseObserved: false,
      });
      // Native's send was not stopped; the slot is held until it settles.
      expect(h.owner.activeTurnCount()).toBe(0);
      expect(h.owner.slotsInUse()).toBe(1);
      h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
      await flush();
      expect(h.terminalsOf()).toHaveLength(1);
      expect(h.types().filter((t) => t === "execution.completed")).toHaveLength(
        0,
      );
      expect(h.owner.slotsInUse()).toBe(0);
      // No listener is left on the sender or the window.
      expect(c.sender.listenerCount("destroyed")).toBe(0);
      expect(c.sender.listenerCount("did-start-navigation")).toBe(0);
      expect(c.win.listenerCount("closed")).toBe(0);
    });
  }

  it("a sub-frame navigation and a same-document change do not end the turn; the listeners go with the turn", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    c.sender.emit("did-start-navigation", { isMainFrame: false });
    c.sender.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
    });
    await flush();
    expect(h.owner.activeTurnCount()).toBe(1);
    h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
    completed(await started);
    expect(c.sender.listenerCount("destroyed")).toBe(0);
    expect(c.sender.listenerCount("render-process-gone")).toBe(0);
    expect(c.sender.listenerCount("did-start-navigation")).toBe(0);
    expect(c.win.listenerCount("closed")).toBe(0);
  });

  it("an identity that is replaced before the send (a workspace or epoch change) stops the send: Native is never called", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    // Revoke the identity while the settings are being read (the await before the send).
    const owner = h.owner;
    const original = c.context.callerIdentity as object;
    const started = owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    h.issued.delete(original);
    expect(await outcome).toMatch(
      /MASTRA_AGENT_TURN_ABORTED: workspace-switch/,
    );
    expect(h.sends).toHaveLength(0);
  });
});

describe("restricted: the egress participant (DR-MP3-11)", () => {
  it("closes admission, asks Native to stop what is in Native (reserved), and returns once the terminal is written", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    const abortNativeInFlight = vi.fn(() => true);
    await h.owner.quiesceForProfileEgress({ abortNativeInFlight });
    expect(abortNativeInFlight).toHaveBeenCalledTimes(1);
    expect(h.terminalsOf()).toHaveLength(1);
    expect(h.terminalsOf()[0]?.payload).toMatchObject({
      remoteOutcome: "unknown",
    });
    expect(await outcome).toMatch(/ABORTED: restricted/);
    // One-way: nothing new is admitted.
    expect(
      refusalReason(await h.owner.start(c.context, startRequest(uuid()))),
    ).toBe("restricted");
    // Native's late settle changes nothing.
    h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
    await flush();
    expect(h.terminalsOf()).toHaveLength(1);
  });

  it("with no turn it does not touch Native's stop (the launch's stage 5 stays where it is)", async () => {
    const h = harness();
    const abortNativeInFlight = vi.fn(() => true);
    await h.owner.quiesceForProfileEgress({ abortNativeInFlight });
    expect(abortNativeInFlight).not.toHaveBeenCalled();
    expect(h.appended).toHaveLength(0);
  });

  it("a turn that is not yet in Native is aborted without Native's stop", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    h.appendBehavior.hang = deferred<void>();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    const abortNativeInFlight = vi.fn(() => true);
    const quiesce = h.owner.quiesceForProfileEgress({ abortNativeInFlight });
    h.appendBehavior.hang.resolve();
    await quiesce;
    expect(abortNativeInFlight).not.toHaveBeenCalled();
    expect(h.sends).toHaveLength(0);
    // The begin batch finished first, then the terminal: never start-only.
    expect(h.types()).toEqual([
      "execution.started",
      "request.prepared",
      "execution.failed",
    ]);
  });

  it("a terminal that cannot be written fails the quiesce (the activation fails closed)", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    h.appendBehavior.fail = true;
    await expect(
      h.owner.quiesceForProfileEgress({ abortNativeInFlight: () => true }),
    ).rejects.toThrow();
  });

  it("the profile gate's own state also stops a send: a turn that began is ended at the send", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    h.appendBehavior.hang = deferred<void>();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    h.profile.activating = true;
    h.appendBehavior.hang.resolve();
    expect(await outcome).toMatch(/ABORTED: restricted/);
    expect(h.sends).toHaveLength(0);
  });
});

describe("workspace switch: the owner's lease (DR-MP3-12)", () => {
  it("aborts, writes the ambiguous terminal to the OLD workspace before it returns, refuses new turns until resume, then reopens", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    const lease = await h.owner.quiesceForWorkspaceSwitch();
    // Nothing start-only is left on the old workspace.
    expect(h.types().filter((t) => t === "execution.started")).toHaveLength(1);
    expect(h.terminalsOf()).toHaveLength(1);
    expect(h.appended.every((call) => call.path === WORKSPACE)).toBe(true);
    expect(await outcome).toMatch(/ABORTED: workspace-switch/);
    expect(
      refusalReason(await h.owner.start(c.context, startRequest(uuid()))),
    ).toBe("busy");
    await lease.resume(true);
    await lease.resume(true);
    const again = h.newContext();
    h.nativeSends.length = 0;
    const next = h.owner.start(again.context, startRequest(uuid()));
    next.catch(() => undefined);
    await flush();
    h.nativeSends.at(-1)?.resolve(JSON.stringify(RESPONSE));
    h.nativeSends[0]?.resolve(JSON.stringify(RESPONSE));
    completed(await next);
  });

  it("with no turn it writes nothing; two switches at once keep admission closed until both resume", async () => {
    const h = harness();
    const first = await h.owner.quiesceForWorkspaceSwitch();
    const second = await h.owner.quiesceForWorkspaceSwitch();
    expect(h.appended).toHaveLength(0);
    const c = h.newContext();
    await first.resume(false);
    expect(
      refusalReason(await h.owner.start(c.context, startRequest(uuid()))),
    ).toBe("busy");
    await second.resume(true);
    completed(await h.owner.start(c.context, startRequest(uuid())));
  });

  it("the wait is bounded: a terminal that never lands does not hold the switch", async () => {
    vi.useFakeTimers();
    const h = harness({
      native: "hold",
      forcedBoundMs: MASTRA_TURN_FORCED_BOUND_MS,
    });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    h.appendBehavior.hang = deferred<void>();
    let leased = false;
    const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
      leased = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(MASTRA_TURN_FORCED_BOUND_MS - 1);
    expect(leased).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(leased).toBe(true);
    await (await lease).resume(false);
    expect(
      h.logs.some((m) =>
        /terminals or reads not settled within the switch bound/.test(m),
      ),
    ).toBe(true);
    h.appendBehavior.hang.resolve();
  });
});

describe("quit (DR-MP3-13)", () => {
  it("ends the turns with an ambiguous terminal each and is idempotent", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    const first = h.owner.shutdown();
    const second = h.owner.shutdown();
    expect(second).toBe(first);
    await first;
    expect(h.terminalsOf()).toHaveLength(1);
    await h.owner.shutdown();
    expect(h.terminalsOf()).toHaveLength(1);
    // Nothing is admitted after it.
    expect(
      refusalReason(await h.owner.start(c.context, startRequest(uuid()))),
    ).toBe("unsupported");
  });

  it(`is bounded by T_quit (${MASTRA_TURN_QUIT_BOUND_MS} ms) when the append hangs, and never rejects when it fails`, async () => {
    vi.useFakeTimers();
    const h = harness({
      native: "hold",
      quitBoundMs: MASTRA_TURN_QUIT_BOUND_MS,
    });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    h.appendBehavior.hang = deferred<void>();
    let done = false;
    const quit = h.owner.shutdown().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(MASTRA_TURN_QUIT_BOUND_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await quit;
    expect(done).toBe(true);
    // A start-only row remains (no recovery; the report counts it).
    expect(h.terminalsOf()).toHaveLength(0);
    h.appendBehavior.hang.resolve();

    const failing = harness({ native: "hold" });
    const d = failing.newContext();
    const second = failing.owner.start(d.context, startRequest(TURN_A));
    second.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    failing.appendBehavior.fail = true;
    await expect(failing.owner.shutdown()).resolves.toBeUndefined();
  });

  it("with no turn it returns at once", async () => {
    const h = harness();
    await expect(h.owner.shutdown()).resolves.toBeUndefined();
    expect(h.appended).toHaveLength(0);
  });
});

describe("a replaced workspace binding (the event hook)", () => {
  it("ends only the turns whose identity is no longer issued; other events and unchanged identities are ignored", async () => {
    const h = harness({ native: "hold" });
    const stays = h.newContext();
    const goes = h.newContext();
    const keep = h.owner.start(stays.context, startRequest(uuid()));
    keep.catch(() => undefined);
    const drop = h.owner.start(goes.context, startRequest(uuid()));
    const dropped = drop.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    h.owner.handleBackendEvent("workspace:lifecycle-state", {});
    h.owner.handleBackendEvent("some:other", {});
    expect(h.owner.activeTurnCount()).toBe(2);
    h.issued.delete(goes.identity);
    h.owner.handleBackendEvent("some:other", {});
    expect(h.owner.activeTurnCount()).toBe(2);
    h.owner.handleBackendEvent("workspace:opened", { path: "/work/new" });
    expect(await dropped).toMatch(/ABORTED: workspace-switch/);
    expect(h.owner.activeTurnCount()).toBe(1);
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    await keep;
  });
});

describe("a turn a forced abort detached is still waited for (terminal in flight)", () => {
  /** A turn in Native whose sender is then destroyed, with the terminal's append held. */
  async function detachedWithHeldTerminal() {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    h.appendBehavior.hang = deferred<void>();
    c.sender.emit("destroyed");
    await flush();
    // The caller already settled and left the attached table.
    expect(h.owner.activeTurnCount()).toBe(0);
    return h;
  }

  it("quit waits for the terminal of a turn the sender's destruction just aborted (no start-only)", async () => {
    const h = await detachedWithHeldTerminal();
    let done = false;
    const quit = h.owner.shutdown().then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    h.appendBehavior.hang!.resolve();
    await quit;
    expect(h.terminalsOf()).toHaveLength(1);
  });

  it("a workspace switch's lease waits for it, so the terminal still reaches the old workspace", async () => {
    const h = await detachedWithHeldTerminal();
    let leased = false;
    const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
      leased = true;
      return value;
    });
    await flush();
    expect(leased).toBe(false);
    h.appendBehavior.hang!.resolve();
    await (await lease).resume(true);
    expect(h.terminalsOf()).toHaveLength(1);
    expect(h.appended.every((call) => call.path === WORKSPACE)).toBe(true);
  });

  it("the restricted quiesce waits for it and asks Native to stop what the detached turn still has there", async () => {
    const h = await detachedWithHeldTerminal();
    const abortNativeInFlight = vi.fn(() => true);
    let done = false;
    const quiesce = h.owner
      .quiesceForProfileEgress({ abortNativeInFlight })
      .then(() => {
        done = true;
      });
    await flush();
    expect(done).toBe(false);
    expect(abortNativeInFlight).toHaveBeenCalledTimes(1);
    h.appendBehavior.hang!.resolve();
    await quiesce;
    expect(h.terminalsOf()).toHaveLength(1);
  });
});

describe("settings and key are resolved once, before the turn begins (DR-MP3-13)", () => {
  it("a turn is run with settings read once and one key resolution", async () => {
    const resolve = vi.fn(() => "key-1");
    const h = harness({ secrets: { resolveApiKeyForRequest: resolve } });
    const { context } = h.newContext();
    completed(await h.owner.start(context, startRequest(TURN_A)));
    expect(h.settingsReads.count).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      { provider: "anthropic" },
      "anthropic",
      null,
    );
  });

  it("no key: the Agent is not run, nothing is sent, no audit row is begun, nothing is logged, and the start is ok:false with the reason", async () => {
    let ran = 0;
    const h = harness({
      secrets: {
        resolveApiKeyForRequest: () => {
          throw new Error("No API key configured for anthropic");
        },
      },
      loadRuntime: async () => ({
        createMastraAgentRuntime: () => ({
          runTurn: async () => {
            ran += 1;
          },
        }),
      }),
    });
    const { context } = h.newContext();
    await expect(h.owner.start(context, startRequest(TURN_A))).rejects.toThrow(
      "No API key configured for anthropic",
    );
    expect(ran).toBe(0);
    expect(h.sends).toHaveLength(0);
    expect(h.appended).toHaveLength(0);
    expect(h.settingsReads.count).toBe(1);
    expect(h.logs).toEqual([]);
    expect(h.owner.activeTurnCount()).toBe(0);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("unreadable settings behave the same", async () => {
    const bad = harness({
      backend: {
        getAiSettings: async () => {
          throw new Error("settings unreadable");
        },
        aiAuditAppendBatch: async () => "{}",
        sendAgentMessage: async () => "{}",
      } as unknown as NapiBackendLike,
    });
    const other = bad.newContext();
    await expect(
      bad.owner.start(other.context, startRequest(uuid())),
    ).rejects.toThrow("settings unreadable");
    expect(bad.appended).toHaveLength(0);
  });
});

describe("smaller lifecycle points", () => {
  it("a runtime factory that throws is not cached either: the next start builds again", async () => {
    let calls = 0;
    const h = harness({
      loadRuntime: async () => ({
        createMastraAgentRuntime: () => {
          calls += 1;
          if (calls === 1) throw new Error("factory failed");
          return {
            runTurn: async (input: MastraAgentTurnInput) => {
              const handle = await input.audit.begin({
                messages: [],
                tools: [],
                ...input.route,
              } as unknown as AgentAuditRequest);
              await input.audit.fail(handle, new Error("stop here"));
              throw new Error("stop here");
            },
          };
        },
      }),
    });
    const { context } = h.newContext();
    await expect(h.owner.start(context, startRequest(uuid()))).rejects.toThrow(
      "factory failed",
    );
    await expect(h.owner.start(context, startRequest(uuid()))).rejects.toThrow(
      "stop here",
    );
    expect(calls).toBe(2);
  });

  it("a cancel after the dispatch row and before the send to Native ends as cancelled with no send, and the row says so", async () => {
    const h = harness({ native: "hold" });
    const { context } = h.newContext();
    h.hooks.onAppend = (types) => {
      if (types.includes("request.dispatched")) {
        h.owner.cancel(context, { turnId: TURN_A });
      }
    };
    await expect(h.owner.start(context, startRequest(TURN_A))).rejects.toThrow(
      /MASTRA_AGENT_TURN_CANCELLED/,
    );
    expect(h.sends).toHaveLength(0);
    expect(h.types()).toEqual([
      "execution.started",
      "request.prepared",
      "request.dispatched",
      "execution.cancelled",
    ]);
    expect(JSON.stringify(h.terminalsOf()[0]?.payload)).toContain(
      "before the send to Native",
    );
    expect(h.terminalsOf()[0]?.payload).not.toHaveProperty("remoteOutcome");
  });

  it("the owner carries the gate flag the router reads", () => {
    expect(harness().owner.open).toBe(true);
    expect(harness({ open: false }).owner.open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real profile gate: the owner is registered as the product registers it
// (`index.ts`), and a real `beginProfileActivation` runs stages 2 to 7 over it.
// ---------------------------------------------------------------------------

describe("restricted: the real activation (stage 3 of the egress gate)", () => {
  const UNRESTRICTED = {
    profileId: "profile-1",
    callerEpoch: 4,
    restricted: false,
    handlesInvalidated: false,
    inFlightStopped: true,
    sqlPolicy: nativeSqlPolicyV2(),
  };
  const RESTRICTED = {
    ...UNRESTRICTED,
    callerEpoch: 5,
    restricted: true,
    handlesInvalidated: true,
  };

  async function activationRig(options: { participantBoundMs?: number } = {}) {
    const order: string[] = [];
    const native = {
      initializeProfileEgress: async () => JSON.stringify(UNRESTRICTED),
      registerProfileEgressCaller: () => undefined,
      invalidateProfileEgressCallers: () => undefined,
      profileActivationConsume: () => undefined,
      profileActivationCommit: vi.fn(async () => {
        order.push("commit");
        return JSON.stringify(RESTRICTED);
      }),
      profileActivationAbortInFlight: vi.fn(() => {
        order.push("native-abort");
        return true;
      }),
    } as unknown as NapiBackendLike;
    const gate = await createProfileEgressGate(native, options);
    // The workspace the identity will carry (Native's `workspace:opened` event).
    gate.observeBackendEvent?.("workspace:opened", { path: WORKSPACE });
    const h = harness({ native: "hold", profile: gate });
    gate.registerMainEgressParticipant(
      "mastra-turn-owner",
      (context) => h.owner.quiesceForProfileEgress(context),
      () => h.owner.forceStopForProfileEgress(),
    );
    const sender = new FakeSender(7);
    const win = new FakeWindow(70);
    const context: MastraTurnInvokeContext = {
      sender,
      win,
      callerIdentity: gate.issueCallerIdentity(7),
    };
    const activate = () =>
      gate.beginProfileActivation!(
        consumeProfileActivation(native, "grant", 7, 70),
      );
    return { gate, h, context, activate, native, order };
  }

  it("an in-flight turn is stopped inside stage 3: Native's stop is asked once, the terminal is written before Native's commit, and the profile becomes restricted", async () => {
    const { gate, h, context, activate, native, order } = await activationRig();
    const started = h.owner.start(context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    expect(h.sends).toHaveLength(1);
    const real = h.appendBehavior;
    // Record the append in the same order list as Native's own calls.
    const appendTypes = () => h.types().length;
    expect(appendTypes()).toBe(3);
    const view = await activate();
    expect(view).toEqual({ state: "restricted" });
    expect(gate.restricted).toBe(true);
    expect(
      (
        native.profileActivationAbortInFlight as unknown as ReturnType<
          typeof vi.fn
        >
      ).mock.calls,
    ).toHaveLength(1);
    expect(order).toEqual(["native-abort", "commit"]);
    // The terminal is durable by the time the activation went on to the commit.
    expect(h.terminalsOf()).toHaveLength(1);
    expect(h.terminalsOf()[0]?.payload).toMatchObject({
      remoteOutcome: "unknown",
    });
    expect(await outcome).toMatch(/ABORTED: restricted/);
    // Native's send (stopped by Native's own cancel in reality) settles late: nothing is added.
    h.nativeSends[0]!.reject(new Error("cancelled by Native"));
    await flush();
    expect(h.terminalsOf()).toHaveLength(1);
    expect(real.fail).toBe(false);
    // Closed for good.
    expect(
      refusalReason(await h.owner.start(context, startRequest(uuid()))),
    ).toBe("restricted");
  });

  it("with no turn the participant asks Native for nothing: stage 5 stays where it was", async () => {
    const { gate, activate, native } = await activationRig();
    expect(await activate()).toEqual({ state: "restricted" });
    expect(gate.restricted).toBe(true);
    expect(
      (
        native.profileActivationAbortInFlight as unknown as ReturnType<
          typeof vi.fn
        >
      ).mock.calls,
    ).toHaveLength(0);
  });

  it("a terminal that cannot be written makes the activation fail closed (participant-failed), and the owner stays closed", async () => {
    const { gate, h, context, activate, native } = await activationRig();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    h.appendBehavior.fail = true;
    expect(await activate()).toEqual({
      state: "unavailable",
      reason: "participant-failed",
    });
    expect(gate.unavailable).toBe(true);
    expect(
      (native.profileActivationCommit as unknown as ReturnType<typeof vi.fn>)
        .mock.calls,
    ).toHaveLength(0);
    h.appendBehavior.fail = false;
    expect(
      refusalReason(await h.owner.start(context, startRequest(uuid()))),
    ).toBe("restricted");
  });

  it("the stop request lent to a participant is valid for stage 3 only: a kept context does nothing afterwards", async () => {
    const { gate, activate, native } = await activationRig();
    let kept: { abortNativeInFlight(): boolean } | null = null;
    gate.registerMainEgressParticipant("keeper", async (context) => {
      kept = context;
    });
    expect(await activate()).toEqual({ state: "restricted" });
    const abort =
      native.profileActivationAbortInFlight as unknown as ReturnType<
        typeof vi.fn
      >;
    expect(abort).not.toHaveBeenCalled();
    expect(kept!.abortNativeInFlight()).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });

  it("a terminal that never lands is cut by the gate's bound: unavailable (participant-timeout), the owner is force-stopped", async () => {
    const { gate, h, context, activate } = await activationRig({
      participantBoundMs: 20,
    });
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    h.appendBehavior.hang = deferred<void>();
    expect(await activate()).toEqual({
      state: "unavailable",
      reason: "participant-timeout",
    });
    expect(gate.unavailable).toBe(true);
    h.appendBehavior.hang.resolve();
  });
});

// ---------------------------------------------------------------------------
// MP-4b PR-2: the read lifecycle (DR-MP4-5, threat model W11). No tool is
// connected: the tests put the real `runNativeRead` of PR-1 between a fake
// Native read and the hooks the owner hands out for an attached turn.
// ---------------------------------------------------------------------------

describe("read lifecycle: the hooks, the count and the waits (DR-MP4-5)", () => {
  /** A turn held in Native (so it stays attached), and its read hooks. */
  async function heldTurn(overrides: Parameters<typeof harness>[0] = {}) {
    const h = harness({ native: "hold", ...overrides });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    const hooks = h.owner.readHooks(TURN_A);
    expect(hooks).not.toBeNull();
    return { h, c, started, outcome, hooks: hooks! };
  }

  /** One read through PR-1's runner; `native` is the call's own promise. */
  function read(
    hooks: NonNullable<ReturnType<MastraTurnOwner["readHooks"]>>,
    native: Deferred<string>,
    timeoutMs: number | null = null,
  ) {
    const call = vi.fn(() => native.promise);
    const result = runNativeRead(call, {
      command: "db_execute",
      timeoutMs,
      hooks,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: Error) => ({ ok: false as const, error }),
    );
    return { call, result };
  }

  it("an unknown turn has no hooks, and with no read the count is 0", async () => {
    const h = harness();
    expect(h.owner.readHooks(TURN_A)).toBeNull();
    expect(h.owner.readsInFlight()).toBe(0);
  });

  it("counts a read from the send to Native's settle, and goes back to 0", async () => {
    const { h, hooks, started } = await heldTurn();
    const native = deferred<string>();
    const { call, result } = read(hooks, native);
    expect(call).toHaveBeenCalledTimes(1);
    expect(h.owner.readsInFlight()).toBe(1);
    native.resolve("rows");
    expect(await result).toEqual({ ok: true, value: "rows" });
    await flush();
    expect(h.owner.readsInFlight()).toBe(0);
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    completed(await started);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("a failed read settles the count too", async () => {
    const { h, hooks, started } = await heldTurn();
    const native = deferred<string>();
    const { result } = read(hooks, native);
    native.reject(new Error("native failed"));
    expect(await result).toMatchObject({ ok: false });
    await flush();
    expect(h.owner.readsInFlight()).toBe(0);
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    await started;
  });

  it("the slot of an ended turn is held until the read settles", async () => {
    const { h, hooks, started } = await heldTurn();
    const native = deferred<string>();
    const { result } = read(hooks, native);
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    completed(await started);
    expect(h.owner.activeTurnCount()).toBe(0);
    expect(h.owner.slotsInUse()).toBe(1);
    native.resolve("rows");
    // The turn has ended: the answer is dropped, not returned.
    expect(await result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/READ_AFTER_END/) },
    });
    await flush();
    expect(h.owner.slotsInUse()).toBe(0);
    expect(h.owner.readsInFlight()).toBe(0);
  });

  it("a read of a turn that has ended is refused before Native is called", async () => {
    const { h, hooks, started } = await heldTurn();
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    completed(await started);
    const { call, result } = read(hooks, deferred<string>());
    expect(await result).toMatchObject({ ok: false });
    expect(call).not.toHaveBeenCalled();
    expect(h.owner.readsInFlight()).toBe(0);
  });

  describe("assertLive: the same conditions as a send", () => {
    it("after a forced abort the read throws before Native is called", async () => {
      const { h, hooks, outcome } = await heldTurn();
      const lease = await h.owner.quiesceForWorkspaceSwitch();
      expect(await outcome).toMatch(/ABORTED: workspace-switch/);
      const { call, result } = read(hooks, deferred<string>());
      expect(await result).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/ABORTED: workspace-switch/) },
      });
      expect(call).not.toHaveBeenCalled();
      expect(h.owner.readsInFlight()).toBe(0);
      await lease.resume(false);
    });

    it("the three states of the profile close it, and the turn is aborted as restricted", async () => {
      for (const state of [
        "restricted",
        "unavailable",
        "activating",
      ] as const) {
        const { h, hooks, outcome } = await heldTurn();
        h.profile[state] = true;
        const { call, result } = read(hooks, deferred<string>());
        expect(await result).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/ABORTED: restricted/) },
        });
        expect(call).not.toHaveBeenCalled();
        expect(await outcome).toMatch(/ABORTED: restricted/);
        nextTurn = 0;
      }
    });

    it("an identity Main no longer issues, or a destroyed sender, closes it", async () => {
      const revoked = await heldTurn();
      revoked.h.issued.delete(revoked.c.identity);
      const first = read(revoked.hooks, deferred<string>());
      expect(await first.result).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/ABORTED: workspace-switch/) },
      });
      expect(first.call).not.toHaveBeenCalled();

      nextTurn = 0;
      const gone = await heldTurn();
      gone.c.sender.destroyed = true;
      const second = read(gone.hooks, deferred<string>());
      expect(await second.result).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/ABORTED: sender-gone/) },
      });
      expect(second.call).not.toHaveBeenCalled();
    });

    it("a stop the user asked for closes it too (as for a send)", async () => {
      const { h, c, hooks } = await heldTurn();
      h.owner.cancel(c.context, { turnId: TURN_A } as never);
      const { call, result } = read(hooks, deferred<string>());
      expect(await result).toMatchObject({ ok: false });
      expect(call).not.toHaveBeenCalled();
    });

    it("re-checks after the await: a forced abort while Native answers drops the result", async () => {
      const { h, hooks, outcome } = await heldTurn();
      const native = deferred<string>();
      const { result } = read(hooks, native);
      const lease = h.owner.quiesceForWorkspaceSwitch();
      native.resolve("rows");
      expect(await result).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/ABORTED: workspace-switch/) },
      });
      expect(await outcome).toMatch(/ABORTED: workspace-switch/);
      await (await lease).resume(false);
    });
  });

  describe("the waits count the reads (one bound, no new value)", () => {
    it("a workspace switch's lease waits for a read Native still holds, then returns", async () => {
      const { h, hooks } = await heldTurn();
      const native = deferred<string>();
      const { result } = read(hooks, native);
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      await flush();
      // The terminal is written; only the read holds the lease.
      expect(h.terminalsOf()).toHaveLength(1);
      expect(leased).toBe(false);
      native.resolve("rows");
      await result;
      await (await lease).resume(false);
      expect(leased).toBe(true);
      expect(h.owner.readsInFlight()).toBe(0);
    });

    it(`is cut by the forced bound (${MASTRA_TURN_FORCED_BOUND_MS} ms); the count stays until Native settles`, async () => {
      vi.useFakeTimers();
      const { h, hooks } = await heldTurn({
        forcedBoundMs: MASTRA_TURN_FORCED_BOUND_MS,
      });
      await vi.advanceTimersByTimeAsync(0);
      const native = deferred<string>();
      const { result } = read(hooks, native);
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(MASTRA_TURN_FORCED_BOUND_MS - 1);
      expect(leased).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(leased).toBe(true);
      expect(
        h.logs.some((m) =>
          /terminals or reads not settled within the switch bound/.test(m),
        ),
      ).toBe(true);
      // Not stopped, only no longer waited for.
      expect(h.owner.readsInFlight()).toBe(1);
      expect(h.owner.slotsInUse()).toBeGreaterThan(0);
      await (await lease).resume(false);
      native.resolve("rows");
      await result;
      expect(h.owner.readsInFlight()).toBe(0);
    });

    it("quit waits for a read Native still holds", async () => {
      const { h, hooks } = await heldTurn();
      const native = deferred<string>();
      const { result } = read(hooks, native);
      let done = false;
      const quit = h.owner.shutdown().then(() => {
        done = true;
      });
      await flush();
      expect(h.terminalsOf()).toHaveLength(1);
      expect(done).toBe(false);
      native.resolve("rows");
      await result;
      await quit;
      expect(done).toBe(true);
    });

    it(`quit is cut by T_quit (${MASTRA_TURN_QUIT_BOUND_MS} ms) and never rejects`, async () => {
      vi.useFakeTimers();
      const { h, hooks } = await heldTurn({
        quitBoundMs: MASTRA_TURN_QUIT_BOUND_MS,
      });
      await vi.advanceTimersByTimeAsync(0);
      const native = deferred<string>();
      read(hooks, native);
      let done = false;
      const quit = h.owner.shutdown().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(MASTRA_TURN_QUIT_BOUND_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await quit;
      expect(done).toBe(true);
      expect(h.owner.readsInFlight()).toBe(1);
    });

    it("the restricted quiesce waits for a read Native still holds (inside the gate's own bound)", async () => {
      const { h, hooks } = await heldTurn();
      const native = deferred<string>();
      const { result } = read(hooks, native);
      const abortNativeInFlight = vi.fn(() => true);
      let done = false;
      const quiesce = h.owner
        .quiesceForProfileEgress({ abortNativeInFlight })
        .then(() => {
          done = true;
        });
      await flush();
      expect(done).toBe(false);
      native.resolve("rows");
      await result;
      await quiesce;
      expect(done).toBe(true);
      // Native's stop request is for the AI in flight: the held send asks for
      // it, the read does not add a second one.
      expect(abortNativeInFlight).toHaveBeenCalledTimes(1);
    });

    it("a turn a forced abort detached, whose terminal is written, is still waited for while its read is in Native", async () => {
      const { h, c, hooks } = await heldTurn();
      const native = deferred<string>();
      const { result } = read(hooks, native);
      c.sender.emit("destroyed");
      await flush();
      // The caller left, and the terminal is on the old workspace already.
      expect(h.owner.activeTurnCount()).toBe(0);
      expect(h.terminalsOf()).toHaveLength(1);
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      let quitDone = false;
      const quit = h.owner.shutdown().then(() => {
        quitDone = true;
      });
      await flush();
      expect(leased).toBe(false);
      expect(quitDone).toBe(false);
      native.resolve("rows");
      await result;
      await (await lease).resume(false);
      await quit;
      expect(h.terminalsOf()).toHaveLength(1);
    });
  });

  describe("a caller timeout does not stop Native (late settle)", () => {
    it("keeps the count and the slot until the late settle, then goes back to 0", async () => {
      vi.useFakeTimers();
      const { h, hooks } = await heldTurn();
      await vi.advanceTimersByTimeAsync(0);
      const native = deferred<string>();
      const { result } = read(hooks, native, 10_000);
      expect(h.owner.readsInFlight()).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/did not answer within/) },
      });
      // The caller gave up; Native has not answered.
      expect(h.owner.readsInFlight()).toBe(1);
      // A quiesce still has it to wait for.
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(leased).toBe(false);
      native.resolve("late");
      await vi.advanceTimersByTimeAsync(0);
      expect(h.owner.readsInFlight()).toBe(0);
      await (await lease).resume(false);
      expect(leased).toBe(true);
      for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.owner.slotsInUse()).toBe(0);
    });
  });

  describe("a turn that ended normally is waited for, never aborted again (reads only)", () => {
    /** A turn that completed while a read is still in Native; the append can be made to fail first. */
    async function endedWithLateRead(failAppend = false) {
      const { h, hooks, started } = await heldTurn();
      const native = deferred<string>();
      const { result } = read(hooks, native);
      if (failAppend) h.appendBehavior.fail = true;
      for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
      if (failAppend) await started.catch(() => undefined);
      else completed(await started);
      await flush();
      expect(h.owner.activeTurnCount()).toBe(0);
      expect(h.owner.readsInFlight()).toBe(1);
      return { h, native, result };
    }

    it("a workspace switch waits for the read and writes no second terminal", async () => {
      const { h, native, result } = await endedWithLateRead();
      const before = h.types();
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      await flush();
      expect(leased).toBe(false);
      expect(h.types()).toEqual(before);
      native.resolve("rows");
      await result;
      await (await lease).resume(false);
      expect(h.types()).toEqual(before);
      expect(h.terminalsOf()).toHaveLength(1);
    });

    it("quit waits for the read and writes no second terminal", async () => {
      const { h, native, result } = await endedWithLateRead();
      const before = h.types();
      let done = false;
      const quit = h.owner.shutdown().then(() => {
        done = true;
      });
      await flush();
      expect(done).toBe(false);
      native.resolve("rows");
      await result;
      await quit;
      expect(h.types()).toEqual(before);
      expect(h.terminalsOf()).toHaveLength(1);
    });

    it("the restricted quiesce waits for the read, writes no second terminal, and asks Native to stop nothing (no send is in flight)", async () => {
      const { h, native, result } = await endedWithLateRead();
      const before = h.types();
      const abortNativeInFlight = vi.fn(() => true);
      let done = false;
      const quiesce = h.owner
        .quiesceForProfileEgress({ abortNativeInFlight })
        .then(() => {
          done = true;
        });
      await flush();
      expect(done).toBe(false);
      native.resolve("rows");
      await result;
      await quiesce;
      expect(h.types()).toEqual(before);
      expect(abortNativeInFlight).not.toHaveBeenCalled();
    });

    it("a turn whose last terminal could not be written is not aborted by the read's wait: the restricted quiesce does not fail on it", async () => {
      const { h, native, result } = await endedWithLateRead(true);
      const abortNativeInFlight = vi.fn(() => true);
      const quiesce = h.owner.quiesceForProfileEgress({ abortNativeInFlight });
      const settled = quiesce.then(
        () => "resolved",
        () => "rejected",
      );
      native.resolve("rows");
      await result;
      expect(await settled).toBe("resolved");
      // The failing append was not tried a second time.
      expect(h.terminalsOf()).toHaveLength(0);
    });

    it("a read that is refused for an ended turn touches nothing: no abort, no terminal, whatever the profile says", async () => {
      const { h, hooks, started } = await heldTurn();
      for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
      completed(await started);
      const before = h.types();
      h.profile.restricted = true;
      const { call, result } = read(hooks, deferred<string>());
      expect(await result).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/READ_AFTER_END/) },
      });
      await flush();
      expect(call).not.toHaveBeenCalled();
      expect(h.types()).toEqual(before);
    });
  });

  describe("the count follows each read", () => {
    it("two reads of one turn: the first settling does not release the wait, the second does", async () => {
      const { h, hooks } = await heldTurn();
      const first = deferred<string>();
      const second = deferred<string>();
      const a = read(hooks, first);
      const b = read(hooks, second);
      expect(h.owner.readsInFlight()).toBe(2);
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      first.resolve("1");
      await a.result;
      await flush();
      expect(h.owner.readsInFlight()).toBe(1);
      expect(leased).toBe(false);
      second.resolve("2");
      await b.result;
      await (await lease).resume(false);
      expect(leased).toBe(true);
      expect(h.owner.readsInFlight()).toBe(0);
    });

    it("once a read settled, the next switch does not wait for it (no bound is spent)", async () => {
      vi.useFakeTimers();
      const { h, c, hooks } = await heldTurn({
        forcedBoundMs: MASTRA_TURN_FORCED_BOUND_MS,
      });
      await vi.advanceTimersByTimeAsync(0);
      const native = deferred<string>();
      const { result } = read(hooks, native);
      c.sender.emit("destroyed");
      native.resolve("rows");
      await vi.advanceTimersByTimeAsync(0);
      await result;
      expect(h.owner.readsInFlight()).toBe(0);
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      // No timer is advanced: nothing is waited for.
      await vi.advanceTimersByTimeAsync(0);
      expect(leased).toBe(true);
      await (await lease).resume(false);
    });
  });

  describe("the terminals and the reads share one bound", () => {
    it(`a switch with a terminal that never lands AND a read that never settles returns at ${MASTRA_TURN_FORCED_BOUND_MS} ms, not later`, async () => {
      vi.useFakeTimers();
      const { h, hooks } = await heldTurn({
        forcedBoundMs: MASTRA_TURN_FORCED_BOUND_MS,
      });
      await vi.advanceTimersByTimeAsync(0);
      read(hooks, deferred<string>());
      h.appendBehavior.hang = deferred<void>();
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(MASTRA_TURN_FORCED_BOUND_MS - 1);
      expect(leased).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(leased).toBe(true);
      await (await lease).resume(false);
      h.appendBehavior.hang.resolve();
    });

    it(`quit with both returns at ${MASTRA_TURN_QUIT_BOUND_MS} ms, not later`, async () => {
      vi.useFakeTimers();
      const { h, hooks } = await heldTurn({
        quitBoundMs: MASTRA_TURN_QUIT_BOUND_MS,
      });
      await vi.advanceTimersByTimeAsync(0);
      read(hooks, deferred<string>());
      h.appendBehavior.hang = deferred<void>();
      let done = false;
      const quit = h.owner.shutdown().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(MASTRA_TURN_QUIT_BOUND_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await quit;
      expect(done).toBe(true);
      h.appendBehavior.hang.resolve();
    });

    it("a terminal that lands late and a read that never settles still return at the one bound (no second bound after the terminal)", async () => {
      vi.useFakeTimers();
      const { h, hooks } = await heldTurn({
        forcedBoundMs: MASTRA_TURN_FORCED_BOUND_MS,
        quitBoundMs: MASTRA_TURN_QUIT_BOUND_MS,
      });
      await vi.advanceTimersByTimeAsync(0);
      read(hooks, deferred<string>());
      h.appendBehavior.hang = deferred<void>();
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(MASTRA_TURN_FORCED_BOUND_MS - 10_000);
      h.appendBehavior.hang.resolve();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(leased).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(leased).toBe(true);
      await (await lease).resume(false);
    });

    it("a read that settles while the terminal still hangs does not end the wait early", async () => {
      vi.useFakeTimers();
      const { h, hooks } = await heldTurn({
        forcedBoundMs: MASTRA_TURN_FORCED_BOUND_MS,
      });
      await vi.advanceTimersByTimeAsync(0);
      const native = deferred<string>();
      read(hooks, native);
      h.appendBehavior.hang = deferred<void>();
      let leased = false;
      const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
        leased = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      native.resolve("rows");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(leased).toBe(false);
      await vi.advanceTimersByTimeAsync(MASTRA_TURN_FORCED_BOUND_MS);
      expect(leased).toBe(true);
      await (await lease).resume(false);
      h.appendBehavior.hang.resolve();
    });
  });

  describe("a user stop inside a read", () => {
    it("the read throws CANCELLED before Native is called, and the turn ends as cancelled with one execution.cancelled", async () => {
      const call = vi.fn(() => Promise.resolve("rows"));
      let readError: Error | null = null;
      let context: MastraTurnInvokeContext | null = null;
      const h = harness({
        native: "hold",
        runRead: async (owner) => {
          owner.cancel(context!, { turnId: TURN_A } as never);
          try {
            await runNativeRead(call, {
              command: "db_execute",
              timeoutMs: null,
              hooks: owner.readHooks(TURN_A)!,
            });
          } catch (error) {
            readError = error as Error;
            throw error;
          }
        },
      });
      const c = h.newContext();
      context = c.context;
      const outcome = await h.owner.start(c.context, startRequest(TURN_A)).then(
        () => "resolved",
        (error: Error) => error.message,
      );
      expect(readError).not.toBeNull();
      expect((readError as unknown as Error).message).toMatch(/CANCELLED/);
      expect(call).not.toHaveBeenCalled();
      expect(outcome).toMatch(/CANCELLED/);
      expect(h.types().filter((t) => t === "execution.cancelled")).toHaveLength(
        1,
      );
      expect(h.sends).toHaveLength(0);
    });
  });
});

describe("the per-send chat policy check (DR-MP4-26)", () => {
  const storedPolicy = (chat: boolean): string =>
    JSON.stringify({
      preset: "full",
      toggles: { chat, bodyWrite: true, analysis: true },
    });

  it("blocks the first send before audit begin and reads with the turn identity", async () => {
    const h = harness({
      policyDbExecute: async () =>
        readAnswer([{ ai_policy: storedPolicy(false) }]),
    });
    const c = h.newContext();

    await expect(
      h.owner.start(c.context, startRequest(TURN_A)),
    ).rejects.toThrow(/CANCELLED/);

    expect(h.dbQueries).toEqual([
      {
        sql: CHAT_POLICY_SQL,
        params: [PROJECT_ID],
        method: "get",
        callerIdentity: JSON.stringify(c.identity),
      },
    ]);
    expect(h.appended).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(
      progressDeliveries.map(
        ([, , payload]) => (payload as { event: { kind: string } }).event.kind,
      ),
    ).not.toContain("send-accepted");
  });

  it("blocks the next send after a tool round without beginning another audit row", async () => {
    let reads = 0;
    const h = harness({
      responses: [responseWith("tool_use", "", ["probe"])],
      runTurn: driveOwnerLoop,
      policyDbExecute: async () =>
        readAnswer([{ ai_policy: storedPolicy(reads++ === 0) }]),
    });
    const { context } = h.newContext();

    const result = completed(
      await h.owner.start(context, startRequest(TURN_A)),
    );

    expect(h.sends).toHaveLength(1);
    expect(
      h.dbQueries.filter(({ sql }) => sql === CHAT_POLICY_SQL),
    ).toHaveLength(2);
    expect(
      h.types().filter((type) => type === "execution.started"),
    ).toHaveLength(1);
    expect(
      progressDeliveries.filter(
        ([, , payload]) =>
          (payload as { event: { kind: string } }).event.kind ===
          "send-accepted",
      ),
    ).toHaveLength(1);
    expect(result.loopResult?.stoppedReason).toBe("aborted");
  });

  it("allows NULL and rejects a missing row, malformed row, or unreadable policy", async () => {
    const allowed = harness({
      policyDbExecute: async () => readAnswer([{ ai_policy: null }]),
    });
    const allowedContext = allowed.newContext();
    completed(
      await allowed.owner.start(allowedContext.context, startRequest(TURN_A)),
    );
    expect(allowed.sends).toHaveLength(1);

    for (const result of [
      readAnswer([]),
      JSON.stringify({ rows: [[null]] }),
      readAnswer([{}]),
      readAnswer([{ ai_policy: "not-json" }]),
    ]) {
      const h = harness({ policyDbExecute: async () => result });
      const { context } = h.newContext();
      await expect(
        h.owner.start(context, startRequest(uuid())),
      ).rejects.toThrow(/CANCELLED/);
      expect(h.appended).toEqual([]);
      expect(h.sends).toEqual([]);
    }

    const failed = harness({
      policyDbExecute: async () => {
        throw new Error("policy read failed");
      },
    });
    const failedContext = failed.newContext();
    await expect(
      failed.owner.start(failedContext.context, startRequest(uuid())),
    ).rejects.toThrow("policy read failed");
    expect(failed.appended).toEqual([]);
    expect(failed.sends).toEqual([]);
  });

  it("re-checks Stop after the read resolves, before audit begin", async () => {
    const policyRead = deferred<string>();
    const h = harness({ policyDbExecute: () => policyRead.promise });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));

    await flush();
    expect(h.dbQueries).toHaveLength(1);
    h.owner.cancel(c.context, { turnId: TURN_A });
    policyRead.resolve(readAnswer([{ ai_policy: null }]));

    await expect(started).rejects.toThrow(/CANCELLED/);
    expect(h.appended).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it("re-checks a forced abort after the read and keeps its slot until Native settles", async () => {
    const policyRead = deferred<string>();
    const h = harness({ policyDbExecute: () => policyRead.promise });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );

    await flush();
    expect(h.dbQueries).toHaveLength(1);
    c.sender.emit("destroyed");
    expect(await outcome).toMatch(/ABORTED: sender-gone/);
    expect(h.owner.slotsInUse()).toBe(1);
    expect(h.appended).toEqual([]);
    expect(h.sends).toEqual([]);

    policyRead.resolve(readAnswer([{ ai_policy: null }]));
    await flush();
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("times out a silent policy read before send and ignores its late answer", async () => {
    vi.useFakeTimers();
    const policyRead = deferred<string>();
    const h = harness({ policyDbExecute: () => policyRead.promise });
    const { context } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));
    let outcome: unknown;
    let settled = false;
    void started.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        outcome = error;
        settled = true;
      },
    );

    await flush();
    expect(h.dbQueries).toHaveLength(1);
    expect(h.sends).toEqual([]);
    expect(h.owner.readsInFlight()).toBe(1);

    await vi.advanceTimersByTimeAsync(MAIN_READ_CALLER_TIMEOUT_MS.db_execute);
    await flush();
    expect(settled).toBe(true);
    expect(outcome).toMatchObject({
      message: expect.stringMatching(/did not answer within/),
    });
    expect(h.owner.activeTurnCount()).toBe(0);
    expect(h.sends).toEqual([]);
    expect(h.owner.readsInFlight()).toBe(1);
    expect(h.owner.slotsInUse()).toBe(1);

    policyRead.resolve(readAnswer([{ ai_policy: null }]));
    await flush();
    expect(h.sends).toEqual([]);
    expect(h.owner.readsInFlight()).toBe(0);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("ends on forced abort before the policy read answers and drops the late result", async () => {
    const policyRead = deferred<string>();
    const h = harness({ policyDbExecute: () => policyRead.promise });
    const { context, sender } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));

    await flush();
    expect(h.owner.readsInFlight()).toBe(1);
    sender.emit("destroyed");

    await expect(started).rejects.toThrow(/ABORTED: sender-gone/);
    expect(h.owner.activeTurnCount()).toBe(0);
    expect(h.owner.readsInFlight()).toBe(1);
    expect(h.sends).toEqual([]);

    policyRead.resolve(readAnswer([{ ai_policy: null }]));
    await flush();
    expect(h.sends).toEqual([]);
    expect(h.owner.readsInFlight()).toBe(0);
    expect(h.owner.slotsInUse()).toBe(0);
  });
});

describe("MP-5 main-owned question holds", () => {
  it("binds the question to its turn, tool call and window, then completes the start once", async () => {
    const { h, context, pending, start, question } =
      await startPendingUiQuestion();
    const [windowId, channel, payload] =
      questionDeliveries[questionDeliveries.length - 1]!;
    expect(windowId).toBe(context.sender.id);
    expect(channel).toBe("mastra:agent-turn-question");
    expect(payload).toEqual(question);
    expect(question).toMatchObject({
      turnId: TURN_A,
      toolCallId: UI_TOOL_CALL_ID,
      toolName: "get_ui_state",
    });
    expect(question.deadlineAt - Date.now()).toBeLessThanOrEqual(
      MASTRA_AGENT_TURN_UI_TOOL_TIMEOUT_MS,
    );

    const answer = answerForQuestion(question);
    await expect(h.owner.answer(context, answer)).resolves.toEqual({
      status: "accepted",
      requestId: question.requestId,
    });
    await expect(pending).resolves.toEqual(answer.result);
    expect(questionDeliveries).toHaveLength(1);
    expect(questionDeliveries[0]?.[0]).toBe(context.sender.id);
    expect(await start).toMatchObject({ status: "completed", turnId: TURN_A });
    expect(h.owner.activeTurnCount()).toBe(0);
    expect(h.types()).toContain("execution.succeeded");
  });

  it("rejects answers from another sender or window, unknown IDs, mismatched IDs and late duplicates", async () => {
    const { h, context, pending, start, question } =
      await startPendingUiQuestion();
    await expect(
      h.owner.requestUiTool(TURN_A, "second-tool-call", "get_ui_state", {}),
    ).rejects.toThrow("MASTRA_AGENT_TURN_QUESTION_ALREADY_PENDING");

    const strangerSender = h.newContext();
    await expect(
      h.owner.answer(
        { ...context, sender: strangerSender.sender },
        answerForQuestion(question),
      ),
    ).resolves.toEqual({ status: "refused", reason: "no-pending" });
    const strangerWindow = h.newContext();
    await expect(
      h.owner.answer(
        { ...context, win: strangerWindow.win },
        answerForQuestion(question),
      ),
    ).resolves.toEqual({ status: "refused", reason: "no-pending" });
    await expect(
      h.owner.answer(context, {
        requestId: "00000000-0000-4000-8000-000000000099",
        refusal: "authority-revoked",
      }),
    ).resolves.toEqual({ status: "refused", reason: "no-pending" });

    const answer = answerForQuestion(question);
    if (!("result" in answer)) throw new Error("test answer missing result");
    await expect(
      h.owner.answer(context, {
        ...answer,
        result: { ...answer.result, toolCallId: "different-tool-call" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "invalid" });
    await expect(
      h.owner.answer(context, {
        ...answer,
        result: { ...answer.result, name: "ask_user" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "invalid" });

    const raced = await Promise.all([
      h.owner.answer(context, answer),
      h.owner.answer(context, answer),
    ]);
    expect(raced.filter((result) => result.status === "accepted")).toHaveLength(
      1,
    );
    expect(raced.filter((result) => result.status === "refused")).toHaveLength(
      1,
    );
    await expect(pending).resolves.toEqual(answer.result);
    await expect(h.owner.answer(context, answer)).resolves.toMatchObject({
      status: "refused",
      reason: "no-pending",
    });
    expect(await start).toMatchObject({ status: "completed", turnId: TURN_A });
  });

  it("closes immediately when Main cannot send the question event", async () => {
    const h = harness({
      sendQuestion: () => false,
      runTurn: async (input) => {
        await sendPreparedRequest(input, auditRequestFor(input), 0);
        await h.owner.requestUiTool(
          TURN_A,
          UI_TOOL_CALL_ID,
          "get_ui_state",
          {},
        );
      },
    });
    const { context } = h.newContext();
    await expect(h.owner.start(context, startRequest(TURN_A))).rejects.toThrow(
      "MASTRA_AGENT_TURN_QUESTION_DELIVERY_FAILED",
    );
    expect(questionDeliveries).toHaveLength(0);
    expect(h.owner.activeTurnCount()).toBe(0);
    await expect(
      h.owner.answer(context, {
        requestId: "00000000-0000-4000-8000-000000000099",
        refusal: "authority-revoked",
      }),
    ).resolves.toEqual({ status: "refused", reason: "no-pending" });
  });

  it("allows only one same-window question when concurrent requests resume after authority checks", async () => {
    const authorityGate = deferred<void>();
    const requests: Promise<MastraAgentTurnUiToolResult>[] = [];
    const questionsReady = deferred<void>();
    const ownerRef: { owner?: MastraTurnOwner } = {};
    let policyChecks = 0;
    const h = harness({
      policyDbExecute: async () => {
        policyChecks += 1;
        if (policyChecks > 1) await authorityGate.promise;
        return readAnswer([{ ai_policy: null }]);
      },
      runTurn: async (input) => {
        await sendPreparedRequest(input, auditRequestFor(input), 0);
        requests.push(
          ownerRef.owner!.requestUiTool(
            TURN_A,
            "first-tool-call",
            "get_ui_state",
            {},
          ),
          ownerRef.owner!.requestUiTool(
            TURN_A,
            "second-tool-call",
            "get_ui_state",
            {},
          ),
        );
        void requests[1]!.catch(() => undefined);
        questionsReady.resolve();
        await requests[0];
      },
    });
    ownerRef.owner = h.owner;
    const { context } = h.newContext();
    const start = h.owner.start(context, startRequest(TURN_A));
    void start.catch(() => undefined);
    await questionsReady.promise;
    await flush();
    expect(policyChecks).toBe(3);

    authorityGate.resolve();
    await flush();
    expect(questionDeliveries).toHaveLength(1);
    await expect(requests[1]).rejects.toThrow(
      "MASTRA_AGENT_TURN_QUESTION_ALREADY_PENDING",
    );
    const question =
      questionDeliveries[0]?.[2] as MastraAgentTurnQuestionPayload;
    await expect(
      h.owner.answer(context, answerForQuestion(question)),
    ).resolves.toEqual({ status: "accepted", requestId: question.requestId });
    await expect(requests[0]).resolves.toMatchObject({ name: "get_ui_state" });
    await expect(start).resolves.toMatchObject({
      status: "completed",
      turnId: TURN_A,
    });
  });

  it.each([
    ["run_app_command", { command: "openSettings" }],
    ["apply_layout_preset", { preset: "compact" }],
    ["propose_setting_change", { key: "editor.fontSize", value: "16" }],
    ["get_ui_state", {}],
    ["get_app_help_index", {}],
    ["get_app_help", { id: "topic:layout.presets" }],
  ] as const)(
    "DR-MP5-5: %s timeout is a tool failure and the turn continues",
    async (toolName, args) => {
      vi.useFakeTimers();
      const { h, context, pending, start, question } =
        await startPendingUiQuestion(toolName, args);
      await vi.advanceTimersByTimeAsync(MASTRA_AGENT_TURN_UI_TOOL_TIMEOUT_MS);
      await expect(pending).rejects.toThrow(
        /outcome is uncertain; do not repeat/,
      );
      await expect(start).resolves.toMatchObject({
        status: "completed",
        turnId: TURN_A,
      });
      await expect(
        h.owner.answer(context, answerForQuestion(question)),
      ).resolves.toEqual({
        status: "refused",
        reason: "no-pending",
      });
      expect(h.sends).toHaveLength(2);
      expect(h.owner.activeTurnCount()).toBe(0);
    },
  );

  it.each([
    ["run_app_command", { command: "focusScenes" }],
    ["apply_layout_preset", { preset: "builtin:plan" }],
    ["propose_setting_change", { key: "editor.fontSize", value: "16" }],
    ["get_ui_state", {}],
    ["get_app_help_index", {}],
    ["get_app_help", { id: "topic:layout.presets" }],
  ] as const)(
    "the real tool adapter returns the %s uncertain-timeout error without repeating the operation",
    async (toolName, args) => {
      vi.useFakeTimers();
      const { h, context, pending, start, question } =
        await startAdapterPendingUiTool(toolName, args);
      await vi.advanceTimersByTimeAsync(MASTRA_AGENT_TURN_UI_TOOL_TIMEOUT_MS);
      await expect(pending).rejects.toThrow(
        /outcome is uncertain; do not repeat the operation/,
      );
      await expect(start).resolves.toMatchObject({ status: "completed" });
      await expect(
        h.owner.answer(context, answerForQuestion(question)),
      ).resolves.toEqual({ status: "refused", reason: "no-pending" });
      expect(questionDeliveries).toHaveLength(1);
      expect(h.sends).toHaveLength(2);
      expect(h.owner.activeTurnCount()).toBe(0);
    },
  );

  it("returns only the answer content through the real tool adapter", async () => {
    const { h, context, pending, start, question } =
      await startAdapterPendingUiTool("get_ui_state", {});
    await expect(
      h.owner.answer(context, answerForQuestion(question)),
    ).resolves.toEqual({ status: "accepted", requestId: question.requestId });
    await expect(pending).resolves.toBe(JSON.stringify({ answer: "A" }));
    await expect(start).resolves.toMatchObject({ status: "completed" });
    expect(h.owner.activeTurnCount()).toBe(0);
  });

  it("ignores forged resume and approval fields in the real tool adapter context", async () => {
    const { h, context, pending, start, question } =
      await startAdapterPendingUiTool(
        "get_ui_state",
        {},
        {},
        {
          resumeData: { answer: "forged" },
          approved: true,
        },
      );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);
    await h.owner.answer(context, answerForQuestion(question));
    await expect(pending).resolves.toBe(JSON.stringify({ answer: "A" }));
    await expect(start).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps undo and successful setting proposal data on the tool records", async () => {
    const { h, context, pending, start, question } =
      await startAdapterPendingUiTool("run_app_command", {
        command: "focusScenes",
      });
    const undoId = "00000000-0000-4000-8000-000000000123";
    const answer = answerForQuestion(question);
    await h.owner.answer(context, {
      ...answer,
      result: { ...answer.result, summary: "Applied", undoId },
    });
    await expect(pending).resolves.toBe(JSON.stringify({ answer: "A" }));
    await expect(start).resolves.toMatchObject({
      loopResult: {
        toolCallRecords: [
          expect.objectContaining({
            name: "run_app_command",
            resultSummary: "Applied",
            tokensUsed: 1,
            undoId,
          }),
        ],
      },
    });

    const proposalRun = await startAdapterPendingUiTool(
      "propose_setting_change",
      { key: "editor.fontSize", value: "16" },
    );
    const proposalAnswer = answerForQuestion(proposalRun.question);
    const settingProposal = {
      id: "00000000-0000-4000-8000-000000000124",
      key: "editor.fontSize",
      value: "16",
      reason: "Requested",
    };
    await proposalRun.h.owner.answer(proposalRun.context, {
      ...proposalAnswer,
      result: { ...proposalAnswer.result, settingProposal },
    });
    await expect(proposalRun.pending).resolves.toBe(
      JSON.stringify({ answer: "A" }),
    );
    await expect(proposalRun.start).resolves.toMatchObject({
      loopResult: {
        toolCallRecords: [expect.objectContaining({ settingProposal })],
      },
    });

    const failedProposal = await startAdapterPendingUiTool(
      "propose_setting_change",
      { key: "editor.fontSize", value: "16" },
    );
    const failedAnswer = answerForQuestion(failedProposal.question);
    await failedProposal.h.owner.answer(failedProposal.context, {
      ...failedAnswer,
      result: {
        ...failedAnswer.result,
        error: "Rejected",
        settingProposal,
      },
    });
    await expect(failedProposal.pending).rejects.toThrow("Rejected");
    await expect(failedProposal.start).resolves.toMatchObject({
      loopResult: {
        toolCallRecords: [expect.not.objectContaining({ settingProposal })],
      },
    });
    expect(failedProposal.h.sends[1]?.args.messages.at(-1)).toMatchObject({
      role: "tool_result",
      isError: true,
    });
  });

  it("uses the legacy not-found text when a UI result has no content or summary", async () => {
    const { h, context, pending, start, question } =
      await startAdapterPendingUiTool("get_ui_state", {});
    const answer = answerForQuestion(question);
    await h.owner.answer(context, {
      ...answer,
      result: { ...answer.result, content: null, summary: "" },
    });
    await expect(pending).resolves.toBe("No result (not found).");
    await expect(start).resolves.toMatchObject({ status: "completed" });
  });

  it("the real tool adapter ends ask_user at its deadline without another send", async () => {
    vi.useFakeTimers();
    const { h, context, pending, start, question } =
      await startAdapterPendingUiTool("ask_user", ASK_USER_ARGS);
    expect(question.deadlineAt - Date.now()).toBe(
      MASTRA_AGENT_TURN_ASK_USER_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(MASTRA_AGENT_TURN_ASK_USER_TIMEOUT_MS);
    await expect(pending).resolves.toBe(
      "Tool execution skipped because the turn stopped.",
    );
    await expect(start).resolves.toMatchObject({
      status: "completed",
      loopResult: { stoppedReason: "aborted" },
    });
    await expect(
      h.owner.answer(context, answerForQuestion(question)),
    ).resolves.toEqual({ status: "refused", reason: "no-pending" });
    expect(h.sends).toHaveLength(1);
    expect(h.owner.activeTurnCount()).toBe(0);
  });

  it("ask_user still uses the separate legacy question limit", async () => {
    const { h, context, pending, start, question } =
      await startAdapterPendingUiTool("ask_user", ASK_USER_ARGS, {
        maxUserQuestions: 1,
      });
    await h.owner.answer(context, answerForQuestion(question));
    await expect(pending).resolves.toBe(JSON.stringify({ answer: "A" }));
    await expect(start).resolves.toMatchObject({
      status: "completed",
      loopResult: { stoppedReason: "limit_questions" },
    });
    expect(h.sends).toHaveLength(2);
    expect(
      h.sends[1]?.args.messages.some((message) =>
        message.content.includes("questions"),
      ),
    ).toBe(true);
  });

  it("a renderer authority refusal ends the real tool adapter turn", async () => {
    const { h, context, pending, start, question } =
      await startAdapterPendingUiTool("ask_user", ASK_USER_ARGS);
    await h.owner.answer(context, {
      requestId: question.requestId,
      refusal: "authority-revoked",
    });
    await expect(pending).resolves.toBe(
      "Tool execution skipped because the turn stopped.",
    );
    await expect(start).resolves.toMatchObject({
      status: "completed",
      loopResult: { stoppedReason: "aborted" },
    });
    expect(h.sends).toHaveLength(1);
    expect(h.owner.activeTurnCount()).toBe(0);
  });

  it("limits UI operation attempts to the legacy ten per turn", async () => {
    let owner: MastraTurnOwner | null = null;
    let context: MastraTurnInvokeContext | null = null;
    let answered = 0;
    const toolUses: AgentWireResponse["blocks"] = Array.from(
      { length: 11 },
      (_, index) => {
        const name =
          index % 2 === 0 ? "run_app_command" : "apply_layout_preset";
        return {
          type: "tool_use" as const,
          id: `ui-op-${index}`,
          name,
          input:
            name === "run_app_command"
              ? { command: "focusScenes" }
              : { preset: "builtin:plan" },
        };
      },
    );
    const h = harness({
      responses: [
        { blocks: toolUses, stopReason: "tool_use" },
        {
          blocks: [{ type: "text", content: "Done." }],
          stopReason: "end_turn",
        },
      ],
      runTurn: async (input) => driveCoreReadOwnerLoop(input, true),
      sendQuestion: (_senderId, question) => {
        if (!owner || !context) return false;
        answered += 1;
        queueMicrotask(() => {
          void owner!.answer(context!, {
            requestId: question.requestId,
            result: {
              toolCallId: question.toolCallId,
              name: question.toolName,
              content: { ok: true },
              summary: "ok",
              tokensUsed: 1,
            },
          });
        });
        return true;
      },
    });
    owner = h.owner;
    const caller = h.newContext();
    context = caller.context;
    const request = startRequest(TURN_A);
    const result = completed(
      await h.owner.start(caller.context, {
        ...request,
        tools: ["run_app_command", "apply_layout_preset"],
        loop: {
          ...request.loop,
          tokenBudget: 20_000,
          contextWindow: 50_000,
          maxToolCalls: 25,
        },
      }),
    );
    expect(answered).toBe(10);
    expect(h.readBindingLoads.count).toBe(0);
    expect(result.loopResult?.toolCallRecords).toHaveLength(11);
    expect(result.loopResult?.toolCallRecords.at(-1)?.resultSummary).toContain(
      "UI operation limit reached (10 per response)",
    );
    expect(
      h.sends[1]?.args.messages.some((message) =>
        message.content.includes("UI operation limit reached"),
      ),
    ).toBe(true);
    expect(h.sends[1]?.args.messages.at(-1)).toMatchObject({
      role: "tool_result",
      toolUseId: "ui-op-10",
      isError: true,
    });
  });

  it("closing the window ends a pending ask_user through the real tool adapter", async () => {
    const { h, win, pending, start } = await startAdapterPendingUiTool(
      "ask_user",
      ASK_USER_ARGS,
    );
    win.emit("closed");
    await expect(pending).resolves.toBe(
      "Tool execution skipped because the turn stopped.",
    );
    await expect(start).rejects.toThrow(
      /MASTRA_AGENT_TURN_ABORTED: sender-gone/,
    );
    expect(h.owner.activeTurnCount()).toBe(0);
  });

  it("rejects an answer at its absolute deadline even before the timer callback runs", async () => {
    vi.useFakeTimers();
    const { h, context, pending, start, question } =
      await startPendingUiQuestion();
    vi.setSystemTime(question.deadlineAt);
    await expect(
      h.owner.answer(context, answerForQuestion(question)),
    ).resolves.toEqual({ status: "refused", reason: "no-pending" });
    await expect(pending).rejects.toThrow(/outcome is uncertain/);
    await expect(start).resolves.toMatchObject({
      status: "completed",
      turnId: TURN_A,
    });
    expect(h.owner.activeTurnCount()).toBe(0);
  });

  it("ends the start at the ask_user deadline with no follow-up send", async () => {
    vi.useFakeTimers();
    const { h, context, pending, start, question } =
      await startPendingUiQuestion("ask_user", ASK_USER_ARGS);
    expect(question.deadlineAt - Date.now()).toBe(
      MASTRA_AGENT_TURN_ASK_USER_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(MASTRA_AGENT_TURN_ASK_USER_TIMEOUT_MS);
    await expect(pending).rejects.toThrow("MASTRA_AGENT_LOOP_STOPPED");
    expect(await start).toMatchObject({
      status: "completed",
      turnId: TURN_A,
      loopResult: { stoppedReason: "aborted" },
    });
    await expect(
      h.owner.answer(context, answerForQuestion(question)),
    ).resolves.toEqual({
      status: "refused",
      reason: "no-pending",
    });
    expect(h.sends).toHaveLength(1);
    expect(h.owner.activeTurnCount()).toBe(0);
  });

  it("Stop consumes the hold before a late answer", async () => {
    const { h, context, pending, start, question } =
      await startPendingUiQuestion();
    expect(h.owner.cancel(context, { turnId: TURN_A })).toMatchObject({
      status: "ok",
      found: true,
    });
    await expect(pending).rejects.toThrow("MASTRA_AGENT_LOOP_STOPPED");
    expect(await start).toMatchObject({ status: "completed", turnId: TURN_A });
    await expect(
      h.owner.answer(context, answerForQuestion(question)),
    ).resolves.toEqual({
      status: "refused",
      reason: "no-pending",
    });
  });

  it("a renderer authority refusal consumes the hold and ends the start", async () => {
    const { h, context, pending, start, question } =
      await startPendingUiQuestion();
    await expect(
      h.owner.answer(context, {
        requestId: question.requestId,
        refusal: "authority-revoked",
      }),
    ).resolves.toEqual({ status: "accepted", requestId: question.requestId });
    await expect(pending).rejects.toThrow("MASTRA_AGENT_LOOP_STOPPED");
    expect(await start).toMatchObject({
      status: "completed",
      turnId: TURN_A,
      loopResult: { stoppedReason: "aborted" },
    });
    expect(h.sends).toHaveLength(1);
    expect(h.owner.activeTurnCount()).toBe(0);
  });

  it("authority loss while accepting an answer stops before another send", async () => {
    let policyChecks = 0;
    const { h, context, pending, start, question } =
      await startPendingUiQuestion(
        "get_ui_state",
        {},
        {
          policyDbExecute: async () => {
            policyChecks += 1;
            if (policyChecks === 3) throw new Error("authority revoked");
            return readAnswer([{ ai_policy: null }]);
          },
        },
      );
    await expect(
      h.owner.answer(context, answerForQuestion(question)),
    ).resolves.toEqual({ status: "accepted", requestId: question.requestId });
    await expect(pending).rejects.toThrow("MASTRA_AGENT_LOOP_STOPPED");
    expect(await start).toMatchObject({
      status: "completed",
      loopResult: { stoppedReason: "aborted" },
    });
    expect(policyChecks).toBe(3);
    expect(h.sends).toHaveLength(1);
  });

  it("rechecks chat policy after the answer and does not pass a revoked result to the tool", async () => {
    let policyChecks = 0;
    const { h, context, pending, start, question } =
      await startPendingUiQuestion(
        "get_ui_state",
        {},
        {
          policyDbExecute: async () => {
            policyChecks += 1;
            return readAnswer([
              { ai_policy: policyChecks === 3 ? "off" : null },
            ]);
          },
        },
      );
    expect(questionDeliveries).toHaveLength(1);
    await expect(
      h.owner.answer(context, answerForQuestion(question)),
    ).resolves.toEqual({ status: "accepted", requestId: question.requestId });
    await expect(pending).rejects.toThrow("MASTRA_AGENT_LOOP_STOPPED");
    expect(await start).toMatchObject({
      status: "completed",
      loopResult: { stoppedReason: "aborted" },
    });
    expect(policyChecks).toBe(3);
    expect(h.sends).toHaveLength(1);
  });

  it.each(["profile", "workspace", "quit"] as const)(
    "forced %s interruption consumes the hold and ends start",
    async (cause) => {
      const { h, context, pending, start, question } =
        await startPendingUiQuestion();
      if (cause === "profile") await h.owner.quiesceForProfileEgress();
      if (cause === "workspace") {
        const lease = await h.owner.quiesceForWorkspaceSwitch();
        await lease.resume(false);
      }
      if (cause === "quit") await h.owner.shutdown();
      await expect(pending).rejects.toThrow("MASTRA_AGENT_TURN_ABORTED");
      await expect(start).rejects.toThrow("MASTRA_AGENT_TURN_ABORTED");
      await expect(
        h.owner.answer(context, answerForQuestion(question)),
      ).resolves.toEqual({
        status: "refused",
        reason: "no-pending",
      });
      expect(h.owner.activeTurnCount()).toBe(0);
      expect(h.terminalsOf()).toHaveLength(1);
    },
  );

  it.each([
    "destroyed",
    "render-process-gone",
    "navigation",
    "closed",
  ] as const)(
    "screen loss (%s) consumes the hold and ends start",
    async (event) => {
      const { h, context, sender, win, pending, start, question } =
        await startPendingUiQuestion();
      if (event === "destroyed") sender.emit("destroyed");
      if (event === "render-process-gone") sender.emit("render-process-gone");
      if (event === "navigation") {
        sender.emit("did-start-navigation", {
          isMainFrame: true,
          isSameDocument: false,
        });
      }
      if (event === "closed") win.emit("closed");
      await expect(pending).rejects.toThrow("MASTRA_AGENT_TURN_ABORTED");
      await expect(start).rejects.toThrow("MASTRA_AGENT_TURN_ABORTED");
      await expect(
        h.owner.answer(context, answerForQuestion(question)),
      ).resolves.toEqual({
        status: "refused",
        reason: "no-pending",
      });
      expect(h.owner.activeTurnCount()).toBe(0);
    },
  );

  it("does not read resumeData or approved from tool context or answers", () => {
    const source = readFileSync(
      new URL("./mastraTurnOwner.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\b(?:resumeData|approved)\b/u);
  });
});
