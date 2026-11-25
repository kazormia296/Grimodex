/**
 * adapter（`agentLanguageModel.ts`）の試験。Mastra は本物（`loadMastraForTest()`：env の固定と通信の hook の後に読む）。
 * 現行の loop との bytes 一致は `src/features/chat/agent/mastraAdapterCharacterization.test.ts`。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LanguageModel } from "ai";
import type { MastraModelConfig } from "@mastra/core/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// env の固定の前に Mastra が読む値の対照用（固定で除かれることを確かめる）。load の前に置く。
process.env.OPENAI_API_KEY = "sk-test-dummy-openai";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-dummy";
process.env.OM_DEBUG = "1";

import {
  AGENT_NEUTRAL_MODEL_ID,
  AGENT_NEUTRAL_PROVIDER,
  createAgentLanguageModel,
  grimodexProviderOptions,
  parseGrimodexOptions,
  parseWireResponse,
} from "./agentLanguageModel.js";
import {
  AGENT_CALL_OPTIONS,
  AGENT_NO_RETRY_CONFIG,
  AgentModelError,
} from "./agentModelPolicy.js";
import {
  createRecordingAudit,
  installNetworkGuard,
  loadMastraForTest,
  type MastraTestKit,
  type RecordingAudit,
} from "./agentModel.testSupport.js";
import {
  AGENT_WIRE_ARG_KEYS,
  AGENT_WIRE_ARG_KEYS_EXHAUSTIVE,
  type AgentRoute,
  type AgentWireArgs,
  type AgentWireResponse,
  type AgentWireToolDefinition,
} from "./agentWire.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;
type CallOptions = Parameters<LanguageModelV4["doGenerate"]>[0];

const TOOLS: AgentWireToolDefinition[] = [
  {
    name: "search_events",
    description: "イベントを検索する。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 0, description: "件数の上限。" },
        query: { type: "string", description: "検索語。" },
      },
      required: ["query"],
    },
  },
];

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

const providerOptions = (route: Partial<AgentRoute> = {}) =>
  grimodexProviderOptions({
    route: { ...ROUTE, ...route },
    systemCacheSegments: null,
    systemVolatileTail: null,
  });

const AUDIT_CONTEXT = {
  expectedWorkspacePath: "/workspace",
  projectId: "proj-1",
  operationId: "turn-1",
  parentExecutionId: null,
  pathId: "chat_agent_main",
  chatMessageId: "asst-1",
} as const;

const toolStep = (
  id: string,
  extra: Partial<AgentWireResponse> = {},
): AgentWireResponse => ({
  blocks: [
    {
      type: "tool_use",
      id,
      name: "search_events",
      input: { query: "a", limit: 1 },
    },
  ],
  stopReason: "tool_use",
  ...extra,
});
const endStep = (text = "終わり"): AgentWireResponse => ({
  blocks: [{ type: "text", content: text }],
  stopReason: "end_turn",
});

let kit: MastraTestKit;
// `ai` の実行時の読込も env の固定と通信 hook の後（`loadMastraForTest()` の後）に行う。
let APICallError: typeof import("ai").APICallError;
beforeAll(async () => {
  kit = await loadMastraForTest();
  ({ APICallError } = await import("ai"));
});
afterAll(() => {
  // 試験中の外部への接続は 0。
  expect(kit.guard.external()).toEqual([]);
});

interface Harness {
  audit: RecordingAudit;
  sends: AgentWireArgs[];
  signals: (AbortSignal | undefined)[];
  model: ReturnType<typeof createAgentLanguageModel>["model"];
  capabilities: ReturnType<typeof createAgentLanguageModel>["capabilities"];
  stats: ReturnType<typeof createAgentLanguageModel>["stats"];
  order: string[];
}

/** `script` を順に返す send。関数なら呼出しごとに評価する（投げる試験用）。 */
function harness(
  script: (AgentWireResponse | (() => AgentWireResponse))[],
): Harness {
  const sends: AgentWireArgs[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const order: string[] = [];
  const base = createRecordingAudit(AUDIT_CONTEXT);
  const audit: RecordingAudit = {
    ...base,
    begin: async (request) => {
      order.push("begin");
      return base.begin(request);
    },
    dispatched: async (handle) => {
      order.push("dispatched");
      return base.dispatched(handle);
    },
    complete: async (handle, completion) => {
      order.push("complete");
      return base.complete(handle, completion);
    },
    fail: async (handle, error) => {
      order.push("fail");
      return base.fail(handle, error);
    },
  };
  let call = 0;
  const created = createAgentLanguageModel({
    originalTools: TOOLS,
    audit,
    send: async (args, context) => {
      order.push("send");
      sends.push(structuredClone(args));
      signals.push(context.signal);
      const next = script[Math.min(call++, script.length - 1)]!;
      return typeof next === "function" ? next() : structuredClone(next);
    },
  });
  return { audit, sends, signals, order, ...created };
}

function makeAgent(h: Harness, config: object = AGENT_NO_RETRY_CONFIG) {
  const tools = {
    search_events: kit.createTool({
      id: "search_events",
      description: "d",
      inputSchema: kit.jsonSchema<{ query: string; limit?: number }>({
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
      }),
      execute: async () => "ok",
    }),
  };
  return new kit.Agent({
    id: "mp2",
    name: "mp2",
    instructions: "SYS",
    model: h.model,
    tools,
    ...config,
  });
}

const USER = [{ role: "user" as const, content: "hi" }];

// ---------------------------------------------------------------------------

describe("型と契約", () => {
  it("model は ai の LanguageModel（v4）と Mastra の MastraModelConfig の両方に代入できる", () => {
    const { model } = harness([endStep()]);
    const asAi: LanguageModel = model;
    const asMastra: MastraModelConfig = model;
    expect(asAi).toBe(asMastra);
    expect(model.specificationVersion).toBe("v4");
  });

  it("route は AgentWireArgs の残り全部：欠けた route・余分な route は compile で落ちる", () => {
    // @ts-expect-error route の key が欠けている
    const missing: AgentRoute = { thinking: null };
    // @ts-expect-error route に無い key
    const extra: AgentRoute = { ...ROUTE, unknownField: 1 };
    expect([missing, extra].length).toBe(2);
    expect(AGENT_WIRE_ARG_KEYS_EXHAUSTIVE).toBe(true);
  });

  it("route を読む側も全 field を要求する（key が欠けると投げる）", () => {
    const options = providerOptions();
    expect(parseGrimodexOptions(options).route).toEqual(ROUTE);
    const broken = structuredClone(options);
    const route = broken.grimodex.route;
    if (typeof route !== "object" || route === null || Array.isArray(route))
      throw new Error("fixture");
    delete route.effort;
    expect(() => parseGrimodexOptions(broken)).toThrow(
      /route\.effort is missing/,
    );
    expect(() => parseGrimodexOptions({})).toThrow(
      /providerOptions\.grimodex is missing/,
    );
    expect(() => parseGrimodexOptions(undefined)).toThrow(AgentModelError);
  });

  it("AgentWireArgs の key は Rust の AgentRequest の field（＋ main が読む chatMessageId）と一致する", () => {
    const source = fs.readFileSync(
      path.join(REPO, "electron/native/grimodex-node/src/lib.rs"),
      "utf8",
    );
    const body = /struct AgentRequest \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body, "Rust の struct AgentRequest").toBeDefined();
    const camel = (name: string) =>
      name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    const rustKeys = [
      ...(body ?? "").matchAll(/^\s+(?:pub\s+)?([a-z_]+):/gm),
    ].map((m) => camel(m[1]!));
    expect(rustKeys.length).toBeGreaterThan(10);
    expect(
      [...AGENT_WIRE_ARG_KEYS].filter((key) => key !== "chatMessageId").sort(),
    ).toEqual([...rustKeys].sort());
  });

  it("IPC 契約は send_agent_message の args を検証する（requirePresent の key が wire 型に含まれる）", () => {
    const contract = fs.readFileSync(
      path.join(REPO, "electron/shared/ipcContract.ts"),
      "utf8",
    );
    const block =
      /send_agent_message: \{\s*run:[\s\S]*?resolveRequiredAiKeyAndSettings/.exec(
        contract,
      )?.[0] ?? "";
    expect(block).not.toBe("");
    for (const [, key] of block.matchAll(
      /(?:requirePresent|optionalString|validateOptional\w+)\(\s*a,\s*"(\w+)"/g,
    )) {
      expect(AGENT_WIRE_ARG_KEYS as readonly string[]).toContain(key);
    }
  });
});

describe("境界（注入だけ・未配線）", () => {
  const sources = [
    "agentLanguageModel.ts",
    "agentModelPolicy.ts",
    "agentWire.ts",
  ].map((file) => ({
    file,
    text: fs.readFileSync(path.join(HERE, file), "utf8"),
  }));

  it("N-API・Electron・子 process・network を import せず、`as unknown as` を使わない", () => {
    for (const { file, text: source } of sources) {
      // コメントは除いて見る（説明に `sendAgentMessage` などの語を書ける）。
      const text = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(text, file).not.toMatch(
        /from "(?:electron|node:child_process|node:net|node:http|node:https|node:fs|node:dns)"/,
      );
      expect(text, file).not.toMatch(
        /\.node["']|sendAgentMessage|safeStorage|callerIdentity\s*[:=]\s*\{/,
      );
      expect(text, file).not.toContain("as unknown as");
      // `@mastra/*`・`ai` は型だけ（実行時の import を main に持ち込まない）。
      for (const match of text.matchAll(
        /^import\s+(type\s+)?[^;]*?from "(@mastra\/[^"]+|ai)";/gm,
      )) {
        expect(match[1], `${file}: ${match[0]}`).toBe("type ");
      }
    }
  });

  it("製品の経路（electron/main・preload・shared の全 file、subdirectory と動的 import を含む）が mastra/ を参照するのは、owner と loader の決まった specifier だけ", () => {
    const own = path.join(REPO, "electron/main/mastra");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return full === own ? [] : walk(full);
        return /\.(?:ts|tsx|mjs|cjs|js)$/.test(entry.name) &&
          !/\.(?:test|spec|testSupport)\.[a-z]+$/.test(entry.name)
          ? [full]
          : [];
      });
    const files = ["main", "preload", "shared"].flatMap((dir) =>
      walk(path.join(REPO, "electron", dir)),
    );
    expect(files.length).toBeGreaterThan(50);
    // static／動的 import・require・再 export のどれでも、mastra/ 配下を指す specifier を全部集める。
    const reference =
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]*\/mastra\/[^"'`]*)["'`]/g;
    // MP-3c：main の owner（sink・方針・型）と lazy loader（runtime の型だけ）。adapter（agentLanguageModel）と
    // runtime の実体は、3 つ目の bundle の中にだけあり、main は `require(変数)` で読む（loader）。
    // R2-b2：owner は R3 の loop 規則（agentLoopRules、import の無い pure module）も値で読む（下の別の試験で pure を固定）。
    const allowed: Record<string, readonly string[]> = {
      "mastraTurnOwner.ts": [
        "./mastra/agentAuditSink.js",
        "./mastra/agentLoopRules.js",
        "./mastra/agentModelPolicy.js",
        "./mastra/agentRuntime.js",
        "./mastra/agentWire.js",
      ],
      "mastraAgentLoader.ts": ["./mastra/agentRuntime.js"],
      "mastraTurnReadBindings.ts": ["./mastra/agentRuntime.js"],
    };
    const found: Record<string, string[]> = {};
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const specifiers = [...text.matchAll(reference)].map((m) => m[1]!);
      if (specifiers.length > 0) found[path.basename(file)] = specifiers.sort();
      // 実体（値）を読み込むのは sink と方針だけ。runtime と wire は型だけ。
      for (const match of text.matchAll(
        /^import\s+(type\s+)?[^;]*?from\s+"([^"]*\/mastra\/[^"]+)";/gms,
      )) {
        const isType = match[1] !== undefined;
        if (/agentRuntime|agentWire/.test(match[2]!)) {
          expect(isType, `${file}: ${match[2]}`).toBe(true);
        }
        expect(match[2], file).not.toMatch(/agentLanguageModel/);
      }
    }
    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(allowed).map(([file, list]) => [file, [...list].sort()]),
      ),
    );
  });

  it("owner が値として読む R3 の loop 規則（agentLoopRules）は pure：import は型だけで、動的 import・require も無い", () => {
    const text = fs.readFileSync(path.join(HERE, "agentLoopRules.ts"), "utf8");
    for (const match of text.matchAll(
      /^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms,
    )) {
      expect(match[1], `agentLoopRules.ts: ${match[0]}`).toBe("type ");
    }
    expect(text).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
  });
});

