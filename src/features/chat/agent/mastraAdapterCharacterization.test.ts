/**
 * Mastra 移行 MP-2：特性試験。現行の loop（本物の `runAgentLoop` ＋ `chatApi.sendAgentMessage`）と、
 * Mastra の本物の `Agent` ＋ adapter が、Rust（`send_agent_message`）へ渡す args を比べる。
 *
 * - 現行側：`invoke("send_agent_message", args)` だけ差し替え、呼出し時点で args を複製して捕まえる
 *   （loop が呼出し後に会話の配列を書き換えるため）。
 * - Mastra 側：`send` を fake にして args を捕まえる（Mastra は `loadMastraForTest()` で env の固定と通信の hook を
 *   当ててから読む）。
 * - 比べるのは `JSON.stringify` の bytes。`auditContext`（`executionId` は呼出しごとの値）と `chatMessageId` も含めて
 *   一致させる：両側の audit の fake が、同じ transport 文脈から同じ値（`exec-<呼出し番号>`、`asst-1`）を返す。
 * - 両経路の生の args を `electron/main/mastra/__fixtures__/wire-args/<route>-<scene>.json` に書く
 *   （Rust の wire 試験が読む。形式は README 相当の下のコメント）。通常は file との一致を確かめるだけで、
 *   更新は `GRIMODEX_UPDATE_WIRE_FIXTURES=1` のときだけ。
 *
 * wire fixture の形式：`{ "current": [call0, call1, ...], "adapter": [call0, call1, ...] }`。各 call は
 * `N-API sendAgentMessage(args, settings, apiKey)` の第 1 引数（`AgentRequest` の camelCase の JSON。
 * `callerIdentity` は含まない＝main が付ける）。`current` ＝ renderer の loop が組んだ args、
 * `adapter` ＝ Mastra の Agent ＋ adapter が組んだ args。2 つは bytes 一致している（試験が assert）。
 * 1 file 1 場面。file 名は `<route>-<scene>.json`。
 */
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
}));
const auditMocks = vi.hoisted(() => ({
  begin: vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    expectedWorkspacePath: "/workspace",
    operationId: input.operationId ?? "operation",
    executionId: input.executionId ?? "execution",
    parentExecutionId: input.parentExecutionId ?? null,
    startedAt: 1,
  })),
  dispatched: vi.fn(async (_handle: unknown, _details?: unknown) => undefined),
  complete: vi.fn(
    async (
      _handle: unknown,
      _completion: { usage: unknown; response: unknown },
    ) => undefined,
  ),
  fail: vi.fn(async (_handle: unknown, _failure: unknown) => undefined),
}));
vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecution: auditMocks.begin,
  markAiAuditDispatched: auditMocks.dispatched,
  completeAiAuditExecution: auditMocks.complete,
  failAiAuditExecution: auditMocks.fail,
  cancelAiAuditExecution: vi.fn(async () => undefined),
  attemptAiAuditPersistenceFailureTerminal: vi.fn(async () => undefined),
  recordAiAuditPartial: vi.fn(async () => undefined),
  recordAiAuditPartials: vi.fn(async () => undefined),
}));
// agentLoop.test.ts と同じ：tokenizer の WASM は使わない。1 char = 1 token。
vi.mock("@/features/chat/contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
  countTokens: (text: string) => (text ? text.length : 0),
}));

