import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/features/chat/contextBuilder", () => ({
  ensureTokenizer: async () => undefined,
  countTokens: (text: string) => text.length,
}));
vi.mock("../../../src/features/chat/agent/toolTurnCache", () => ({
  beginAgentToolTurn: () => undefined,
}));

import type { NapiBackendLike } from "../../shared/ipcContract.js";
import { createMainAgentAuditSink } from "./agentAuditSink.js";
import {
  type AgentObserveResponse,
  type AgentSendGuard,
  type AgentPrepareSend,
  createAgentLanguageModel,
  grimodexProviderOptions,
  restoreToolInputOrder,
} from "./agentLanguageModel.js";
import {
  AGENT_CALL_OPTIONS,
  AGENT_NO_RETRY_CONFIG,
} from "./agentModelPolicy.js";
import {
  createMastraAgentRuntime,
  MastraAgentToolNotAllowedError,
  type MastraAgentToolBinding,
  type MastraAgentTurnInput,
} from "./agentRuntime.js";
import { createMastraAgentTools } from "./agentToolAdapter.js";
import { loadMastraForTest } from "./agentModel.testSupport.js";
import type {
  AgentRoute,
  AgentSend,
  AgentWireArgs,
  AgentWireResponse,
  AgentWireToolDefinition,
  AgentWireToolUse,
} from "./agentWire.js";
import {
  findAgentLoopStopped,
  MastraAgentLoopStopped,
} from "../mastraTurnOwner.js";

const ROUTE: AgentRoute = {
  thinking: null,
  effort: null,
  reasoningEnabled: null,
  reasoningEffort: null,
  apiVariant: null,
  webSearch: null,
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  endpointId: null,
  expectedOllamaEndpoint: null,
};

const response = (stopReason: string): AgentWireResponse => ({
  blocks: [{ type: "text", content: "done" }],
  stopReason,
});