describe("env の固定と通信 0", () => {
  it("Mastra を読む前に固定が当たり、dummy key・OM_DEBUG は除かれている", () => {
    expect(process.env.MASTRA_TELEMETRY_DISABLED).toBe("1");
    expect(process.env.MASTRA_OFFLINE).toBe("true");
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.OM_DEBUG).toBeUndefined();
    expect(kit.originalEnv.OPENAI_API_KEY).toBe("sk-test-dummy-openai");
  });

  it("通信の hook は外部への接続を記録して拒否する（陰性対照）", async () => {
    const guard = installNetworkGuard();
    try {
      await expect(fetch("https://example.invalid/")).rejects.toThrow(
        /network guard/,
      );
      expect(guard.external().map((entry) => entry.kind)).toEqual(["fetch"]);
    } finally {
      guard.restore();
    }
  });
});

describe("provider の会計（usage）と stopReason", () => {
  const prompt: CallOptions["prompt"] = [
    { role: "system", content: "SYS" },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  const usageResponse: AgentWireResponse = {
    blocks: [{ type: "text", content: "x" }],
    stopReason: "end_turn",
    inputTokens: 520,
    outputTokens: 30,
    cacheReadTokens: 400,
    cacheWriteTokens: 50,
    cost: 0.0123,
  };

  it("Anthropic は input が cache を含まない：total ＝ input ＋ read ＋ write", async () => {
    const h = harness([usageResponse]);
    const result = await h.model.doGenerate({
      prompt,
      providerOptions: providerOptions({ provider: "anthropic" }),
    });
    expect(result.usage.inputTokens).toEqual({
      total: 970,
      noCache: 520,
      cacheRead: 400,
      cacheWrite: 50,
    });
    expect(result.usage.outputTokens.total).toBe(30);
  });

  it.each(["openai", "openrouter"] as const)(
    "%s は prompt_tokens が cache 読込を含む：total ＝ input（足さない）",
    async (provider) => {
      const h = harness([{ ...usageResponse, cacheWriteTokens: null }]);
      const result = await h.model.doGenerate({
        prompt,
        providerOptions: providerOptions({ provider }),
      });
      expect(result.usage.inputTokens).toEqual({
        total: 520,
        noCache: 120,
        cacheRead: 400,
        cacheWrite: undefined,
      });
    },
  );

  it("OpenRouter で cacheWrite が非 null でも、noCache は input から read だけを引く（write が prompt_tokens に含まれるかは未確認）", async () => {
    const h = harness([usageResponse]);
    const result = await h.model.doGenerate({
      prompt,
      providerOptions: providerOptions({ provider: "openrouter" }),
    });
    expect(result.usage.inputTokens).toEqual({
      total: 520,
      noCache: 120,
      cacheRead: 400,
      cacheWrite: 50,
    });
  });

  it("Responses（cacheWrite と cost が無い）でも欠けた値を逆算しない", async () => {
    const h = harness([
      {
        blocks: [],
        stopReason: "end_turn",
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 30,
      },
    ]);
    const result = await h.model.doGenerate({
      prompt,
      providerOptions: providerOptions({
        provider: "openai",
        apiVariant: "responses",
      }),
    });
    expect(result.usage.inputTokens).toEqual({
      total: 100,
      noCache: 70,
      cacheRead: 30,
      cacheWrite: undefined,
    });
    expect(result.providerMetadata).toEqual({
      grimodex: {
        wire: {
          inputTokens: 100,
          outputTokens: 5,
          cacheReadTokens: 30,
          cacheWriteTokens: null,
          cost: null,
          stopReason: "end_turn",
        },
      },
    });
  });

  it("台帳・audit 用の生の値（cost・stopReason を含む）を providerMetadata と audit の complete に運ぶ", async () => {
    const h = harness([usageResponse]);
    const result = await h.model.doGenerate({
      prompt,
      providerOptions: providerOptions({ provider: "openrouter" }),
    });
    expect(result.providerMetadata).toEqual({
      grimodex: {
        wire: {
          inputTokens: 520,
          outputTokens: 30,
          cacheReadTokens: 400,
          cacheWriteTokens: 50,
          cost: 0.0123,
          stopReason: "end_turn",
        },
      },
    });
    const complete = h.audit.events.find((event) => event.type === "complete");
    expect(complete?.type === "complete" && complete.completion.usage).toEqual({
      inputTokens: 520,
      outputTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      cost: 0.0123,
      stopReason: "end_turn",
    });
  });

  it.each([
    ["tool_use", "tool-calls"],
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["length", "length"],
    ["model_context_window_exceeded", "length"],
    ["refusal", "content-filter"],
    ["pause_turn", "other"],
    ["something_new", "other"],
  ])(
    "stopReason %s → finishReason %s（raw は wire の値のまま）",
    async (stopReason, unified) => {
      const h = harness([{ blocks: [], stopReason }]);
      const result = await h.model.doGenerate({
        prompt,
        providerOptions: providerOptions(),
      });
      expect(result.finishReason).toEqual({ unified, raw: stopReason });
    },
  );
});

describe("対象外の provider は明示のエラー（送信も audit もしない）", () => {
  it.each([
    "ollama",
    "openai-compatible",
    "sakana",
    "ai-novelist",
    "cli",
    null,
    "",
  ])("provider=%j", async (provider) => {
    const h = harness([endStep()]);
    const agent = makeAgent(h);
    await expect(
      agent.generate(USER, {
        ...AGENT_CALL_OPTIONS,
        providerOptions: providerOptions({ provider }),
      }),
    ).rejects.toThrow(/does not support provider/);
    expect(h.sends.length).toBe(0);
    expect(h.audit.events.length).toBe(0);
  });

  it("Mastra が足した設定・未宣言の tool・添付は黙って落とさず投げる", async () => {
    const prompt: CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    const h = harness([endStep()]);
    const options = providerOptions();
    await expect(
      h.model.doGenerate({
        prompt,
        providerOptions: options,
        temperature: 0.2,
      }),
    ).rejects.toThrow(/temperature/);
    await expect(
      h.model.doGenerate({
        prompt,
        providerOptions: options,
        toolChoice: { type: "required" },
      }),
    ).rejects.toThrow(/toolChoice:required/);
    await expect(
      h.model.doGenerate({
        prompt,
        providerOptions: options,
        tools: [
          {
            type: "function",
            name: "not_in_snapshot",
            inputSchema: { type: "object" },
          },
        ],
      }),
    ).rejects.toThrow(/not in the turn-start snapshot/);
    await expect(
      h.model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                data: { type: "data", data: "AAAA" },
              },
            ],
          },
        ],
        providerOptions: options,
      }),
    ).rejects.toThrow(/unsupported user part: file/);
    expect(h.sends.length).toBe(0);
    expect(h.audit.count("begin")).toBe(0);
  });
});