import {
  AGENT_CALL_OPTIONS,
  AGENT_NO_RETRY_CONFIG,
} from "../../../../electron/main/mastra/agentModelPolicy";
import {
  AGENT_NEUTRAL_MODEL_ID,
  AGENT_NEUTRAL_PROVIDER,
  createAgentLanguageModel,
  grimodexProviderOptions,
} from "../../../../electron/main/mastra/agentLanguageModel";
import {
  AGENT_WIRE_ARG_KEYS,
  type AgentWireArgs,
  type AgentWireCapabilityGrant,
  type AgentWireMessage,
  type AgentWireToolDefinition,
  type JsonObject,
  type AgentRoute,
} from "../../../../electron/main/mastra/agentWire";
import {
  createRecordingAudit,
  loadMastraForTest,
  type MastraTestKit,
} from "../../../../electron/main/mastra/agentModel.testSupport";
import { runAgentLoop } from "./agentLoop";
import { sendAgentMessage } from "../chatApi";
import { DEFAULT_AI_SETTINGS } from "../types";
import { useAiSettingsStore } from "../store";
import { snapshotAgentTools } from "./toolDefinitions";
import type {
  AgentAuthorityCapabilityGrant,
  AgentMessagePayload,
  AgentToolDefinition,
  ToolResult,
} from "./agentTypes";
import {
  CACHE_SEGMENTS,
  DEFAULT_TOKEN_BUDGET,
  NEW_USER,
  RAW_HISTORY,
  ROUTES,
  SMALL_TOOLS,
  SYSTEM_PROMPT,
  VOLATILE_TAIL,
  asWireTools,
  buildAgentMsgs,
  buildMastraMessages,
  formatToolResultContent,
  scenesFor,
  type RouteCase,
  type Scene,
} from "./mastraAdapterScenarios.testSupport";

// ---- 型の相互代入（renderer の型と adapter の wire 型が離れたら compile で落ちる） ----
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const toolsAreMutual: Mutual<AgentToolDefinition, AgentWireToolDefinition> =
  true;
const messagesAreMutual: Mutual<AgentMessagePayload, AgentWireMessage> = true;
const grantsAreMutual: Mutual<
  AgentAuthorityCapabilityGrant,
  AgentWireCapabilityGrant
> = true;

const TRANSPORT = {
  projectId: "proj-1",
  pathId: "chat_agent_main",
  operationId: "turn-1",
  parentExecutionId: null,
  chatMessageId: "asst-1",
} as const;

const FIXTURE_DIR = path.resolve(
  __dirname,
  "../../../../electron/main/mastra/__fixtures__/wire-args",
);
const UPDATE_FIXTURES = process.env.GRIMODEX_UPDATE_WIRE_FIXTURES === "1";

const toJsonObject = (value: object): JsonObject =>
  JSON.parse(JSON.stringify(value));
/** tool 定義の inputSchema を Mastra の tool 用に複製する（JSON Schema の型へは JSON を介して渡す）。 */
const toJsonSchema = (def: AgentToolDefinition) =>
  JSON.parse(JSON.stringify(def.inputSchema));

function routeToAdapterRoute(route: RouteCase): AgentRoute {
  const tp = route.thinkingParams;
  return {
    thinking: tp.thinking === undefined ? null : toJsonObject(tp.thinking),
    effort: tp.effort ?? null,
    reasoningEnabled: tp.reasoningEnabled ?? null,
    reasoningEffort: tp.reasoningEffort ?? null,
    apiVariant: route.apiVariant,
    webSearch: route.webSearch === null ? null : toJsonObject(route.webSearch),
    model: route.model,
    provider: route.provider,
    endpointId: route.endpointId,
    expectedOllamaEndpoint: null,
    ...(route.requestMaxOutputTokens != null
      ? { requestMaxOutputTokens: route.requestMaxOutputTokens }
      : {}),
    ...(route.resolvedToolProtocol != null
      ? { resolvedToolProtocol: route.resolvedToolProtocol }
      : {}),
  };
}

interface Run {
  calls: Record<string, unknown>[];
  executed: { name: string; input: unknown }[];
  finalText: string;
  auditCounts: {
    begin: number;
    dispatched: number;
    complete: number;
    fail: number;
  };
  completions: { usage: unknown; response: unknown }[];
}