const TOOL_SNAPSHOT: AgentWireToolDefinition = {
  name: "search_events",
  description: "snapshot description",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

function auditHarness(snapshotEvents = false) {
  const events: unknown[] = [];
  const backend = {
    async aiAuditAppendBatch(
      _path: string,
      _project: string | null,
      batch: unknown,
    ) {
      const appended = batch as unknown[];
      events.push(...(snapshotEvents ? structuredClone(appended) : appended));
      return "{}";
    },
  } as unknown as Pick<NapiBackendLike, "aiAuditAppendBatch">;
  let id = 0;
  const audit = createMainAgentAuditSink({
    backend,
    appVersion: "test",
    projectId: "project",
    expectedWorkspacePath: "/workspace",
    operationId: "characterization",
    now: () => 1,
    randomUUID: () => `event-${id++}`,
  });
  return { audit, events };
}

function findPreparedRequest(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if ("messages" in record && "modelVisibleContext" in record) return record;
  for (const child of Object.values(record)) {
    const found = findPreparedRequest(child);
    if (found) return found;
  }
  return undefined;
}

function eventCount(events: readonly unknown[], eventType: string): number {
  return events.filter(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "eventType" in event &&
      event.eventType === eventType,
  ).length;
}

function toolTurnInput(
  send: AgentSend,
  overrides: Partial<MastraAgentTurnInput> = {},
): MastraAgentTurnInput {
  const { audit } = auditHarness();
  return {
    instructions: "system",
    messages: [{ role: "user", content: "start" }],
    route: ROUTE,
    systemCacheSegments: null,
    systemVolatileTail: null,
    send,
    audit,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function runTwoSendToolTurn(
  divergeAtSend: boolean,
  hooks: {
    prepareSend?: AgentPrepareSend;
    assertSendAllowed?: AgentSendGuard;
    observeResponse?: AgentObserveResponse;
  } = {},
) {
  const kit = await loadMastraForTest();
  const { audit, events } = auditHarness(true);
  const sent: AgentWireArgs[] = [];
  const preparedCountAtSend: number[] = [];
  const observerCompleteCountAtObserve: number[] = [];
  let generated: unknown;
  let toolCapability: unknown;
  const preparedRows = () =>
    events.filter((event) =>
      JSON.stringify(event).includes('"eventType":"request.prepared"'),
    );
  const { model, capabilities } = createAgentLanguageModel({
    originalTools: [
      {
        name: "probe",
        description: "probe",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
    audit,
    prepareSend: hooks.prepareSend,
    assertSendAllowed: hooks.assertSendAllowed,
    observeResponse: (observed) => {
      observerCompleteCountAtObserve.push(
        events.filter(
          (event) =>
            (event as { eventType?: unknown }).eventType ===
            "execution.succeeded",
        ).length,
      );
      return hooks.observeResponse?.(observed);
    },
    send: async (args) => {
      if (divergeAtSend) {
        args.messages.push({ role: "user", content: "control message" });
      }
      sent.push(structuredClone(args));
      preparedCountAtSend.push(preparedRows().length);
      return sent.length === 1
        ? {
            blocks: [
              { type: "tool_use", id: "call-k1", name: "probe", input: {} },
            ],
            stopReason: "tool_use",
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            cost: 5,
            agentAuthorityCapabilities: {
              "call-k1": {
                capability: "CAP",
                executionId: "e",
                chatMessageId: "m",
                mainOwnedProvenanceId: "p",
              },
            },
          }
        : {
            ...response("end_turn"),
            inputTokens: 6,
            outputTokens: 7,
            cacheReadTokens: 8,
            cacheWriteTokens: 9,
            cost: 10,
          };
    },
  });
  const agent = new kit.Agent({
    id: "k1-two-send",
    name: "k1-two-send",
    instructions: "system",
    model,
    maxRetries: AGENT_NO_RETRY_CONFIG.maxRetries,
    maxProcessorRetries: AGENT_NO_RETRY_CONFIG.maxProcessorRetries,
    errorProcessorDefaults: AGENT_NO_RETRY_CONFIG.errorProcessorDefaults,
    tools: {
      probe: kit.createTool({
        id: "probe",
        description: "probe",
        inputSchema: kit.jsonSchema<Record<string, never>>({
          type: "object",
          properties: {},
        }),
        execute: async () => {
          toolCapability = capabilities.get("call-k1");
          return "tool result";
        },
      }),
    },
  });
  let error: unknown;
  try {
    generated = await agent.generate([{ role: "user", content: "start" }], {
      ...AGENT_CALL_OPTIONS,
      maxSteps: 2,
      providerOptions: grimodexProviderOptions({
        route: ROUTE,
        systemCacheSegments: ["cached system"],
        systemVolatileTail: "volatile tail",
      }),
    });
  } catch (caught) {
    error = caught;
  }
  return {
    sent,
    events,
    error,
    preparedRows: preparedRows(),
    preparedCountAtSend,
    observerCompleteCountAtObserve,
    generated,
    toolCapability,
  };
}

describe("4c-1 loop characterization", () => {
  it("replays a completed tool step and restores the original wire key order before audit", async () => {
    const kit = await loadMastraForTest();
    const user = { role: "user" as const, content: "start" };
    // 入れ子の各階層で、辞書順と異なる順序を wire に載せる。
    const input = { scope: { section: "draft", chapter: 2 }, filter: "title" };
    const definition = {
      name: "lookup",
      description: "synthetic lookup",
      inputSchema: {
        type: "object" as const,
        properties: {
          scope: { type: "object" as const },
          filter: { type: "string" as const },
        },
        required: ["scope", "filter"],
      },
    };
    const execute = vi.fn(async () => "found in chapter 2");
    const options = {
      ...AGENT_CALL_OPTIONS,
      providerOptions: grimodexProviderOptions({
        route: ROUTE,
        systemCacheSegments: ["cached system"],
        systemVolatileTail: "volatile tail",
      }),
    };

    function freshAgent(
      hooks: {
        observeResponse?: AgentObserveResponse;
        prepareSend?: AgentPrepareSend;
      } = {},
    ) {
      const requests: AgentWireArgs[] = [];
      const { audit } = auditHarness();
      const { model } = createAgentLanguageModel({
        originalTools: [definition],
        audit,
        ...hooks,
        send: async (args) => {
          requests.push(structuredClone(args));
          if (args.messages.at(-1)?.role === "tool_result") {
            return response("end_turn");
          }
          return {
            blocks: [{ type: "tool_use", id: "call-1", name: "lookup", input }],
            stopReason: "tool_use",
          };
        },
      });
      const agent = new kit.Agent({
        id: "reentry",
        name: "reentry",
        instructions: "system",
        model,
        tools: {
          lookup: kit.createTool({
            id: definition.name,
            description: definition.description,
            inputSchema: kit.jsonSchema<typeof input>(definition.inputSchema),
            execute,
          }),
        },
      });
      return { agent, requests };
    }

    const continuous = freshAgent();
    await continuous.agent.generate([user], { ...options, maxSteps: 2 });
    expect(continuous.requests).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const next = continuous.requests[1]!;
    expect(next.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: "",
        toolUses: [{ id: "call-1", name: "lookup", input }],
      },
      {
        role: "tool_result",
        toolUseId: "call-1",
        content: "found in chapter 2",
        isError: false,
      },
    ]);

    execute.mockClear();
    const observeResponse = vi.fn<AgentObserveResponse>();
    const firstStep = freshAgent({ observeResponse });
    const step = await firstStep.agent.generate([user], {
      ...options,
      maxSteps: 1,
    });
    expect(firstStep.requests).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const history = step.response.messages;
    expect(history?.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
    ]);
    const observedCall = observeResponse.mock.calls[0]![0].blocks[0];
    expect(observedCall?.type).toBe("tool_use");
    // 中断側の応答と SDK の履歴だけで試験用の切れ目を作る。DB への保存は対象外。
    const checkpoint = JSON.stringify({ call: observedCall, history });

    async function replay(restoreOrder: boolean) {
      const saved = JSON.parse(checkpoint) as {
        call: AgentWireToolUse;
        history: NonNullable<typeof history>;
      };
      const resumed = freshAgent({
        prepareSend: restoreOrder
          ? (request) => ({
              ...request,
              messages: request.messages.map((message) => {
                if (message.role !== "assistant" || !message.toolUses)
                  return message;
                return {
                  ...message,
                  toolUses: message.toolUses.map((use) =>
                    use.id === saved.call.id && use.name === saved.call.name
                      ? {
                          ...use,
                          input: restoreToolInputOrder(
                            use.input,
                            saved.call.input,
                          ),
                        }
                      : use,
                  ),
                };
              }),
            })
          : undefined,
      });
      await resumed.agent.generate([user, ...saved.history], {
        ...options,
        maxSteps: 2,
      });
      expect(resumed.requests).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
      return resumed.requests[0]!;
    }
    function withoutExecutionId(request: AgentWireArgs) {
      return {
        ...request,
        auditContext: { ...request.auditContext, executionId: undefined },
      };
    }
    const sdkOnly = withoutExecutionId(await replay(false));
    const reference = withoutExecutionId(next);
    expect(sdkOnly).toEqual(reference);
    const replayedCall = sdkOnly.messages.find(
      (message) => message.role === "assistant",
    )?.toolUses?.[0];
    expect(JSON.stringify(replayedCall?.input)).not.toBe(JSON.stringify(input));
    expect(JSON.stringify(sdkOnly)).not.toBe(JSON.stringify(reference));
    const withOriginalOrder = withoutExecutionId(await replay(true));
    expect(JSON.stringify(withOriginalOrder)).toBe(JSON.stringify(reference));
  });

  it("K-1 A: runTurn messages are visible identically in request.prepared and send", async () => {
    const { audit, events } = auditHarness();
    const sent: AgentWireArgs[] = [];
    await createMastraAgentRuntime().runTurn({
      instructions: "system",
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "injected at runTurn input" },
      ],
      route: ROUTE,
      systemCacheSegments: ["cached system"],
      systemVolatileTail: "volatile",
      send: async (args) => {
        sent.push(structuredClone(args));
        return response("end_turn");
      },
      audit,
      signal: new AbortController().signal,
    });

    const preparedRow = events.find((event) =>
      JSON.stringify(event).includes('"eventType":"request.prepared"'),
    );
    const prepared = findPreparedRequest(preparedRow);
    expect(prepared).toBeDefined();
    expect(sent).toHaveLength(1);
    const modelVisibleContext = prepared!.modelVisibleContext as Record<
      string,
      unknown
    >;
    // 観測。望ましいかは別。
    expect(JSON.stringify(prepared!.messages)).toBe(
      JSON.stringify(sent[0]!.messages),
    );
    expect(JSON.stringify(modelVisibleContext.systemCacheSegments)).toBe(
      JSON.stringify(sent[0]!.systemCacheSegments),
    );
    expect(sent[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: "injected at runTurn input",
    });
    expect(modelVisibleContext.systemVolatileTail).toBe(
      sent[0]!.systemVolatileTail,
    );
  });

  it("runTurn forwards the per-turn request preparation and response tap", async () => {
    const { audit, events } = auditHarness(true);
    const sent: AgentWireArgs[] = [];
    const observed: Parameters<AgentObserveResponse>[0][] = [];
    await createMastraAgentRuntime().runTurn({
      instructions: "system",
      messages: [{ role: "user", content: "start" }],
      route: ROUTE,
      systemCacheSegments: ["cached system"],
      systemVolatileTail: "volatile tail",
      prepareSend: (request) => ({
        ...request,
        messages: [...request.messages, { role: "user", content: "prepared" }],
        systemCacheSegments: null,
      }),
      observeResponse: (response) => observed.push(structuredClone(response)),
      send: async (args) => {
        sent.push(structuredClone(args));
        return {
          ...response("end_turn"),
          inputTokens: 2,
          outputTokens: 3,
        };
      },
      audit,
      signal: new AbortController().signal,
    });

    const prepared = findPreparedRequest(
      events.find((event) =>
        JSON.stringify(event).includes('"eventType":"request.prepared"'),
      ),
    );
    const modelVisibleContext = prepared!.modelVisibleContext as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(prepared!.messages)).toBe(
      JSON.stringify(sent[0]!.messages),
    );
    expect(JSON.stringify(modelVisibleContext.systemCacheSegments)).toBe(
      JSON.stringify(sent[0]!.systemCacheSegments),
    );
    expect(JSON.stringify(modelVisibleContext.systemVolatileTail)).toBe(
      JSON.stringify(sent[0]!.systemVolatileTail),
    );
    expect(sent[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: "prepared",
    });
    expect(sent[0]!.systemCacheSegments).toBeNull();
    expect(observed).toEqual([
      {
        ...response("end_turn"),
        inputTokens: 2,
        outputTokens: 3,
      },
    ]);
  });

  it("K-18: captures Mastra tool throw and result values as wire tool_result", async () => {
    const kit = await loadMastraForTest();
    const values: {
      label: string;
      execute: () => unknown;
      expected: string;
      isError: boolean;
    }[] = [
      {
        label: "Error",
        execute: () => {
          throw new Error("boom");
        },
        expected: "Error: boom",
        isError: true,
      },
      {
        label: "non-Error",
        execute: () => {
          throw "plain failure";
        },
        expected: "Error: plain failure",
        isError: true,
      },
      {
        label: "long Error",
        execute: () => {
          throw new Error("x".repeat(160));
        },
        expected: `Error: ${"x".repeat(160)}`,
        isError: true,
      },
      { label: "null", execute: () => null, expected: "null", isError: false },
      {
        label: "string",
        execute: () => "plain result",
        expected: "plain result",
        isError: false,
      },
      {
        label: "object",
        execute: () => ({ answer: 42 }),
        expected: '{"answer":42}',
        isError: false,
      },
    ];

    for (const [index, item] of values.entries()) {
      const { audit } = auditHarness();
      const sent: AgentWireArgs[] = [];
      const { model } = createAgentLanguageModel({
        originalTools: [
          {
            name: "probe",
            description: "probe",
            inputSchema: { type: "object", properties: {}, required: [] },
          },
        ],
        audit,
        send: async (args) => {
          sent.push(structuredClone(args));
          return sent.length === 1
            ? {
                blocks: [
                  {
                    type: "tool_use",
                    id: `call-${index}`,
                    name: "probe",
                    input: {},
                  },
                ],
                stopReason: "tool_use",
              }
            : response("end_turn");
        },
      });
      const agent = new kit.Agent({
        id: `k18-${index}`,
        name: `k18-${index}`,
        instructions: "system",
        model,
        maxRetries: AGENT_NO_RETRY_CONFIG.maxRetries,
        maxProcessorRetries: AGENT_NO_RETRY_CONFIG.maxProcessorRetries,
        errorProcessorDefaults: AGENT_NO_RETRY_CONFIG.errorProcessorDefaults,
        tools: {
          probe: kit.createTool({
            id: "probe",
            description: "probe",
            inputSchema: kit.jsonSchema<Record<string, never>>({
              type: "object",
              properties: {},
            }),
            execute: item.execute as () => never,
          }),
        },
      });
      await agent.generate([{ role: "user", content: item.label }], {
        ...AGENT_CALL_OPTIONS,
        maxSteps: 2,
        providerOptions: grimodexProviderOptions({
          route: ROUTE,
          systemCacheSegments: null,
          systemVolatileTail: null,
        }),
      });
      const toolResult = sent[1]?.messages.find(
        (message) => message.role === "tool_result",
      );
      expect(toolResult, item.label).toMatchObject({
        role: "tool_result",
        content: item.expected,
        isError: item.isError,
      });
    }
  });

  it("K-1 B: prepareStep can replace systemCacheSegments", async () => {
    const kit = await loadMastraForTest();
    const { audit } = auditHarness();
    const sent: AgentWireArgs[] = [];
    const { model } = createAgentLanguageModel({
      originalTools: [],
      audit,
      send: async (args) => {
        sent.push(structuredClone(args));
        return response("end_turn");
      },
    });
    const agent = new kit.Agent({
      id: "k1-prepare-step",
      name: "k1-prepare-step",
      instructions: "system",
      model,
    });
    await agent.generate([{ role: "user", content: "seed" }], {
      ...AGENT_CALL_OPTIONS,
      prepareStep: (input) => {
        const providerOptions = input.providerOptions as Record<
          string,
          Record<string, unknown>
        >;
        return {
          providerOptions: {
            ...providerOptions,
            grimodex: {
              ...providerOptions.grimodex,
              systemCacheSegments: ["changed cache"],
            },
          },
        };
      },
      providerOptions: grimodexProviderOptions({
        route: ROUTE,
        systemCacheSegments: ["original cache"],
        systemVolatileTail: null,
      }),
    });
    // 観測。望ましいかは別。
    expect(sent).toHaveLength(1);
    expect(
      sent[0]!.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["seed"]);
    expect(sent[0]!.systemCacheSegments).toEqual(["changed cache"]);
  });

  it("K-1 A2: each send after a tool result matches its prepared audit request", async () => {
    const { sent, preparedRows, preparedCountAtSend } =
      await runTwoSendToolTurn(false);
    const prepared = preparedRows.map(findPreparedRequest);

    // 観測。望ましいかは別。
    expect(sent).toHaveLength(2);
    expect(preparedRows).toHaveLength(2);
    expect(preparedCountAtSend).toEqual([1, 2]);
    expect(prepared.every((request) => request !== undefined)).toBe(true);
    expect(
      sent[1]!.messages.some((message) => message.role === "tool_result"),
    ).toBe(true);
    for (const [index, request] of prepared.entries()) {
      const modelVisibleContext = request!.modelVisibleContext as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(request!.messages)).toBe(
        JSON.stringify(sent[index]!.messages),
      );
      expect(JSON.stringify(modelVisibleContext.systemCacheSegments)).toBe(
        JSON.stringify(sent[index]!.systemCacheSegments),
      );
      expect(JSON.stringify(modelVisibleContext.systemVolatileTail)).toBe(
        JSON.stringify(sent[index]!.systemVolatileTail),
      );
    }
  });

  it("prepareSend uses its returned request on both sends and observes completed responses", async () => {
    const contexts: {
      sendIndex: number;
      previous: { stopReason: string; toolNames: readonly string[] } | null;
    }[] = [];
    const observed: Parameters<AgentObserveResponse>[0][] = [];
    const result = await runTwoSendToolTurn(false, {
      prepareSend: (request, ctx) => {
        contexts.push(ctx);
        return {
          ...request,
          messages: [
            ...request.messages,
            { role: "user", content: `prepared ${ctx.sendIndex}` },
          ],
          systemCacheSegments: null,
        };
      },
      observeResponse: (response) => observed.push(structuredClone(response)),
    });
    const prepared = result.preparedRows.map(findPreparedRequest);

    expect(result.error).toBeUndefined();
    expect(contexts).toEqual([
      { sendIndex: 0, previous: null },
      {
        sendIndex: 1,
        previous: { stopReason: "tool_use", toolNames: ["probe"] },
      },
    ]);
    expect(result.sent).toHaveLength(2);
    expect(result.preparedRows).toHaveLength(2);
    expect(result.preparedCountAtSend).toEqual([1, 2]);
    expect(result.observerCompleteCountAtObserve).toEqual([1, 2]);
    expect(observed.map(({ stopReason }) => stopReason)).toEqual([
      "tool_use",
      "end_turn",
    ]);
    expect(
      observed.map(({ blocks }) =>
        blocks
          .filter((block) => block.type === "tool_use")
          .map(({ name }) => name),
      ),
    ).toEqual([["probe"], []]);
    expect(
      observed.map(
        ({
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          cost,
        }) => [
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          cost,
        ],
      ),
    ).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ]);
    for (const [index, request] of prepared.entries()) {
      const modelVisibleContext = request!.modelVisibleContext as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(request!.messages)).toBe(
        JSON.stringify(result.sent[index]!.messages),
      );
      expect(JSON.stringify(modelVisibleContext.systemCacheSegments)).toBe(
        JSON.stringify(result.sent[index]!.systemCacheSegments),
      );
      expect(JSON.stringify(modelVisibleContext.systemVolatileTail)).toBe(
        JSON.stringify(result.sent[index]!.systemVolatileTail),
      );
      expect(modelVisibleContext.systemCacheSegments).toBeNull();
    }
  });

  it("prepareSend throws before begin on the first or later send", async () => {
    const firstError = new Error("prepare first failed");
    const first = await runTwoSendToolTurn(false, {
      prepareSend: () => {
        throw firstError;
      },
    });
    expect(first.error).toBe(firstError); // 観測: Mastra preserves the closure's Error instance.
    expect(first.events).toHaveLength(0);
    expect(first.preparedRows).toHaveLength(0);
    expect(first.sent).toHaveLength(0);

    const secondError = new Error("prepare second failed");
    const second = await runTwoSendToolTurn(false, {
      prepareSend: (_request, ctx) => {
        if (ctx.sendIndex === 1) throw secondError;
        return _request;
      },
    });
    expect(second.error).toBe(secondError); // 観測: Mastra preserves the closure's Error instance.
    expect(second.preparedRows).toHaveLength(1);
    expect(eventCount(second.events, "execution.started")).toBe(1);
    expect(eventCount(second.events, "request.dispatched")).toBe(1);
    expect(eventCount(second.events, "execution.succeeded")).toBe(1);
    expect(eventCount(second.events, "execution.failed")).toBe(0);
    expect(second.sent).toHaveLength(1);
  });

  it("the owner loop-stop sentinel survives real Agent.generate and is recognized", async () => {
    const sentinel = new MastraAgentLoopStopped();
    const result = await runTwoSendToolTurn(false, {
      prepareSend: (request, ctx) => {
        if (ctx.sendIndex === 1) throw sentinel;
        return request;
      },
    });

    expect(result.error).toBe(sentinel);
    expect(findAgentLoopStopped(result.error)).toBe(true);
    expect(findAgentLoopStopped({ cause: sentinel })).toBe(true);
    expect(result.sent).toHaveLength(1);
    expect(result.preparedRows).toHaveLength(1);
    expect(eventCount(result.events, "execution.started")).toBe(1);
    expect(eventCount(result.events, "request.dispatched")).toBe(1);
    expect(eventCount(result.events, "execution.succeeded")).toBe(1);
    expect(eventCount(result.events, "execution.failed")).toBe(0);
  });

  it("prepareSend rejects thenables before audit begin", async () => {
    const asyncPrepare = (async (request: Parameters<AgentPrepareSend>[0]) =>
      request) as unknown as AgentPrepareSend;
    const result = await runTwoSendToolTurn(false, {
      prepareSend: asyncPrepare,
    });

    expect(result.error).toBeInstanceOf(TypeError);
    expect((result.error as Error).message).toContain("prepareSend");
    expect((result.error as Error).message).toContain("must be synchronous");
    expect(result.events).toHaveLength(0);
    expect(result.sent).toHaveLength(0);
  });

  it("observeResponse throws after complete and fails the Mastra turn", async () => {
    const observerError = new Error("observer failed");
    const result = await runTwoSendToolTurn(false, {
      observeResponse: () => {
        throw observerError;
      },
    });

    expect(result.error).toBe(observerError); // 観測: Mastra preserves the closure's Error instance.
    expect(result.sent).toHaveLength(1);
    expect(result.observerCompleteCountAtObserve).toEqual([1]);
    expect(eventCount(result.events, "execution.started")).toBe(1);
    expect(eventCount(result.events, "request.dispatched")).toBe(1);
    expect(eventCount(result.events, "execution.succeeded")).toBe(1);
    expect(eventCount(result.events, "execution.failed")).toBe(0);
  });

  it("observeResponse can mutate only its clone", async () => {
    const result = await runTwoSendToolTurn(false, {
      observeResponse: (observed) => {
        const mutable = observed as AgentWireResponse;
        mutable.stopReason = "end_turn";
        mutable.blocks.push({ type: "text", content: "mutated" });
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.sent).toHaveLength(2);
    expect(result.toolCapability).toEqual({
      capability: "CAP",
      executionId: "e",
      chatMessageId: "m",
      mainOwnedProvenanceId: "p",
    });
    expect(JSON.stringify(result.events)).toContain('"stopReason":"tool_use"');
    expect(JSON.stringify(result.generated)).toContain("tool result");
    expect(JSON.stringify(result.generated)).toContain("done");
    expect(JSON.stringify(result.generated)).not.toContain("mutated");
  });

  it("async observeResponse fails closed without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await runTwoSendToolTurn(false, {
        observeResponse: async () => {
          throw new Error("async observer failed");
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.error).toBeInstanceOf(TypeError);
      expect((result.error as Error).message).toContain("observeResponse");
      expect((result.error as Error).message).toContain("must be synchronous");
      expect(eventCount(result.events, "execution.succeeded")).toBe(1);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("Q5: legacy and Main stop before another send after chat policy turns off", async () => {
    const rendererPolicy = await vi.importActual<{
      parseAiPolicy(raw: string | null | undefined): {
        toggles: { chat: boolean };
      };
    }>("../../../src/features/ai-policy/parse");
    const legacy = await vi.importActual<{
      runAgentLoop(options: never): Promise<{ stoppedReason: string }>;
    }>("../../../src/features/chat/agent/agentLoop");
    let legacyPolicy = JSON.stringify({
      preset: "custom",
      toggles: { chat: true, bodyWrite: true, analysis: true },
    });
    let legacySends = 0;
    const legacyResult = await legacy.runAgentLoop({
      messages: [{ role: "user", content: "start" }],
      tools: [{ name: "probe" }],
      tokenBudget: 100,
      sendToLLM: async () => {
        legacySends += 1;
        legacyPolicy = JSON.stringify({
          preset: "custom",
          toggles: { chat: false, bodyWrite: true, analysis: true },
        });
        return {
          blocks: [
            {
              type: "tool_use",
              id: "legacy-probe",
              name: "probe",
              input: {},
            },
          ],
          stopReason: "tool_use",
        };
      },
      executeTool: async (name: string, toolCallId: string) => ({
        name,
        toolCallId,
        params: {},
        content: null,
        summary: "probe result",
        tokensUsed: 1,
      }),
      onProgress: () => undefined,
      onTextChunk: () => undefined,
      shouldAbort: () =>
        !rendererPolicy.parseAiPolicy(legacyPolicy).toggles.chat,
      callLimitMessage: "calls",
      tokenBudgetMessage: "tokens",
    } as never);

    expect(legacySends).toBe(1);
    expect(legacyResult.stoppedReason).toBe("aborted");

    const mainChecks: number[] = [];
    const main = await runTwoSendToolTurn(false, {
      assertSendAllowed: ({ sendIndex }) => {
        mainChecks.push(sendIndex);
        if (sendIndex === 1) throw new MastraAgentLoopStopped();
      },
    });

    expect(mainChecks).toEqual([0, 1]);
    expect(findAgentLoopStopped(main.error)).toBe(true);
    expect(main.sent).toHaveLength(1);
    expect(main.preparedRows).toHaveLength(1);
    expect(eventCount(main.events, "execution.started")).toBe(1);
  });

  it("K-1 send-tap divergence: mutating messages in send leaves request.prepared unchanged", async () => {
    const { sent, preparedRows, preparedCountAtSend } =
      await runTwoSendToolTurn(true);
    const prepared = preparedRows.map(findPreparedRequest);

    // 観測。望ましいかは別。
    expect(sent).toHaveLength(2);
    expect(preparedRows).toHaveLength(2);
    expect(preparedCountAtSend).toEqual([1, 2]);
    expect(prepared.every((request) => request !== undefined)).toBe(true);
    for (const [index, request] of prepared.entries()) {
      const preparedMessages = request!.messages as unknown[];
      const sentMessages = sent[index]!.messages;
      expect(
        preparedMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "content" in message &&
            message.content === "control message",
        ),
      ).toBe(false);
      expect(sentMessages.at(-1)).toEqual({
        role: "user",
        content: "control message",
      });
      expect(JSON.stringify(preparedMessages)).not.toBe(
        JSON.stringify(sentMessages),
      );
    }
  });
});