describe("audit の順序と 1 回ずつ", () => {
  it("成功：begin → dispatched → send → complete を doGenerate ごとに 1 回", async () => {
    const h = harness([toolStep("call_1"), endStep()]);
    await makeAgent(h).generate(USER, {
      ...AGENT_CALL_OPTIONS,
      providerOptions: providerOptions(),
    });
    expect(h.order).toEqual([
      "begin",
      "dispatched",
      "send",
      "complete",
      "begin",
      "dispatched",
      "send",
      "complete",
    ]);
    expect(h.audit.count("fail")).toBe(0);
  });

  it("begin が失敗したら send しない", async () => {
    const h = harness([endStep()]);
    const failing = {
      ...h.audit,
      begin: async () => {
        throw new Error("begin boom");
      },
    };
    const { model } = createAgentLanguageModel({
      originalTools: TOOLS,
      audit: failing,
      send: async () => endStep(),
    });
    await expect(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        providerOptions: providerOptions(),
      }),
    ).rejects.toMatchObject({ kind: "audit-failed" });
  });

  it("complete が失敗したら投げる（成功扱いにしない）。signal は send に届く", async () => {
    const h = harness([endStep()]);
    const failing = {
      ...h.audit,
      complete: async () => {
        throw new Error("complete boom");
      },
    };
    const signals: (AbortSignal | undefined)[] = [];
    const { model } = createAgentLanguageModel({
      originalTools: TOOLS,
      audit: failing,
      send: async (_args, context) => {
        signals.push(context.signal);
        return endStep();
      },
    });
    const controller = new AbortController();
    await expect(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        providerOptions: providerOptions(),
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "audit-failed" });
    expect(signals[0]).toBe(controller.signal);
  });

  it("応答が壊れていたら fail を 1 回書いて投げる", async () => {
    const h = harness([
      () => JSON.parse('{"blocks":"nope","stopReason":"end_turn"}'),
    ]);
    await expect(
      h.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        providerOptions: providerOptions(),
      }),
    ).rejects.toMatchObject({ kind: "invalid-response" });
    expect(h.audit.count("fail")).toBe(1);
    expect(h.audit.count("complete")).toBe(0);
    expect(() =>
      parseWireResponse({ blocks: [{ type: "x" }], stopReason: "end_turn" }),
    ).toThrow(AgentModelError);
  });
});