/** 現行側：本物の runAgentLoop → chatApi.sendAgentMessage → invoke("send_agent_message", args)。 */
async function runCurrent(route: RouteCase, scene: Scene): Promise<Run> {
  vi.clearAllMocks();
  const script = scene.script(route);
  const calls: Record<string, unknown>[] = [];
  let call = 0;
  invokeMock.mockImplementation(async (command: string, args: unknown) => {
    if (command !== "send_agent_message") return undefined;
    // runAgentLoop は呼出し後に conversation を書き換えるので、呼出し時点で深く複製する。
    calls.push(JSON.parse(JSON.stringify(args)));
    return JSON.parse(
      JSON.stringify(script[call++] ?? script[script.length - 1]),
    );
  });
  useAiSettingsStore.setState({
    settings: {
      ...DEFAULT_AI_SETTINGS,
      provider: route.provider,
      model: route.model,
    },
  });
  const executed: Run["executed"] = [];
  // chatTurnStoreActions.ts の sendToLLM が chatApi.sendAgentMessage へ渡す引数の写し（finalized 無しの経路）。
  const sendToLLM = (
    messages: AgentMessagePayload[],
    tools: AgentToolDefinition[],
  ) =>
    sendAgentMessage(
      messages,
      tools,
      { ...TRANSPORT, executionId: `exec-${call}` },
      route.thinkingParams,
      route.cache ? CACHE_SEGMENTS : undefined,
      route.apiVariant,
      route.webSearch,
      route.cache ? VOLATILE_TAIL : undefined,
      route.model,
      null,
      null,
      route.requestMaxOutputTokens,
      route.provider,
      route.endpointId,
      route.resolvedToolProtocol,
      null,
    );
  const result = await runAgentLoop({
    messages: buildAgentMsgs(scene.strip ?? true, scene.history ?? RAW_HISTORY),
    tools: structuredClone(SMALL_TOOLS),
    tokenBudget: scene.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    maxToolCalls: 10,
    callLimitMessage: "CALL_LIMIT",
    tokenBudgetMessage: "TOKEN_LIMIT",
    sendToLLM,
    executeTool: async (name, toolCallId, params): Promise<ToolResult> => {
      executed.push({ name, input: params });
      const outcome = scene.results[name];
      if (outcome?.err)
        return {
          toolCallId,
          name,
          content: null,
          summary: outcome.err,
          tokensUsed: 5,
          error: outcome.err,
        };
      return {
        toolCallId,
        name,
        content: outcome?.ok,
        summary: outcome?.summary ?? "ok",
        tokensUsed: 5,
      };
    },
    onProgress: () => {},
    onTextChunk: () => {},
  });
  return {
    calls,
    executed,
    finalText: result.finalText,
    auditCounts: {
      begin: auditMocks.begin.mock.calls.length,
      dispatched: auditMocks.dispatched.mock.calls.length,
      complete: auditMocks.complete.mock.calls.length,
      fail: auditMocks.fail.mock.calls.length,
    },
    completions: auditMocks.complete.mock.calls.map(([, completion]) => ({
      usage: completion.usage,
      response: completion.response,
    })),
  };
}

/** Mastra 側：本物の Agent ＋ adapter。`send` だけ fake。 */
async function runMastra(
  kit: MastraTestKit,
  route: RouteCase,
  scene: Scene,
  method: "generate" | "stream" = "generate",
): Promise<Run> {
  const script = scene.script(route);
  const calls: Record<string, unknown>[] = [];
  let call = 0;
  const audit = createRecordingAudit({
    expectedWorkspacePath: "/workspace",
    projectId: TRANSPORT.projectId,
    operationId: TRANSPORT.operationId,
    parentExecutionId: null,
    pathId: TRANSPORT.pathId,
    chatMessageId: TRANSPORT.chatMessageId,
  });
  const { model } = createAgentLanguageModel({
    originalTools: asWireTools(SMALL_TOOLS),
    audit,
    send: async (args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      return JSON.parse(
        JSON.stringify(script[call++] ?? script[script.length - 1]),
      );
    },
  });
  const executed: Run["executed"] = [];
  const tools = Object.fromEntries(
    SMALL_TOOLS.map((def) => [
      def.name,
      kit.createTool({
        id: def.name,
        description: def.description,
        inputSchema: kit.jsonSchema<Record<string, unknown>>(toJsonSchema(def)),
        execute: async (input: Record<string, unknown>) => {
          executed.push({ name: def.name, input });
          // renderer の整形（JSON.stringify／null は summary／失敗は throw）を execute 側で再現して文字列で返す。
          return formatToolResultContent(
            scene.results[def.name],
            scene.tokenBudget,
          );
        },
      }),
    ]),
  );
  const agent = new kit.Agent({
    id: `mp2-${route.id}-${scene.id}`,
    name: "mp2",
    instructions: SYSTEM_PROMPT,
    model,
    tools,
    ...AGENT_NO_RETRY_CONFIG,
  });
  const callOptions = {
    ...AGENT_CALL_OPTIONS,
    providerOptions: grimodexProviderOptions({
      route: routeToAdapterRoute(route),
      systemCacheSegments: route.cache ? CACHE_SEGMENTS : null,
      systemVolatileTail: route.cache ? VOLATILE_TAIL : null,
    }),
  };
  const messages = buildMastraMessages(
    scene.strip ?? true,
    scene.history ?? RAW_HISTORY,
  );
  let finalText: string;
  if (method === "generate") {
    const result = await agent.generate(messages, callOptions);
    // 現行の finalText は最後の応答の text だけ。Mastra の result.text は全 step の連結（S6）。
    finalText = result.steps[result.steps.length - 1]?.text ?? "";
  } else {
    const output = await agent.stream(messages, callOptions);
    for await (const chunk of output.fullStream) void chunk;
    const steps = await output.steps;
    finalText = steps[steps.length - 1]?.text ?? "";
  }
  return {
    calls,
    executed,
    finalText,
    auditCounts: {
      begin: audit.count("begin"),
      dispatched: audit.count("dispatched"),
      complete: audit.count("complete"),
      fail: audit.count("fail"),
    },
    completions: audit.events.flatMap((event) =>
      event.type === "complete"
        ? [
            {
              usage: event.completion.usage,
              response: event.completion.response,
            },
          ]
        : [],
    ),
  };
}