describe("T-a runtime tool adapter", () => {
  it("executes a selected tool, derives the step limit, caps its result, and reports the original token count", async () => {
    const sent: AgentWireArgs[] = [];
    const events: unknown[] = [];
    const resultText = JSON.stringify("abcdefghijklmno");
    const binding: MastraAgentToolBinding = {
      name: "search_events",
      description: "selected owner description",
      async execute(args, context) {
        events.push(["execute", args, context.toolCallId]);
        return { text: resultText, tokensUsed: 123, summary: "found" };
      },
    };

    await createMastraAgentRuntime().runTurn(
      toolTurnInput(
        async (args) => {
          sent.push(structuredClone(args));
          return sent.length === 1
            ? {
                blocks: [
                  {
                    type: "tool_use",
                    id: "call-1",
                    name: "search_events",
                    input: {},
                  },
                ],
                stopReason: "tool_use",
              }
            : response("end_turn");
        },
        {
          bindings: [binding],
          toolDefinitions: [TOOL_SNAPSHOT],
          maxToolCalls: 1,
          maxUserQuestions: 0,
          tokenBudget: 20,
          countTokens: (text) => text.length,
          onToolStart: (event) => events.push(["start", event]),
          onToolResult: (event) => events.push(["result", event]),
        },
      ),
    );

    expect(sent).toHaveLength(2);
    expect(sent.map((args) => JSON.stringify(args.tools))).toEqual([
      JSON.stringify([TOOL_SNAPSHOT]),
      JSON.stringify([TOOL_SNAPSHOT]),
    ]);
    expect(events).toEqual([
      ["start", { toolCallId: "call-1", toolName: "search_events" }],
      ["execute", {}, "call-1"],
      [
        "result",
        {
          toolCallId: "call-1",
          toolName: "search_events",
          tokens: 123,
          summary: "found",
        },
      ],
    ]);
    const toolResult = sent[1]!.messages.find(
      (message) => message.role === "tool_result",
    );
    expect(toolResult).toMatchObject({
      role: "tool_result",
      content: '"abcd...[truncated: 元 17 tokens]',
      isError: false,
    });
  });

  it("stops at the exact maxSteps derived from both tool limits", async () => {
    const sent: AgentWireArgs[] = [];
    let executions = 0;
    const binding: MastraAgentToolBinding = {
      name: "search_events",
      description: "search",
      async execute() {
        executions += 1;
        return {
          text: JSON.stringify("result"),
          tokensUsed: 1,
          summary: "result",
        };
      },
    };

    await createMastraAgentRuntime().runTurn(
      toolTurnInput(
        async (args) => {
          sent.push(structuredClone(args));
          return sent.length <= 2
            ? {
                blocks: [
                  {
                    type: "tool_use",
                    id: `call-${sent.length}`,
                    name: "search_events",
                    input: {},
                  },
                ],
                stopReason: "tool_use",
              }
            : response("end_turn");
        },
        {
          bindings: [binding],
          toolDefinitions: [TOOL_SNAPSHOT],
          maxToolCalls: 1,
          maxUserQuestions: 1,
          tokenBudget: 100,
          countTokens: (text) => text.length,
        },
      ),
    );

    expect(sent).toHaveLength(2);
    expect(executions).toBe(2);
  });

  it("passes legacy-accepted missing and type-mismatched arguments through the permissive schema", async () => {
    const sent: AgentWireArgs[] = [];
    const executed: unknown[] = [];
    const binding: MastraAgentToolBinding = {
      name: "search_events",
      description: "search",
      async execute(args) {
        executed.push(structuredClone(args));
        return {
          text: JSON.stringify(args),
          tokensUsed: 1,
          summary: "core result",
        };
      },
    };
    const generatedTool = createMastraAgentTools({
      names: ["search_events"],
      bindings: [binding],
      tokenBudget: 100,
      countTokens: (text) => text.length,
      signal: new AbortController().signal,
    }).search_events!;
    expect(
      (
        generatedTool.inputSchema as unknown as {
          getJsonSchema(): unknown;
        }
      ).getJsonSchema(),
    ).toEqual({ type: "object", additionalProperties: true });

    await createMastraAgentRuntime().runTurn(
      toolTurnInput(
        async (args) => {
          sent.push(structuredClone(args));
          return sent.length === 1
            ? {
                blocks: [
                  {
                    type: "tool_use",
                    id: "call-missing",
                    name: "search_events",
                    input: {},
                  },
                  {
                    type: "tool_use",
                    id: "call-wrong-type",
                    name: "search_events",
                    input: { query: 42 },
                  },
                ],
                stopReason: "tool_use",
              }
            : response("end_turn");
        },
        {
          bindings: [binding],
          toolDefinitions: [TOOL_SNAPSHOT],
          maxToolCalls: 2,
          maxUserQuestions: 0,
          tokenBudget: 100,
          countTokens: (text) => text.length,
        },
      ),
    );

    expect(executed).toHaveLength(2);
    expect(executed.map((args) => JSON.stringify(args)).sort()).toEqual(
      ["{}", '{"query":42}'].sort(),
    );
    const results = sent[1]!.messages.filter(
      (message) => message.role === "tool_result",
    );
    expect(
      results.map(
        (message) => message.role === "tool_result" && message.content,
      ),
    ).toEqual(["{}", '{"query":42}']);
  });

  it("returns thrown executions as paired error results", async () => {
    const sent: AgentWireArgs[] = [];
    const results: unknown[] = [];
    const binding: MastraAgentToolBinding = {
      name: "search_events",
      description: "search",
      async execute() {
        throw new Error("core unavailable");
      },
    };

    await createMastraAgentRuntime().runTurn(
      toolTurnInput(
        async (args) => {
          sent.push(structuredClone(args));
          return sent.length === 1
            ? {
                blocks: [
                  {
                    type: "tool_use",
                    id: "call-throw",
                    name: "search_events",
                    input: {},
                  },
                ],
                stopReason: "tool_use",
              }
            : response("end_turn");
        },
        {
          bindings: [binding],
          toolDefinitions: [TOOL_SNAPSHOT],
          maxToolCalls: 1,
          maxUserQuestions: 0,
          tokenBudget: 100,
          countTokens: (text) => text.length,
          onToolResult: (event) => results.push(event),
        },
      ),
    );

    expect(results).toEqual([
      {
        toolCallId: "call-throw",
        toolName: "search_events",
        tokens: 0,
        summary: "core unavailable",
      },
    ]);
    expect(sent[1]!.messages).toContainEqual({
      role: "tool_result",
      toolUseId: "call-throw",
      content: "Error: core unavailable",
      isError: true,
    });
  });

  it("caps thrown and unavailable tool errors like the legacy loop", async () => {
    const legacy = await vi.importActual<{
      runAgentLoop(options: never): Promise<unknown>;
    }>("../../../src/features/chat/agent/agentLoop");
    const cases = [
      {
        toolName: "search_events",
        bindingName: "search_events",
        declared: ["search_events"],
        message: "x".repeat(5000),
        tokenBudget: 400,
      },
      {
        toolName: "get_scene",
        bindingName: "search_events",
        declared: [] as string[],
        message: "Tool not available this turn: get_scene",
        tokenBudget: 40,
      },
    ];

    for (const testCase of cases) {
      const firstResponse: AgentWireResponse = {
        blocks: [
          {
            type: "tool_use",
            id: "error-case",
            name: testCase.toolName,
            input: {},
          },
        ],
        stopReason: "tool_use",
      };
      const sent: AgentWireArgs[] = [];
      const binding: MastraAgentToolBinding = {
        name: testCase.bindingName,
        description: "error test",
        async execute() {
          throw new Error(testCase.message);
        },
      };
      await createMastraAgentRuntime().runTurn(
        toolTurnInput(
          async (args) => {
            sent.push(structuredClone(args));
            return sent.length === 1 ? firstResponse : response("end_turn");
          },
          {
            bindings: [binding],
            toolDefinitions: [
              ...new Set([testCase.toolName, testCase.bindingName]),
            ].map((name) => ({ ...TOOL_SNAPSHOT, name })),
            maxToolCalls: 1,
            maxUserQuestions: 0,
            tokenBudget: testCase.tokenBudget,
            countTokens: (text) => text.length,
          },
        ),
      );

      const legacySent: unknown[][] = [];
      let legacyCall = 0;
      await legacy.runAgentLoop({
        messages: [{ role: "user", content: "start" }],
        tools: testCase.declared.map((name) => ({ name })),
        tokenBudget: testCase.tokenBudget,
        maxToolCalls: 1,
        maxUserQuestions: 0,
        sendToLLM: async (messages: unknown[]) => {
          legacySent.push(structuredClone(messages));
          return legacyCall++ === 0 ? firstResponse : response("end_turn");
        },
        executeTool: async (name: string, toolCallId: string) => ({
          name,
          toolCallId,
          content: null,
          summary: testCase.message,
          tokensUsed: 0,
          error: testCase.message,
        }),
        onProgress: () => undefined,
        onTextChunk: () => undefined,
        callLimitMessage: "calls",
        tokenBudgetMessage: "tokens",
        userQuestionLimitMessage: "questions",
      } as never);

      const mainResults = sent[1]!.messages.filter(
        (message) => message.role === "tool_result",
      );
      const legacyResults = legacySent[1]!.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "tool_result",
      );
      expect(mainResults).toEqual(legacyResults);
    }
  });

  it("does not execute or send the fixed no-op result after Stop wins before execute", async () => {
    let stopped = false;
    const sent: AgentWireArgs[] = [];
    const execute = vi.fn(async () => ({
      text: "private result",
      tokensUsed: 99,
      summary: "private summary",
    }));
    const onToolStart = vi.fn();
    const onToolResult = vi.fn();
    let secondRequest: unknown;
    const firstResponse: AgentWireResponse = {
      blocks: [
        {
          type: "tool_use",
          id: "stopped-call",
          name: "search_events",
          input: { query: "private input" },
        },
      ],
      stopReason: "tool_use",
    };
    const run = createMastraAgentRuntime().runTurn(
      toolTurnInput(
        async (args) => {
          sent.push(structuredClone(args));
          if (sent.length === 1) {
            stopped = true;
            return firstResponse;
          }
          return response("end_turn");
        },
        {
          bindings: [
            {
              name: "search_events",
              description: "search",
              execute,
            },
          ],
          toolDefinitions: [TOOL_SNAPSHOT],
          maxToolCalls: 1,
          maxUserQuestions: 0,
          tokenBudget: 100,
          countTokens: (text) => text.length,
          isTurnStopped: () => stopped,
          onToolStart,
          onToolResult,
          prepareSend: (request, context) => {
            if (context.sendIndex === 1) secondRequest = request;
            return request;
          },
          assertSendAllowed: ({ sendIndex }) => {
            if (sendIndex > 0 && stopped) throw new MastraAgentLoopStopped();
          },
        },
      ),
    );
    await run.catch(() => undefined);

    expect(execute).not.toHaveBeenCalled();
    expect(onToolStart).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(JSON.stringify(secondRequest)).toContain(
      "Tool execution skipped because the turn stopped.",
    );
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain(
      "Tool execution skipped because the turn stopped.",
    );
    expect(JSON.stringify(sent)).not.toContain("private result");
  });

  it("refuses unselected M4 names without calling a binding", async () => {
    const sent: AgentWireArgs[] = [];
    const events: unknown[] = [];
    let selectedCalled = false;

    await createMastraAgentRuntime().runTurn(
      toolTurnInput(
        async (args) => {
          sent.push(structuredClone(args));
          return sent.length === 1
            ? {
                blocks: [
                  {
                    type: "tool_use",
                    id: "call-unselected",
                    name: "get_scene",
                    input: {},
                  },
                ],
                stopReason: "tool_use",
              }
            : response("end_turn");
        },
        {
          bindings: [
            {
              name: "search_events",
              description: "search",
              async execute() {
                selectedCalled = true;
                return { text: "unexpected", tokensUsed: 1, summary: "bad" };
              },
            },
          ],
          toolDefinitions: [TOOL_SNAPSHOT],
          maxToolCalls: 1,
          maxUserQuestions: 0,
          tokenBudget: 100,
          countTokens: (text) => text.length,
          onToolStart: (event) => events.push(["start", event]),
          onToolResult: (event) => events.push(["result", event]),
        },
      ),
    );

    expect(selectedCalled).toBe(false);
    expect(sent[1]!.messages).toContainEqual({
      role: "tool_result",
      toolUseId: "call-unselected",
      content: "Error: Tool not available...[truncated: 元 46 tokens]",
      isError: true,
    });
    expect(events).toEqual([
      ["start", { toolCallId: "call-unselected", toolName: "get_scene" }],
      [
        "result",
        {
          toolCallId: "call-unselected",
          toolName: "get_scene",
          tokens: 0,
          summary: "Tool not available this turn: get_scene",
        },
      ],
    ]);
  });

  it("propagates an in-flight abort signal into the binding", async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let bindingSignal: AbortSignal | undefined;
    const sent: AgentWireArgs[] = [];

    const run = createMastraAgentRuntime().runTurn(
      toolTurnInput(
        async (args) => {
          sent.push(structuredClone(args));
          return {
            blocks: [
              {
                type: "tool_use",
                id: "call-abort",
                name: "search_events",
                input: {},
              },
            ],
            stopReason: "tool_use",
          };
        },
        {
          bindings: [
            {
              name: "search_events",
              description: "search",
              async execute(_args, context) {
                bindingSignal = context.signal;
                markStarted();
                await new Promise<never>((_resolve, reject) => {
                  context.signal.addEventListener(
                    "abort",
                    () => reject(new Error("aborted")),
                    { once: true },
                  );
                });
                return { text: "unused", tokensUsed: 0, summary: "unused" };
              },
            },
          ],
          toolDefinitions: [TOOL_SNAPSHOT],
          maxToolCalls: 1,
          maxUserQuestions: 0,
          tokenBudget: 100,
          countTokens: (text) => text.length,
          signal: controller.signal,
        },
      ),
    );

    await started;
    controller.abort();
    await run;
    expect(bindingSignal?.aborted).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("rejects a binding outside the M4 allow-list before sending", async () => {
    const sent: AgentWireArgs[] = [];
    const invalid: MastraAgentToolBinding = {
      name: "not_allowed",
      description: "invalid",
      async execute() {
        return { text: "unused", tokensUsed: 0, summary: "unused" };
      },
    };
    const run = createMastraAgentRuntime().runTurn(
      toolTurnInput(
        async (args) => {
          sent.push(structuredClone(args));
          return response("end_turn");
        },
        { bindings: [invalid] },
      ),
    );

    await expect(run).rejects.toBeInstanceOf(MastraAgentToolNotAllowedError);
    expect(sent).toEqual([]);
  });
});