describe("再試行しない", () => {
  const retryable = () =>
    new APICallError({
      message: "overloaded",
      url: "https://example.invalid",
      requestBodyValues: {},
      statusCode: 529,
      isRetryable: true,
    });
  const throwers: [string, () => Error][] = [
    ["plain Error", () => new Error("boom")],
    // 既定の StreamErrorRetryProcessor は message が /econnreset|socket hang up/i に当たると isRetryable に関係なく再送する。
    ["message が ECONNRESET の Error", () => new Error("read ECONNRESET")],
    ["message が socket hang up の Error", () => new Error("socket hang up")],
    ["isRetryable:true の APICallError", retryable],
    [
      "isRetryable:true を持つ object",
      () => Object.assign(new Error("net"), { isRetryable: true }),
    ],
  ];

  describe.each(["generate", "stream"] as const)("%s", (method) => {
    it.each(throwers)(
      "send が %s を投げても、send は 1 回・audit の fail は 1 回（固定あり／なしの両方）",
      async (_label, make) => {
        for (const config of [AGENT_NO_RETRY_CONFIG, {}]) {
          const h = harness([
            () => {
              throw make();
            },
          ]);
          const agent = makeAgent(h, config);
          const options = {
            ...AGENT_CALL_OPTIONS,
            providerOptions: providerOptions(),
          };
          if (method === "generate") {
            await expect(agent.generate(USER, options)).rejects.toThrow();
          } else {
            const output = await agent.stream(USER, options);
            for await (const chunk of output.fullStream) void chunk;
          }
          expect(h.sends.length).toBe(1);
          expect(h.audit.count("fail")).toBe(1);
          expect(h.audit.count("complete")).toBe(0);
        }
      },
    );
  });

  it("adapter の error の message は kind だけの固定の文で、元の error の文は origin にだけ持つ（ECONNRESET の文が Mastra の再送の matcher に届かない）", async () => {
    const h = harness([
      () => {
        throw new Error("read ECONNRESET");
      },
    ]);
    const error = await h.model
      .doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        providerOptions: providerOptions(),
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "send-failed" });
    expect(String((error as Error).message)).not.toMatch(
      /econnreset|socket hang up/i,
    );
    expect((error as AgentModelError).origin).toMatchObject({
      message: "read ECONNRESET",
    });
    expect((error as Error).cause).toBeUndefined();
  });

  it("call 時の maxProcessorRetries は agent の値を上書きする（陰性対照）。AGENT_CALL_OPTIONS は 0 に固定するので 1 回", async () => {
    const retrying = {
      id: "always-retry",
      name: "always-retry",
      processAPIError: async () => ({ retry: true }),
    };
    const run = async (callOptions: object) => {
      const h = harness([
        () => {
          throw new Error("boom");
        },
      ]);
      const agent = makeAgent(h, {
        ...AGENT_NO_RETRY_CONFIG,
        errorProcessors: [retrying],
      });
      await agent
        .generate(USER, { ...callOptions, providerOptions: providerOptions() })
        .catch(() => undefined);
      return h.sends.length;
    };
    expect(await run({ toolCallConcurrency: 1, maxProcessorRetries: 2 })).toBe(
      3,
    );
    expect(await run(AGENT_CALL_OPTIONS)).toBe(1);
    expect(AGENT_CALL_OPTIONS.maxProcessorRetries).toBe(0);
  });

  it("adapter が投げる error は isRetryable:false で、AI SDK の APICallError として判定される", async () => {
    const h = harness([
      () => {
        throw retryable();
      },
    ]);
    const error = await h.model
      .doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        providerOptions: providerOptions(),
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentModelError);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ isRetryable: false });
  });

  it("陰性対照：adapter を通さない model が isRetryable:true の error を投げると、Mastra は設定なしで複数回呼ぶ（実測 3 回）", async () => {
    const bare = (counter: { calls: number }) => ({
      specificationVersion: "v4" as const,
      provider: AGENT_NEUTRAL_PROVIDER,
      modelId: AGENT_NEUTRAL_MODEL_ID,
      supportedUrls: {},
      doGenerate: async (): Promise<never> => {
        counter.calls += 1;
        throw retryable();
      },
      doStream: async (): Promise<never> => {
        counter.calls += 1;
        throw retryable();
      },
    });
    const run = async (method: "generate" | "stream", config: object) => {
      const counter = { calls: 0 };
      const agent = new kit.Agent({
        id: "bare",
        name: "bare",
        instructions: "S",
        model: bare(counter),
        ...config,
      });
      try {
        if (method === "generate") await agent.generate(USER);
        else {
          const output = await agent.stream(USER);
          for await (const chunk of output.fullStream) void chunk;
        }
      } catch {
        /* 失敗は想定内 */
      }
      return counter.calls;
    };
    const [
      defaultGenerate,
      defaultStream,
      maxRetriesOnlyGenerate,
      fixedGenerate,
      fixedStream,
    ] = await Promise.all([
      run("generate", {}),
      run("stream", {}),
      run("generate", { maxRetries: 0 }),
      run("generate", AGENT_NO_RETRY_CONFIG),
      run("stream", AGENT_NO_RETRY_CONFIG),
    ]);
    expect(defaultGenerate).toBe(3);
    expect(defaultStream).toBe(3);
    // `maxRetries: 0` だけでは止まらない（既定の error processors が再送する）。
    expect(maxRetriesOnlyGenerate).toBe(3);
    // 固定（errorProcessorDefaults:false ほか）で 1 回。
    expect(fixedGenerate).toBe(1);
    expect(fixedStream).toBe(1);
  }, 60_000);
});