/** 1 call 1 行の JSON（diff が読める。Rust の試験は普通の JSON として読む）。 */
function renderFixture(current: unknown[], adapter: unknown[]): string {
  const lines = (calls: unknown[]) =>
    calls.map((call) => JSON.stringify(call)).join(",\n");
  return `{"current":[\n${lines(current)}\n],"adapter":[\n${lines(adapter)}\n]}\n`;
}

describe("Mastra adapter の特性試験（現行の loop と bytes 一致）", () => {
  let kit: MastraTestKit;
  const cases = ROUTES.flatMap((route) =>
    scenesFor(route).map((scene) => ({ route, scene })),
  );

  beforeEach(async () => {
    kit = await loadMastraForTest();
  });

  afterAll(() => {
    // 試験中の外部への接続は 0（env の固定と hook の併用）。
    expect(kit.guard.external()).toEqual([]);
  });

  it("型：renderer の型と adapter の wire 型が相互に代入できる", () => {
    expect([toolsAreMutual, messagesAreMutual, grantsAreMutual]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("route は 6 つ、場面は A〜F（全 route）と G（Responses の 2 route）", () => {
    expect(ROUTES.map((route) => route.id)).toEqual([
      "anthropic",
      "openai-chat",
      "openai-responses",
      "openrouter-chat-claude",
      "openrouter-chat-other",
      "openrouter-responses",
    ]);
    expect(cases.length).toBe(6 * (6 + 2 + 4) + 2);
  });

  it.each(
    cases.map(
      (entry) => [`${entry.route.id} / ${entry.scene.id}`, entry] as const,
    ),
  )(
    "%s：args が bytes 一致し、tool 実行・audit・fixture も一致する",
    async (_label, { route, scene }) => {
      const current = await runCurrent(route, scene);
      const adapter = await runMastra(kit, route, scene);

      expect(current.calls.length).toBe(scene.script(route).length);
      // args の bytes 一致（auditContext・chatMessageId を含む）。
      expect(adapter.calls.map((call) => JSON.stringify(call))).toEqual(
        current.calls.map((call) => JSON.stringify(call)),
      );
      // renderer の args の key は adapter の wire 型の key に含まれる（他 lane が足した field を見落とさない）。
      for (const call of current.calls) {
        for (const key of Object.keys(call)) {
          expect(AGENT_WIRE_ARG_KEYS as readonly string[]).toContain(key);
        }
      }
      // tool の実行（名前・入力の bytes・順序）、最終 text。
      expect(JSON.stringify(adapter.executed)).toBe(
        JSON.stringify(current.executed),
      );
      expect(adapter.finalText).toBe(current.finalText);
      // audit：begin／dispatched／complete が呼出し 1 回に 1 回、fail 無し。complete の生の値（usage・response）が一致。
      expect(adapter.auditCounts).toEqual(current.auditCounts);
      expect(adapter.completions).toEqual(current.completions);

      const file = path.join(FIXTURE_DIR, `${route.id}-${scene.id}.json`);
      const rendered = renderFixture(current.calls, adapter.calls);
      if (UPDATE_FIXTURES) {
        fs.mkdirSync(FIXTURE_DIR, { recursive: true });
        fs.writeFileSync(file, rendered);
      } else {
        expect(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe(
          rendered,
        );
      }
    },
  );

  it("fixture に余分な file が無い", () => {
    const expected = new Set(
      cases.map((entry) => `${entry.route.id}-${entry.scene.id}.json`),
    );
    expect(new Set(fs.readdirSync(FIXTURE_DIR))).toEqual(expected);
  });

  it("doStream でも、doGenerate と同じ args を送る（非 stream の応答から合成）", async () => {
    for (const route of ROUTES) {
      for (const scene of scenesFor(route).filter(
        (entry) =>
          entry.id === "A-one-tool" ||
          entry.id === "G-responses-signature-only" ||
          entry.id === "E-nosig-multitext",
      )) {
        const generated = await runMastra(kit, route, scene, "generate");
        const streamed = await runMastra(kit, route, scene, "stream");
        expect(
          streamed.calls.map((call) => JSON.stringify(call)),
          `${route.id}/${scene.id}`,
        ).toEqual(generated.calls.map((call) => JSON.stringify(call)));
        expect(streamed.finalText).toBe(generated.finalText);
      }
    }
  });

  it("44 本の tool：名前が manifest と一致し、args.tools が snapshotAgentTools と bytes 一致（その場で計算）", async () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../../agent-tool-manifest.json"),
        "utf8",
      ),
    ) as { tools: { name: string }[] };
    const snapshot = snapshotAgentTools();
    expect(snapshot.map((tool) => tool.name).sort()).toEqual(
      manifest.tools.map((tool) => tool.name).sort(),
    );
    expect(snapshot.length).toBe(44);

    for (const provider of ["anthropic", "openai", "openrouter"] as const) {
      const route: AgentRoute = {
        ...routeToAdapterRoute(ROUTES[0]!),
        provider,
        model: provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-5",
      };
      const calls: AgentWireArgs[] = [];
      const { model } = createAgentLanguageModel({
        originalTools: asWireTools(snapshot),
        audit: createRecordingAudit({
          expectedWorkspacePath: "/workspace",
          projectId: null,
          operationId: "op",
          parentExecutionId: null,
          pathId: "chat_agent_main",
        }),
        send: async (args) => {
          calls.push(structuredClone(args));
          return {
            blocks: [{ type: "text", content: "ok" }],
            stopReason: "end_turn",
          };
        },
      });
      const tools = Object.fromEntries(
        snapshot.map((def) => [
          def.name,
          kit.createTool({
            id: def.name,
            description: def.description,
            inputSchema: kit.jsonSchema<Record<string, unknown>>(
              toJsonSchema(def),
            ),
            execute: async () => "unused",
          }),
        ]),
      );
      const agent = new kit.Agent({
        id: `mp2-44-${provider}`,
        name: "mp2",
        instructions: SYSTEM_PROMPT,
        model,
        tools,
        ...AGENT_NO_RETRY_CONFIG,
      });
      await agent.generate([{ role: "user", content: NEW_USER }], {
        ...AGENT_CALL_OPTIONS,
        providerOptions: grimodexProviderOptions({
          route,
          systemCacheSegments: null,
          systemVolatileTail: null,
        }),
      });
      expect(calls.length).toBe(1);
      expect(JSON.stringify(calls[0]!.tools), provider).toBe(
        JSON.stringify(snapshot),
      );
    }
  });

  it("Mastra に見せる provider と modelId は中立", () => {
    const { model } = createAgentLanguageModel({
      originalTools: [],
      audit: createRecordingAudit({
        expectedWorkspacePath: "/workspace",
        projectId: null,
        operationId: "op",
        parentExecutionId: null,
        pathId: "chat_agent_main",
      }),
      send: async () => ({ blocks: [], stopReason: "end_turn" }),
    });
    expect(model.provider).toBe(AGENT_NEUTRAL_PROVIDER);
    expect(model.modelId).toBe(AGENT_NEUTRAL_MODEL_ID);
  });
});
