/**
 * 汎用 **ライブ LLM ハーネス**（OpenRouter / native tool calling）。
 *
 * Grimodex の AI ツール系フロー（`runAgentLoop` を使う agent / context creator /
 * リサーチサブエージェント等、および将来のツール）を **実モデル** に対して
 * デバッグ・E2E 検証するための再利用部品をまとめたもの。`*.live.test.ts` から
 * import して使う（実トークン課金あり・既定 SKIP gate と併用する）。
 *
 * 提供する積み木:
 *   - {@link liveApiKey} / {@link liveModel}     — キー・モデル解決（env）
 *   - wire 変換 ({@link toOpenAITools} 等)        — Grimodex agent 型 ⇄ OpenAI 形式
 *   - {@link createOpenRouterSendToLLM}           — 実 LLM を叩く sendToLLM
 *   - {@link createTracingExecutor}               — 任意の executor をラップして全
 *                                                   tool_call を記録（デバッグの肝）
 *   - {@link createMockReadOnlyExecutor}          — DB 無しで動く read-only 作品世界
 *   - {@link createResearchInterceptor}           — run_research サブエージェント再現
 *   - {@link runLiveAgent}                        — 上記を束ねた高水準ランナー
 *
 * 注意: {@link runLiveAgent} は内部で `runAgentLoop` を呼ぶため、`../contextBuilder`
 * の `ensureTokenizer`/`countTokens` が必要。vitest からは contextBuilder を mock
 * して使うのが既定（下位の sendToLLM / 変換 / mock world 単体は tokenizer 不要）。
 */
import { runAgentLoop, type AgentLoopOptions } from "./agentLoop";
import type {
  AgentLLMResponse,
  AgentMessagePayload,
  AgentToolDefinition,
  ResponseBlock,
  ToolResult,
} from "./agentTypes";
import {
  getResearchSubagentTools,
  RESEARCH_SUBAGENT_TOOL,
} from "./toolDefinitions";

// ── キー / モデル ────────────────────────────────────────────────────────────

/** OpenRouter キーを env から解決（`OPENROUTER_API_KEY` / `OPEN_ROUTER_API_KEY`）。 */
export function liveApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY ?? process.env.OPEN_ROUTER_API_KEY;
}

/** 既定モデル（安価で tool calling 対応）。`OPENROUTER_MODEL` で上書き可。 */
export const DEFAULT_LIVE_MODEL = "openai/gpt-4o-mini";

/**
 * 既定の出力トークン上限。推論モデル(gpt-5 / o-series 等)は hidden reasoning も
 * この上限に課金されるため、小さすぎると reasoning だけで使い切って `content` が
 * 空(finish_reason:length)になる。旧既定 1024 では gpt-5 が空応答に退化し、
 * 下流の parseCards が "アイデア N" プレースホルダで埋めて偽の計測値を出していた。
 * reasoning + 回答に十分な余裕を持たせる(本番 Rust の OpenRouter reasoning 予算と整合)。
 */
export const DEFAULT_LIVE_MAX_TOKENS = 8192;

/** 使用モデルを解決（env `OPENROUTER_MODEL` 優先）。 */
export function liveModel(): string {
  return process.env.OPENROUTER_MODEL ?? DEFAULT_LIVE_MODEL;
}

export const OPENROUTER_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";

// ── wire 変換（Grimodex agent 型 ⇄ OpenAI/OpenRouter）────────────────────────

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/** AgentToolDefinition[] → OpenAI function tools。 */
export function toOpenAITools(tools: AgentToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** AgentMessagePayload[] → OpenAI messages（assistant.tool_calls / role:tool 対応）。 */
export function toOpenAIMessages(msgs: AgentMessagePayload[]) {
  return msgs.map((m) => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "system") return { role: "system", content: m.content };
    if (m.role === "tool_result") {
      return { role: "tool", tool_call_id: m.toolUseId, content: m.content };
    }
    // assistant: tool_calls があれば content は null に倒す（OpenAI 制約）。
    const out: Record<string, unknown> = {
      role: "assistant",
      content: m.content || null,
    };
    if (m.toolUses?.length) {
      out.tool_calls = m.toolUses.map((tu) => ({
        id: tu.id,
        type: "function",
        function: { name: tu.name, arguments: JSON.stringify(tu.input) },
      }));
    }
    return out;
  });
}