describe("stopReason が tool_use 以外のとき tool を実行しない（現行の loop と同じ）", () => {
  const FINISH = {
    max_tokens: "length",
    refusal: "content-filter",
    end_turn: "stop",
    pause_turn: "other",
  } as const;

  describe.each(["generate", "stream"] as const)("%s", (method) => {
    it.each(Object.entries(FINISH))(
      "text ＋ tool_use block ＋ stopReason=%s：tool 実行 0・send 1 回・finishReason=%s",
      async (stopReason, unified) => {
        const h = harness([
          {
            blocks: [
              { type: "text", content: "途中まで。" },
              {
                type: "tool_use",
                id: "call_s",
                name: "search_events",
                input: { query: "a" },
              },
            ],
            stopReason,
            agentAuthorityCapabilities: {
              call_s: {
                capability: "CAP",
                executionId: "e",
                chatMessageId: "m",
                mainOwnedProvenanceId: "p",
              },
            },
          },
          endStep("2 回目（呼ばれてはならない）"),
        ]);
        let executed = 0;
        const tools = {
          search_events: kit.createTool({
            id: "search_events",
            description: "d",
            inputSchema: kit.jsonSchema<{ query: string }>({
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            }),
            execute: async () => {
              executed += 1;
              return "ok";
            },
          }),
        };
        const agent = new kit.Agent({
          id: "stop",
          name: "stop",
          instructions: "S",
          model: h.model,
          tools,
          ...AGENT_NO_RETRY_CONFIG,
        });
        const options = {
          ...AGENT_CALL_OPTIONS,
          providerOptions: providerOptions(),
        };
        let text: string;
        let finishReason: string | undefined;
        if (method === "generate") {
          const result = await agent.generate(USER, options);
          text = result.text;
          finishReason = result.finishReason;
        } else {
          const output = await agent.stream(USER, options);
          for await (const chunk of output.fullStream) void chunk;
          text = await output.text;
          finishReason = await output.finishReason;
        }
        expect(executed).toBe(0);
        expect(h.sends.length).toBe(1);
        expect(text).toBe("途中まで。");
        expect(finishReason).toBe(unified);
        // tool-call を出さない応答の capability・input は保持しない。
        expect(h.capabilities.get("call_s")).toBeUndefined();
      },
    );
  });

  it("モデル層の finishReason の raw は wire の値のまま", async () => {
    const h = harness([{ blocks: [], stopReason: "pause_turn" }]);
    const result = await h.model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      providerOptions: providerOptions(),
    });
    expect(result.finishReason).toEqual({
      unified: "other",
      raw: "pause_turn",
    });
  });
});

