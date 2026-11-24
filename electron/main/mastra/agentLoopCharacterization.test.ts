import { describe, expect, it } from "vitest";

import type { NapiBackendLike } from "../../shared/ipcContract.js";
import { createMainAgentAuditSink } from "./agentAuditSink.js";
import {
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

async function runTwoSendToolTurn(divergeAtSend: boolean) {
  const kit = await loadMastraForTest();
  const { audit, events } = auditHarness(true);
  const sent: AgentWireArgs[] = [];
  const preparedCountAtSend: number[] = [];
  const preparedRows = () =>
    events.filter((event) =>
      JSON.stringify(event).includes('"eventType":"request.prepared"'),
    );
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
          }
        : response("end_turn");
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
        execute: async () => "tool result",
      }),
    },
  });
  await agent.generate([{ role: "user", content: "start" }], {
    ...AGENT_CALL_OPTIONS,
    maxSteps: 2,
    providerOptions: grimodexProviderOptions({
      route: ROUTE,
      systemCacheSegments: ["cached system"],
      systemVolatileTail: "volatile tail",
    }),
  });
  return { sent, preparedRows: preparedRows(), preparedCountAtSend };
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