interface OpenRouterChoiceMessage {
  content?: string | null;
  tool_calls?: {
    id: string;
    function: { name: string; arguments: string };
  }[];
}
export interface OpenRouterResponse {
  choices?: { message?: OpenRouterChoiceMessage; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** OpenRouter レスポンス → AgentLLMResponse（blocks / stopReason / usage）。 */
export function fromOpenAIResponse(data: OpenRouterResponse): AgentLLMResponse {
  const choice = data.choices?.[0];
  const msg = choice?.message ?? {};
  const blocks: ResponseBlock[] = [];
  if (msg.content) blocks.push({ type: "text", content: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  const stopReason: AgentLLMResponse["stopReason"] = msg.tool_calls?.length
    ? "tool_use"
    : choice?.finish_reason === "length"
      ? "max_tokens"
      : "end_turn";
  return {
    blocks,
    stopReason,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

// ── 実 LLM を叩く sendToLLM ──────────────────────────────────────────────────

export interface OpenRouterSendOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  endpoint?: string;
  /** 最初の呼び出しだけ tool_choice を上書き（強制委譲・上限経路の決定的再現用）。 */
  firstToolChoice?: ToolChoice;
  /** 2 回目以降の tool_choice（既定 "auto"）。 */
  restToolChoice?: ToolChoice;
  /** 1 往復ごとに呼ばれる観測フック（リクエスト/レスポンスのダンプ等）。 */
  onExchange?: (info: {
    call: number;
    messages: AgentMessagePayload[];
    tools: AgentToolDefinition[];
    response: AgentLLMResponse;
  }) => void;
}

/**
 * `runAgentLoop` の `sendToLLM` に渡せる、OpenRouter を直接叩く実装を作る。
 * 返り値のクロージャは独自の呼び出しカウンタを持つ（親と子で別インスタンスを
 * 作れば独立してカウントされる）。
 */
export function createOpenRouterSendToLLM(
  opts: OpenRouterSendOptions = {},
): AgentLoopOptions["sendToLLM"] {
  const key = opts.apiKey ?? liveApiKey();
  const model = opts.model ?? liveModel();
  const endpoint = opts.endpoint ?? OPENROUTER_ENDPOINT;
  let call = 0;
  return async (msgs, tools) => {
    call++;
    const toolChoice: ToolChoice =
      call === 1
        ? (opts.firstToolChoice ?? "auto")
        : (opts.restToolChoice ?? "auto");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/kazormia296/Grimodex",
        "X-Title": "Grimodex AI live harness",
      },
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(msgs),
        ...(tools.length > 0
          ? { tools: toOpenAITools(tools), tool_choice: toolChoice }
          : {}),
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? DEFAULT_LIVE_MAX_TOKENS,
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as OpenRouterResponse;
    const parsed = fromOpenAIResponse(data);
    opts.onExchange?.({ call, messages: msgs, tools, response: parsed });
    return parsed;
  };
}

// ── tool_call トレース ───────────────────────────────────────────────────────

/** 1 回の tool 実行イベント（親=depth 0、サブエージェント=depth 1…）。 */
export interface ToolCallEvent {
  depth: number;
  name: string;
  params: Record<string, unknown>;
  resultSummary: string;
  error?: string;
}

/**
 * 任意の executor をラップし、全 tool_call を `sink` に記録する。どの AI ツール
 * フローでも「モデルが何のツールをどんな引数で呼んだか」を後から確認できる。
 */
export function createTracingExecutor(
  inner: AgentLoopOptions["executeTool"],
  sink: ToolCallEvent[],
  depth = 0,
): AgentLoopOptions["executeTool"] {
  return async (name, toolCallId, params) => {
    const result = await inner(name, toolCallId, params);
    sink.push({
      depth,
      name,
      params,
      resultSummary: result.summary,
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  };
}

// ── read-only な mock 作品世界（実 DB の代わり）──────────────────────────────

export interface MockEntry {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  summary: string;
  body: string;
  tags: string[];
}
export interface MockScene {
  id: string;
  title: string;
  text: string;
}
export interface MockForeshadow {
  id: string;
  title: string;
  intent: string;
  notes: string;
  loadBearing: "critical" | "supporting" | "optional";
  payoffConfirmed: boolean;
  abandoned: boolean;
}
export interface MockPlotThread {
  id: string;
  name: string;
  description?: string;
  scenes: Array<{ sceneId: string; phaseType: string }>;
}
export interface MockWorld {
  entries: MockEntry[];
  scenes: MockScene[];
  foreshadows: MockForeshadow[];
  /** Phase 3c: plot threads（省略時は空＝list は 0 件）。 */
  threads?: MockPlotThread[];
}

/** 既定の小さな作品世界。カスタムしたい場合は {@link createMockReadOnlyExecutor} に渡す。 */
export const DEFAULT_MOCK_WORLD: MockWorld = {
  entries: [
    {
      id: "char-akane",
      name: "朱音",
      type: "character",
      aliases: ["アカネ"],
      summary: "主人公。16歳の高校生で、古書店でアルバイトをしている。",
      body: "朱音は好奇心が強く、古い本や言い伝えに惹かれる。蓮とは幼馴染。",
      tags: ["主人公", "高校生"],
    },
    {
      id: "char-ren",
      name: "蓮",
      type: "character",
      aliases: [],
      summary: "朱音の幼馴染。剣道部の主将で、面倒見がよい。",
      body: "蓮は寡黙だが芯が強い。朱音をいつも気にかけている。",
      tags: ["幼馴染", "剣道部"],
    },
    {
      id: "char-mei",
      name: "芽衣",
      type: "character",
      aliases: ["メイ"],
      summary: "転校生。朱音のクラスメイトで、古峯神社に強い興味を持つ。",
      body: "芽衣は物静かで、神社や巫女の話になると饒舌になる。",
      tags: ["転校生"],
    },
    {
      id: "loc-shrine",
      name: "古峯神社",
      type: "location",
      aliases: ["神社"],
      summary: "町外れの古い神社。巫女の家系にまつわる言い伝えがある。",
      body: "古峯神社は山裾にあり、地元では神聖な場所とされている。",
      tags: ["神社"],
    },
  ],
  scenes: [
    {
      id: "scene-1",
      title: "出会い",
      text: "朱音は古書店で蓮と再会した。蓮は今度の剣道の大会の話をした。",
    },
    {
      id: "scene-2",
      title: "転校生",
      text: "芽衣が朱音のクラスに転校してきた。芽衣は古峯神社に興味を持っていた。",
    },
    {
      id: "scene-3",
      title: "神社",
      text: "朱音と芽衣は古峯神社を訪れ、巫女の言い伝えについて話した。",
    },
  ],
  foreshadows: [
    {
      id: "fs-mei",
      title: "芽衣の正体",
      intent: "芽衣は実は古峯神社の巫女の家系である、という伏線。",
      notes: "終盤で明かす。",
      loadBearing: "critical",
      payoffConfirmed: false,
      abandoned: false,
    },
  ],
  threads: [
    {
      id: "thread-shrine",
      name: "古峯神社の謎",
      description: "芽衣と古峯神社にまつわる縦糸。",
      scenes: [
        { sceneId: "scene-2", phaseType: "introduce" },
        { sceneId: "scene-3", phaseType: "develop" },
      ],
    },
  ],
};

function okResult(name: string, content: unknown, summary: string): ToolResult {
  const json = JSON.stringify(content);
  return { toolCallId: "", name, content, summary, tokensUsed: json.length };
}
function notFound(name: string): ToolResult {
  return {
    toolCallId: "",
    name,
    content: null,
    summary: "not found",
    tokensUsed: 0,
  };
}

/**
 * READ_ONLY_TOOL_NAMES（14 種）を mock 作品世界で dispatch する executor を作る。
 * 実 DB / Tauri 無しで agent ツールフローを実モデルに対して回せる。
 */
export function createMockReadOnlyExecutor(
  world: MockWorld = DEFAULT_MOCK_WORLD,
): AgentLoopOptions["executeTool"] {
  const { entries, scenes, foreshadows, threads = [] } = world;
  return async (name, toolCallId, params) => {
    const q = String(params["query"] ?? "").toLowerCase();
    const id = String(params["id"] ?? "");
    let r: ToolResult;
    switch (name) {
      case "search_codex": {
        const hits = entries
          .filter((e) =>
            [e.name, e.summary, ...e.aliases].some((s) =>
              s.toLowerCase().includes(q),
            ),
          )
          .map((e) => ({
            id: e.id,
            name: e.name,
            type: e.type,
            summary: e.summary,
          }));
        r = okResult(name, hits, `${hits.length} entries`);
        break;
      }
      case "list_codex_by_type": {
        const type = String(params["type"] ?? "");
        const hits = entries
          .filter((e) => e.type === type)
          .map((e) => ({
            id: e.id,
            name: e.name,
            summary: e.summary,
            tags: e.tags,
          }));
        r = okResult(name, hits, `${hits.length} ${type}`);
        break;
      }
      case "get_codex_entry": {
        const e = entries.find((x) => x.id === id);
        r = e ? okResult(name, e, `entry ${e.name}`) : notFound(name);
        break;
      }
      case "list_codex_tags":
        r = okResult(name, [{ tag: "神社", count: 2 }], "tags");
        break;
      case "search_codex_by_tags": {
        const tags = (params["tags"] as string[]) ?? [];
        const hits = entries
          .filter((e) => e.tags.some((t) => tags.includes(t)))
          .map((e) => ({ id: e.id, name: e.name, summary: e.summary }));
        r = okResult(name, hits, `${hits.length} entries`);
        break;
      }
      case "find_related_entries": {
        const src = entries.find((x) => x.id === id);
        const hits = src
          ? entries
              .filter(
                (e) =>
                  e.id !== src.id &&
                  [e.summary, e.body].some((s) => s.includes(src.name)),
              )
              .map((e) => ({
                id: e.id,
                name: e.name,
                type: e.type,
                summary: e.summary,
              }))
          : [];
        r = okResult(name, hits, `${hits.length} related`);
        break;
      }
      case "list_chapters":
        r = okResult(
          name,
          {
            chapters: [
              {
                title: "第1章",
                scenes: scenes.map((s) => ({ id: s.id, title: s.title })),
              },
            ],
          },
          "1 chapter",
        );
        break;
      case "get_scene": {
        const s = scenes.find((x) => x.id === id);
        r = s
          ? okResult(
              name,
              { id: s.id, title: s.title, text: s.text },
              `scene ${s.title}`,
            )
          : notFound(name);
        break;
      }
      case "search_scenes": {
        const hits = scenes
          .filter((s) => s.text.toLowerCase().includes(q))
          .map((s) => ({ id: s.id, title: s.title, snippet: s.text }));
        r = okResult(name, hits, `${hits.length} scenes`);
        break;
      }
      case "search_snippets":
        r = okResult(name, [], "0 snippets");
        break;
      case "get_chapter_summaries":
        r = okResult(
          name,
          [
            {
              chapter: "第1章",
              summary: "朱音が蓮・芽衣と関わり、神社の謎に近づく。",
            },
          ],
          "summaries",
        );
        break;
      case "list_open_foreshadows":
        r = okResult(
          name,
          foreshadows.map((f) => ({
            id: f.id,
            title: f.title,
            intent: f.intent,
            loadBearing: f.loadBearing,
          })),
          `${foreshadows.length} open`,
        );
        break;
      case "get_foreshadow_detail": {
        const f = foreshadows.find((x) => x.id === id);
        r = f ? okResult(name, f, `foreshadow ${f.title}`) : notFound(name);
        break;
      }
      case "get_scene_timeline_neighbors":
        r = okResult(name, { before: [], after: [] }, "no neighbors");
        break;
      case "list_plot_threads": {
        const list = threads.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description ?? "",
          sceneCount: new Set(t.scenes.map((s) => s.sceneId)).size,
          phases: [...new Set(t.scenes.map((s) => s.phaseType))],
        }));
        r = okResult(name, list, `${list.length} plot thread(s)`);
        break;
      }
      case "get_thread_scenes": {
        const threadId = String(params["threadId"] ?? "");
        const t = threads.find((x) => x.id === threadId);
        if (!t) {
          r = notFound(name);
          break;
        }
        const sceneList = t.scenes.slice(0, 8).map((ts) => {
          const sc = scenes.find((s) => s.id === ts.sceneId);
          return {
            id: ts.sceneId,
            title: sc?.title ?? "",
            phaseType: ts.phaseType,
            excerpt: (sc?.text ?? "").slice(0, 800),
          };
        });
        r = okResult(
          name,
          { id: t.id, name: t.name, scenes: sceneList, branches: [] },
          `Thread '${t.name}': ${sceneList.length} scene(s)`,
        );
        break;
      }
      default:
        r = {
          toolCallId: "",
          name,
          content: null,
          summary: `mock: unsupported read tool ${name}`,
          tokensUsed: 0,
          error: `unsupported ${name}`,
        };
    }
    return { ...r, toolCallId };
  };
}

/** runAgentLoop の限界メッセージ既定（言語非依存の汎用文言）。 */
export const DEFAULT_LIMIT_MESSAGES = {
  callLimitMessage:
    "ツール呼び出し上限に達しました。現在の情報で回答してください。",
  tokenBudgetMessage:
    "トークン予算に達しました。現在の情報で回答してください。",
  userQuestionLimitMessage:
    "質問回数の上限に達しました。現在の情報で進めてください。",
  researchLimitMessage: "調査の予算上限に達しました。要約してください。",
};

// ── run_research サブエージェント再現（chatStore と同じ要領）─────────────────

export interface ResearchInterceptorOptions {
  /** run_research 以外を処理する基底 executor（通常は mock read-only）。 */
  baseExecutor: AgentLoopOptions["executeTool"];
  /** 子ループ用の sendToLLM（親とは別インスタンスを渡すこと）。 */
  childSendToLLM: AgentLoopOptions["sendToLLM"];
  /** 子の tool_call を記録する sink（depth 1 で push）。 */
  sink?: ToolCallEvent[];
  researchSystemPrompt?: string;
  childMaxToolCalls?: number;
  childTokenBudget?: number;
  /** run_research 1 回ごとに子の結果を観測するフック。 */
  onChildResult?: (info: {
    task: string;
    finalText: string;
    toolCallNames: string[];
  }) => void;
}

const DEFAULT_RESEARCH_SYSTEM =
  "あなたはリサーチ専門サブエージェントです。与えられた調査タスクだけに集中し、読み取り専用ツールで必要な情報を集め、最後に簡潔な要約を返してください。";

/**
 * `run_research` を intercept し、読み取り専用の子 `runAgentLoop` を起動する
 * executor を作る（chatStore の guardedExecuteTool と同型）。子は
 * getResearchSubagentTools() しか宣言されないため再帰せず depth=1 に固定される。
 */
export function createResearchInterceptor(
  opts: ResearchInterceptorOptions,
): AgentLoopOptions["executeTool"] {
  const childExecutor = opts.sink
    ? createTracingExecutor(opts.baseExecutor, opts.sink, 1)
    : opts.baseExecutor;
  return async (name, toolCallId, params) => {
    if (name !== RESEARCH_SUBAGENT_TOOL) {
      return opts.baseExecutor(name, toolCallId, params);
    }
    const task = String(params["task"] ?? "").trim();
    if (!task) {
      return {
        toolCallId,
        name,
        content: null,
        summary: "run_research requires a non-empty 'task'.",
        tokensUsed: 0,
        error: "empty task",
      };
    }
    const child = await runAgentLoop({
      messages: [
        {
          role: "system",
          content: opts.researchSystemPrompt ?? DEFAULT_RESEARCH_SYSTEM,
        },
        { role: "user", content: task },
      ],
      tools: getResearchSubagentTools(),
      tokenBudget: opts.childTokenBudget ?? 50_000,
      maxToolCalls: opts.childMaxToolCalls ?? 4,
      sendToLLM: opts.childSendToLLM,
      executeTool: childExecutor,
      onProgress: () => {},
      onTextChunk: () => {},
      ...DEFAULT_LIMIT_MESSAGES,
    });
    opts.onChildResult?.({
      task,
      finalText: child.finalText,
      toolCallNames: child.toolCallRecords.map((r) => r.name),
    });
    const content = {
      findings: child.finalText.trim() || "(no findings)",
      toolCalls: child.toolCallRecords.length,
    };
    const json = JSON.stringify(content);
    return {
      toolCallId,
      name,
      content,
      summary: `Research sub-agent done (${child.toolCallRecords.length} read calls)`,
      tokensUsed: json.length,
    };
  };
}

// ── 高水準ランナー ──────────────────────────────────────────────────────────

export interface LiveRunOptions {
  system?: string;
  user: string;
  tools: AgentToolDefinition[];
  executeTool: AgentLoopOptions["executeTool"];
  maxToolCalls?: number;
  maxUserQuestions?: number;
  tokenBudget?: number;
  /** sendToLLM のオプション（model/temperature/tool_choice/onExchange 等）。 */
  send?: OpenRouterSendOptions;
  /** 既存の trace sink を共有したい場合に渡す（サブエージェント込みで集約）。 */
  sink?: ToolCallEvent[];
}

export interface LiveRunResult {
  finalText: string;
  /** 親(depth0)＋サブエージェント(depth1)を含む全 tool_call の記録。 */
  toolCalls: ToolCallEvent[];
  stoppedReason: Awaited<ReturnType<typeof runAgentLoop>>["stoppedReason"];
  tokensIn: number | null;
  tokensOut: number | null;
}

/**
 * 実 LLM に対して 1 本の agent ツールフローを走らせ、tool_call トレース付きで
 * 結果を返す高水準ランナー。任意の AI ツールのデバッグに使える最短経路。
 *
 * 例（基本ループ）:
 *   const { toolCalls, finalText } = await runLiveAgent({
 *     user: "蓮はどんな人物？",
 *     tools: getResearchSubagentTools(),
 *     executeTool: createMockReadOnlyExecutor(),
 *   });
 */
export async function runLiveAgent(
  opts: LiveRunOptions,
): Promise<LiveRunResult> {
  const sink = opts.sink ?? [];
  const sendToLLM = createOpenRouterSendToLLM(opts.send);
  const tracing = createTracingExecutor(opts.executeTool, sink, 0);
  const messages: AgentMessagePayload[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.user });

  const res = await runAgentLoop({
    messages,
    tools: opts.tools,
    tokenBudget: opts.tokenBudget ?? 100_000,
    ...(opts.maxToolCalls !== undefined
      ? { maxToolCalls: opts.maxToolCalls }
      : {}),
    ...(opts.maxUserQuestions !== undefined
      ? { maxUserQuestions: opts.maxUserQuestions }
      : {}),
    sendToLLM,
    executeTool: tracing,
    onProgress: () => {},
    onTextChunk: () => {},
    ...DEFAULT_LIMIT_MESSAGES,
  });

  return {
    finalText: res.finalText,
    toolCalls: sink,
    stoppedReason: res.stoppedReason,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
  };
}

// ── 単発（tool 無し）ランナー ────────────────────────────────────────────────

export interface LiveSingleShotResult {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  stopReason: AgentLLMResponse["stopReason"];
}

/**
 * tool を一切宣言せず、実 LLM に 1 往復だけ投げる単発ランナー。
 * `runAgentLoop` を経由しない高水準ヘルパで、synopsis / セッションタイトル /
 * 要約 / 伏線監査などの「単発 `send_chat_message` サーフェス」を、**本番のプロンプト
 * ビルダー**（getPromptCatalog 等）と組み合わせて実モデルで検証するための最短経路。
 * 本番経路は Tauri → Rust だが、ここでは挙動（プロンプト×モデル応答）を検証する
 * 目的で OpenRouter を直接叩く（トランスポートは {@link createOpenRouterSendToLLM} と
 * 同じく fetch 直叩き）。
 *
 * 例:
 *   const { text } = await runLiveSingleShot(
 *     getPromptCatalog("ja").chatApi.buildSynopsisFromContentPrompt(title, body),
 *   );
 */
export async function runLiveSingleShot(
  user: string,
  opts: { system?: string; send?: OpenRouterSendOptions } = {},
): Promise<LiveSingleShotResult> {
  const sendToLLM = createOpenRouterSendToLLM(opts.send);
  const messages: AgentMessagePayload[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: user });
  const res = await sendToLLM(messages, []);
  const text = res.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");
  // 空応答を黙って "" で返すと、下流(parseCards 等)が偽の結果を作ってしまう
  // (VS 検証が lexOff=lexOn=0.400/tie に退化した実例)。ライブ検証では明示的に
  // 失敗させる。推論モデルが max_tokens を使い切った場合はヒントを添える。
  if (!text.trim()) {
    const hint =
      res.stopReason === "max_tokens"
        ? " — likely a reasoning model exhausting max_tokens on hidden reasoning; raise send.maxTokens"
        : "";
    throw new Error(`runLiveSingleShot: model returned empty text${hint}.`);
  }
  return {
    text,
    tokensIn: res.inputTokens ?? null,
    tokensOut: res.outputTokens ?? null,
    stopReason: res.stopReason,
  };
}