describe("capability を tool の execute の文脈へ届ける", () => {
  const SECRET = "CAP-SECRET-0123456789";
  const grant = {
    capability: SECRET,
    executionId: "exec-9",
    chatMessageId: "asst-1",
    mainOwnedProvenanceId: "prov-1",
  };

  it("execute は context.agent.toolCallId で turn 内の map を引ける。capability は Mastra の結果・message に残らない", async () => {
    const h = harness([
      toolStep("call_cap", { agentAuthorityCapabilities: { call_cap: grant } }),
      endStep(),
    ]);
    let seen: unknown;
    const tools = {
      search_events: kit.createTool({
        id: "search_events",
        description: "d",
        inputSchema: kit.jsonSchema<{ query: string }>({
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        }),
        execute: async (_input, context) => {
          seen = h.capabilities.get(context.agent?.toolCallId ?? "");
          return "ok";
        },
      }),
    };
    const agent = new kit.Agent({
      id: "cap",
      name: "cap",
      instructions: "S",
      model: h.model,
      tools,
      ...AGENT_NO_RETRY_CONFIG,
    });
    const result = await agent.generate(USER, {
      ...AGENT_CALL_OPTIONS,
      providerOptions: providerOptions(),
    });
    expect(seen).toEqual(grant);
    // get は one-shot：引いた grant は map から消える（clear しなくても古い値が残らない）。
    expect(h.capabilities.get("call_cap")).toBeUndefined();
    expect(h.capabilities.get("call_other")).toBeUndefined();
    // 2 回目の send（会話に戻る側）にも、audit にも、Mastra の結果にも capability は出ない。
    expect(JSON.stringify(h.sends)).not.toContain(SECRET);
    expect(JSON.stringify(h.audit.events)).not.toContain(SECRET);
    expect(
      JSON.stringify({ steps: result.steps, response: result.response }),
    ).not.toContain(SECRET);
    h.capabilities.clear();
    expect(h.capabilities.get("call_cap")).toBeUndefined();
  });

  it("理由：tool-call の providerMetadata に載せると、Mastra は step の toolCalls（message・trace の元）に残す", async () => {
    const h = harness([toolStep("call_pm"), endStep()]);
    const model = {
      ...h.model,
      doGenerate: async (options: CallOptions) => {
        const result = await h.model.doGenerate(options);
        return {
          ...result,
          content: result.content.map((part) =>
            part.type === "tool-call"
              ? {
                  ...part,
                  providerMetadata: { grimodex: { capability: SECRET } },
                }
              : part,
          ),
        };
      },
    };
    const tools = {
      search_events: kit.createTool({
        id: "search_events",
        description: "d",
        inputSchema: kit.jsonSchema<{ query: string }>({
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        }),
        execute: async () => "ok",
      }),
    };
    const agent = new kit.Agent({
      id: "pm",
      name: "pm",
      instructions: "S",
      model,
      tools,
      ...AGENT_NO_RETRY_CONFIG,
    });
    const result = await agent.generate(USER, {
      ...AGENT_CALL_OPTIONS,
      providerOptions: providerOptions(),
    });
    expect(JSON.stringify(result.steps)).toContain(SECRET);
  });
});

