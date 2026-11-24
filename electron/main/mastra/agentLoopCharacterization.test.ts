import { describe, expect, it } from "vitest";

import type { NapiBackendLike } from "../../shared/ipcContract.js";
import { createMainAgentAuditSink } from "./agentAuditSink.js";
import {
  type AgentObserveResponse,
  type AgentPrepareSend,
  createAgentLanguageModel,
  grimodexProviderOptions,
} from "./agentLanguageModel.js";
import {
  AGENT_CALL_OPTIONS,
  AGENT_NO_RETRY_CONFIG,
} from "./agentModelPolicy.js";
import { createMastraAgentRuntime } from "./agentRuntime.js";
import { loadMastraForTest } from "./agentModel.testSupport.js";
import type {
  AgentRoute,
  AgentWireArgs,
  AgentWireResponse,
} from "./agentWire.js";

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

async function runTwoSendToolTurn(
  divergeAtSend: boolean,
  hooks: {
    prepareSend?: AgentPrepareSend;
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