describe("中立の名前（陰性対照）：効くものを「中立の名前」と「既定の processors の無効化」に分けて確かめる", () => {
  /** Mastra が model に渡す prompt と tools を記録する、adapter を通さない model。 */
  function spyModel(
    provider: string,
    modelId: string,
    seen: { prompt: unknown; tools: unknown }[],
  ) {
    let call = 0;
    return {
      specificationVersion: "v4" as const,
      provider,
      modelId,
      supportedUrls: {},
      async doGenerate(options: CallOptions) {
        seen.push(
          JSON.parse(
            JSON.stringify({ prompt: options.prompt, tools: options.tools }),
          ),
        );
        const tool = call++ === 0;
        return {
          content: tool
            ? [
                {
                  type: "reasoning" as const,
                  text: "",
                  providerMetadata: { grimodex: { signature: "SIG-1" } },
                },
                {
                  type: "tool-call" as const,
                  toolCallId: "call.weird:1",
                  toolName: "search_events",
                  input: '{"query":"a"}',
                },
              ]
            : [{ type: "text" as const, text: "done" }],
          finishReason: {
            unified: tool ? ("tool-calls" as const) : ("stop" as const),
            raw: undefined,
          },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
          warnings: [],
        };
      },
      async doStream(): Promise<never> {
        throw new Error("unused");
      },
    };
  }

  interface Observed {
    /** Mastra が model に渡した tool の schema（optional の limit の扱い）。 */
    limit: { type?: unknown; anyOf?: unknown };
    required: string[];
    additionalProperties: unknown;
    /** 2 回目の prompt の assistant の part の並びと tool id。 */
    parts: string[];
    toolId: string | undefined;
    signature: unknown;
  }

  async function observe(
    provider: string,
    modelId: string,
    config: object,
  ): Promise<Observed> {
    const seen: { prompt: unknown; tools: unknown }[] = [];
    const tools = {
      search_events: kit.createTool({
        id: "search_events",
        description: "d",
        inputSchema: kit.jsonSchema<{ query: string; limit?: number }>({
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } },
          required: ["query"],
        }),
        execute: async () => "ok",
      }),
    };
    const agent = new kit.Agent({
      id: `neutral-${provider}-${modelId}`,
      name: "n",
      instructions: "S",
      model: spyModel(provider, modelId, seen),
      tools,
      ...config,
    });
    await agent.generate(USER, AGENT_CALL_OPTIONS);
    const [first, second] = JSON.parse(JSON.stringify(seen)) as {
      prompt: {
        role: string;
        content: {
          type: string;
          toolCallId?: string;
          providerOptions?: { grimodex?: unknown };
        }[];
      }[];
      tools: {
        inputSchema: {
          properties: { limit: { type?: unknown; anyOf?: unknown } };
          required: string[];
          additionalProperties?: unknown;
        };
      }[];
    }[];
    const schema = first!.tools[0]!.inputSchema;
    const assistant = second!.prompt.find(
      (message) => message.role === "assistant",
    )!;
    return {
      limit: schema.properties.limit,
      required: schema.required,
      additionalProperties: schema.additionalProperties,
      parts: assistant.content.map((part) => part.type),
      toolId: assistant.content.find((part) => part.type === "tool-call")
        ?.toolCallId,
      signature: assistant.content.find((part) => part.type === "reasoning")
        ?.providerOptions?.grimodex,
    };
  }

  const UNCHANGED = {
    limit: { type: "number" },
    required: ["query"],
    additionalProperties: undefined,
    parts: ["reasoning", "tool-call"], // reasoning → tool-call の順
    toolId: "call.weird:1",
    signature: { signature: "SIG-1" },
  };

  it("中立の名前：固定あり・なしのどちらでも、schema・reasoning・tool id は書き換わらない", async () => {
    for (const config of [AGENT_NO_RETRY_CONFIG, {}]) {
      expect(
        await observe(AGENT_NEUTRAL_PROVIDER, AGENT_NEUTRAL_MODEL_ID, config),
      ).toEqual(UNCHANGED);
    }
  });

  it("陰性対照（tool の schema）：model id と provider 名で変わる。固定の有無には依らない（中立の名前だけが防ぐ）", async () => {
    for (const config of [AGENT_NO_RETRY_CONFIG, {}]) {
      // anthropic 系の model id：additionalProperties:false が足される。
      expect(
        await observe(
          AGENT_NEUTRAL_PROVIDER,
          "anthropic/claude-sonnet-4-6",
          config,
        ),
      ).toMatchObject({ additionalProperties: false, required: ["query"] });
      // openai 系：optional が nullable 化され required に入る（S5）。provider 名でも model id でも起こる。
      for (const [provider, modelId] of [
        ["openai.chat", AGENT_NEUTRAL_MODEL_ID],
        [AGENT_NEUTRAL_PROVIDER, "openai/gpt-5"],
      ] as const) {
        expect(await observe(provider, modelId, config)).toMatchObject({
          limit: { anyOf: [{ type: "number" }, { type: "null" }] },
          required: ["query", "limit"],
          additionalProperties: false,
        });
      }
    }
  });

  it("陰性対照（prompt の書換え）：anthropic を名乗ると、既定の processors があるときだけ署名つき reasoning が落ち tool id が書き換わる。固定（errorProcessorDefaults:false）で止まる", async () => {
    const anthropicNamed = [
      ["anthropic.messages", AGENT_NEUTRAL_MODEL_ID],
      [AGENT_NEUTRAL_PROVIDER, "anthropic/claude-sonnet-4-6"],
      ["openrouter", "anthropic/claude-sonnet-4.6"],
    ] as const;
    for (const [provider, modelId] of anthropicNamed) {
      const withDefaults = await observe(provider, modelId, {});
      expect(withDefaults.parts, `${provider}/${modelId}`).toEqual([
        "tool-call",
      ]);
      expect(withDefaults.toolId).toBe("call_weird_1");
      const fixed = await observe(provider, modelId, AGENT_NO_RETRY_CONFIG);
      expect(fixed.parts, `${provider}/${modelId}`).toEqual([
        "reasoning",
        "tool-call",
      ]);
      expect(fixed.toolId).toBe("call.weird:1");
    }
  });
});

describe("Responses の reasoning（summary が空で署名だけ）", () => {
  const SIGNATURE = JSON.stringify({ id: "rs_1", ec: "ENC" });
  const script = (): AgentWireResponse[] => [
    {
      blocks: [
        { type: "thinking", content: "", signature: SIGNATURE },
        {
          type: "tool_use",
          id: "call_r1",
          name: "search_events",
          input: { query: "a" },
        },
      ],
      stopReason: "tool_use",
    },
    endStep(),
  ];

  it.each(["generate", "stream"] as const)(
    "%s：Mastra は空の reasoning を落とさず、reasoning → tool_use の順で次の prompt に戻し、wire に署名が届く",
    async (method) => {
      const h = harness(script());
      const prompts: CallOptions["prompt"][] = [];
      const model = {
        ...h.model,
        doGenerate: async (options: CallOptions) => {
          prompts.push(structuredClone(options.prompt));
          return h.model.doGenerate(options);
        },
        doStream: async (options: CallOptions) => {
          prompts.push(structuredClone(options.prompt));
          return h.model.doStream(options);
        },
      };
      const tools = {
        search_events: kit.createTool({
          id: "search_events",
          description: "d",
          inputSchema: kit.jsonSchema<{ query: string }>({
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          }),
          execute: async () => "ok",
        }),
      };
      const agent = new kit.Agent({
        id: "resp",
        name: "r",
        instructions: "S",
        model,
        tools,
        ...AGENT_NO_RETRY_CONFIG,
      });
      const options = {
        ...AGENT_CALL_OPTIONS,
        providerOptions: providerOptions({
          provider: "openai",
          apiVariant: "responses",
        }),
      };
      if (method === "generate") await agent.generate(USER, options);
      else {
        const output = await agent.stream(USER, options);
        for await (const chunk of output.fullStream) void chunk;
      }
      expect(prompts.length).toBe(2);
      const assistant = prompts[1]!.find(
        (message) => message.role === "assistant",
      );
      expect(
        assistant?.role === "assistant" &&
          assistant.content.map((part) => part.type),
      ).toEqual(["reasoning", "tool-call"]);
      const second = h.sends[1]!.messages.find(
        (message) => message.role === "assistant",
      );
      expect(second).toMatchObject({
        role: "assistant",
        thinkingBlocks: [{ thinking: "", signature: SIGNATURE }],
        toolUses: [{ id: "call_r1" }],
      });
    },
  );
});

describe("citations と未宣言の tool", () => {
  it("citations は source part として運ぶ（text に紐づけない）。Mastra の結果の sources に載る", async () => {
    const h = harness([
      {
        blocks: [{ type: "text", content: "本文" }],
        stopReason: "end_turn",
        citations: [
          {
            url: "https://example.invalid/a",
            title: "A",
            citedText: "引用",
            snippet: "抜粋",
          },
        ],
      },
    ]);
    const result = await makeAgent(h).generate(USER, {
      ...AGENT_CALL_OPTIONS,
      providerOptions: providerOptions(),
    });
    expect(
      result.sources.map((source) => [
        source.payload.url,
        source.payload.title,
      ]),
    ).toEqual([["https://example.invalid/a", "A"]]);
    expect(
      h.audit.events.find((event) => event.type === "complete"),
    ).toMatchObject({
      completion: { response: { citations: [{ citedText: "引用" }] } },
    });
  });

  it("モデルが宣言していない tool を返したとき：Mastra は tool を実行せず、エラーの tool_result を次の send に載せる", async () => {
    const h = harness([
      {
        blocks: [
          { type: "tool_use", id: "call_x", name: "not_declared", input: {} },
        ],
        stopReason: "tool_use",
      },
      endStep(),
    ]);
    await makeAgent(h).generate(USER, {
      ...AGENT_CALL_OPTIONS,
      providerOptions: providerOptions(),
    });
    expect(h.sends.length).toBe(2);
    const result = h.sends[1]!.messages.find(
      (message) => message.role === "tool_result",
    );
    expect(result).toMatchObject({ toolUseId: "call_x", isError: true });
    expect(result?.role === "tool_result" && result.content).toMatch(
      /^Error: /,
    );
  });
});

describe("再現性（tool_use の input の key 順）", () => {
  it("Rust が返した key 順で次の step に戻す。Mastra が内容を変えたときは変えた後を送る", async () => {
    const h = harness([toolStep("call_k"), endStep()]);
    await makeAgent(h).generate(USER, {
      ...AGENT_CALL_OPTIONS,
      providerOptions: providerOptions(),
    });
    const assistant = h.sends[1]!.messages.find(
      (message) => message.role === "assistant",
    );
    expect(
      JSON.stringify(
        assistant?.role === "assistant" && assistant.toolUses?.[0]?.input,
      ),
    ).toBe('{"query":"a","limit":1}');
  });
});
