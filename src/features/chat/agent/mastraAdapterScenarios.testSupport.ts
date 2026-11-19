/**
 * Mastra 移行 MP-2：現行の agent loop と Mastra＋adapter の特性試験で共有する入力。
 * 試験（`mastraAdapterCharacterization.test.ts`）からだけ参照する。
 *
 * 場面は spike S6 の A〜F に、Responses の「署名だけの reasoning」（G）を足したもの。route は 6 つ
 * （anthropic、openai-chat、openai-responses、openrouter-chat の claude 系と非 claude、openrouter-responses）。
 * Rust の応答（台本）は route ごとの実際の形（署名の有無、tool id の形、usage の会計、cost）で書く。
 */
import type {
  AgentWireResponse,
  AgentWireToolDefinition,
} from "../../../../electron/main/mastra/agentWire";
import type {
  AgentMessagePayload,
  AgentToolDefinition,
  WebSearchConfig,
} from "./agentTypes";
import type { ThinkingParams } from "./modelLimits";
import { stripToolProtocol } from "../toolProtocol";

// ---- 入力（現行の contextBuilder／chatTurnStoreActions の写し） -----------------

export const CACHE_SEGMENTS = [
  "# L1 作品の方針\nあなたは小説執筆の共同作業者。日本語で答える。",
  "# L2 世界観\n王国ヴェルディアは三つの都市で成る。",
  "# L3 現在の場面\n第3章：王の死の翌朝。",
  "# L4 Codex（安定部）\n- 王：アルド（故人）",
];
export const VOLATILE_TAIL = "# L5 直近の要約\n前回は王の死因を検討した。";
export const SYSTEM_PROMPT = [...CACHE_SEGMENTS, VOLATILE_TAIL].join("\n");

export type RawHistory = {
  role: "user" | "assistant" | "system";
  content: string;
}[];

export const RAW_HISTORY: RawHistory = [
  { role: "user", content: "第3章の冒頭を考えたい。" },
  {
    role: "assistant",
    content: "王の死の翌朝、城下の鐘が鳴らない場面から始めてはどうでしょう。",
  },
  { role: "user", content: "王の死因はまだ決めていない。" },
  {
    role: "assistant",
    content:
      '調べてみます。\n<tool_call>{"name":"search_codex"}</tool_call>\n毒殺と事故死の二案があります。',
  },
  { role: "user", content: "毒殺にしよう。" },
  { role: "assistant", content: "毒殺なら、犯人候補を 3 人に絞れます。" },
  { role: "user", content: "宰相が怪しいな。" },
  { role: "assistant", content: "宰相の動機を整理しましょう。" },
];
export const NEW_USER =
  "王が死ぬ場面に近いイベントを探して、結果を踏まえて整理して。";

/** `chatTurnStoreActions.ts` の agentMsgs 組立て（system → 履歴〔assistant は stripToolProtocol〕→ 新しい user）の写し。 */
export function buildAgentMsgs(
  strip: boolean,
  history: RawHistory,
): AgentMessagePayload[] {
  const messages: AgentMessagePayload[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const message of history) {
    if (message.role === "system") continue;
    if (message.role === "user")
      messages.push({ role: "user", content: message.content });
    else
      messages.push({
        role: "assistant",
        content: strip ? stripToolProtocol(message.content) : message.content,
      });
  }
  messages.push({ role: "user", content: NEW_USER });
  return messages;
}

export type MastraInputMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

/** Mastra へ渡す履歴（user／assistant だけ。system は `instructions`）。呼び手が `stripToolProtocol` を掛ける責務。 */
export function buildMastraMessages(
  strip: boolean,
  history: RawHistory,
): MastraInputMessage[] {
  const messages: MastraInputMessage[] = [];
  for (const message of history) {
    if (message.role === "system") continue;
    messages.push({
      role: message.role,
      content:
        message.role === "assistant" && strip
          ? stripToolProtocol(message.content)
          : message.content,
    });
  }
  messages.push({ role: "user", content: NEW_USER });
  return messages;
}

// ---- tool（小さい固定の 3 本。snapshot の正規形：名前順、schema の key は再帰ソート） ----

export const SMALL_TOOLS: AgentToolDefinition[] = [
  {
    name: "get_scene",
    description: "場面の本文を取得する。",
    inputSchema: {
      properties: {
        ranges: {
          description: "取得する範囲。",
          items: {
            properties: { from: { type: "number" }, to: { type: "number" } },
            required: ["from", "to"],
            type: "object",
          },
          type: "array",
        },
        sceneId: { description: "場面の ID。", type: "string" },
      },
      required: ["sceneId"],
      type: "object",
    },
  },
  {
    name: "list_codex_tags",
    description: "Codex のタグ一覧を返す。",
    inputSchema: { properties: {}, required: [], type: "object" },
  },
  {
    name: "search_events",
    description: "イベントを検索する。",
    inputSchema: {
      properties: {
        limit: { description: "件数の上限。", minimum: 0, type: "number" },
        query: { description: "検索語。", type: "string" },
      },
      required: ["query"],
      type: "object",
    },
  },
];

// ---- route -----------------------------------------------------------------

export interface RouteCase {
  readonly id: string;
  readonly provider: "anthropic" | "openai" | "openrouter";
  readonly model: string;
  readonly apiVariant: string | null;
  /** `buildThinkingParams` の結果の形（現行の renderer が渡す値）。 */
  readonly thinkingParams: ThinkingParams;
  readonly cache: boolean;
  readonly webSearch: WebSearchConfig | null;
  readonly requestMaxOutputTokens: number | null;
  readonly resolvedToolProtocol: "native" | "hermes" | null;
  readonly endpointId: string | null;
  /** tool_use の id の形と、thinking の署名の形（Rust の応答の実際の形）。 */
  readonly style: "anthropic" | "chat" | "responses" | "openrouter-chat";
}

export const ROUTES: readonly RouteCase[] = [
  {
    id: "anthropic",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiVariant: null,
    thinkingParams: {
      thinking: { type: "adaptive", effort: "medium", display: "summarized" },
    },
    cache: true,
    webSearch: null,
    requestMaxOutputTokens: 16000,
    resolvedToolProtocol: "native",
    endpointId: null,
    style: "anthropic",
  },
  {
    id: "openai-chat",
    provider: "openai",
    model: "gpt-5-mini",
    apiVariant: null,
    thinkingParams: { reasoningEnabled: true, reasoningEffort: "medium" },
    cache: false,
    webSearch: null,
    requestMaxOutputTokens: 8000,
    resolvedToolProtocol: "native",
    endpointId: null,
    style: "chat",
  },
  {
    id: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    apiVariant: "responses",
    thinkingParams: { reasoningEnabled: true, reasoningEffort: "high" },
    cache: false,
    webSearch: { enabled: true, agentic: true, maxResults: 5 },
    requestMaxOutputTokens: 8000,
    resolvedToolProtocol: "native",
    endpointId: null,
    style: "responses",
  },
  {
    id: "openrouter-chat-claude",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    apiVariant: null,
    thinkingParams: { reasoningEnabled: true, reasoningEffort: "medium" },
    cache: true,
    webSearch: {
      enabled: true,
      agentic: true,
      allowedDomains: ["example.com"],
    },
    requestMaxOutputTokens: 16000,
    resolvedToolProtocol: "native",
    endpointId: null,
    style: "openrouter-chat",
  },
  {
    id: "openrouter-chat-other",
    provider: "openrouter",
    model: "deepseek/deepseek-v4",
    apiVariant: null,
    thinkingParams: {},
    cache: false,
    webSearch: null,
    requestMaxOutputTokens: null,
    resolvedToolProtocol: null,
    endpointId: null,
    style: "openrouter-chat",
  },
  {
    id: "openrouter-responses",
    provider: "openrouter",
    model: "openai/gpt-5",
    apiVariant: "responses",
    thinkingParams: { reasoningEnabled: true, reasoningEffort: "low" },
    cache: false,
    webSearch: null,
    requestMaxOutputTokens: 8000,
    resolvedToolProtocol: "native",
    endpointId: null,
    style: "responses",
  },
];

// ---- 台本（Rust の応答。route の形で書く） -----------------------------------------

type Block = AgentWireResponse["blocks"][number];

interface Style {
  id: (suffix: string) => string;
  usage: Pick<
    AgentWireResponse,
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "cost"
  >;
  finalUsage: Pick<
    AgentWireResponse,
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "cost"
  >;
  thinking: (text: string) => Block[];
}

const RESPONSES_SIGNATURE = JSON.stringify({
  id: "rs_0a1b2c",
  ec: "gAAAAAB_encrypted==",
});

const STYLES: Record<RouteCase["style"], Style> = {
  anthropic: {
    id: (s) => `toolu_${s}`,
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      cost: null,
    },
    finalUsage: {
      inputTokens: 20,
      outputTokens: 20,
      cacheReadTokens: 570,
      cacheWriteTokens: 0,
      cost: null,
    },
    thinking: (text) => [
      { type: "thinking", content: text, signature: "SIG_abc123==" },
    ],
  },
  chat: {
    id: (s) => `call_${s}`,
    usage: {
      inputTokens: 520,
      outputTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: null,
      cost: null,
    },
    finalUsage: {
      inputTokens: 590,
      outputTokens: 20,
      cacheReadTokens: 570,
      cacheWriteTokens: null,
      cost: null,
    },
    thinking: () => [],
  },
  responses: {
    id: (s) => `call_${s}`,
    usage: {
      inputTokens: 520,
      outputTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: null,
      cost: null,
    },
    finalUsage: {
      inputTokens: 590,
      outputTokens: 20,
      cacheReadTokens: 570,
      cacheWriteTokens: null,
      cost: null,
    },
    thinking: (text) => [
      { type: "thinking", content: text, signature: RESPONSES_SIGNATURE },
    ],
  },
  "openrouter-chat": {
    id: (s) => `call_or_${s}`,
    usage: {
      inputTokens: 520,
      outputTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      cost: 0.0123,
    },
    finalUsage: {
      inputTokens: 590,
      outputTokens: 20,
      cacheReadTokens: 570,
      cacheWriteTokens: 0,
      cost: 0.0045,
    },
    // OpenRouter の reasoning は署名が無い（会話に戻らない）。
    thinking: (text) => [{ type: "thinking", content: text, summary: "要約" }],
  },
};

const final = (style: Style, text: string): AgentWireResponse => ({
  blocks: [{ type: "text", content: text }],
  stopReason: "end_turn",
  ...style.finalUsage,
});

const toolStep = (style: Style, blocks: Block[]): AgentWireResponse => ({
  blocks,
  stopReason: "tool_use",
  ...style.usage,
});

export interface ToolOutcome {
  ok?: unknown;
  err?: string;
}

export interface Scene {
  readonly id: string;
  /** 履歴の assistant に `stripToolProtocol` を掛けるか（既定 true。現行の renderer と同じ）。 */
  readonly strip?: boolean;
  readonly history?: RawHistory;
  /** この scene を走らせる route の style（省略は全 route）。 */
  readonly onlyStyles?: readonly RouteCase["style"][];
  readonly script: (route: RouteCase) => AgentWireResponse[];
  readonly results: Record<string, ToolOutcome>;
}

export const SCENES: readonly Scene[] = [
  {
    id: "A-one-tool",
    script: (route) => {
      const style = STYLES[route.style];
      return [
        toolStep(style, [
          ...style.thinking("検索が要る。"),
          { type: "text", content: "調べます。" },
          // 入力 key の順を辞書順にしていない（query が limit より先）
          {
            type: "tool_use",
            id: style.id("01"),
            name: "search_events",
            input: { query: "王の死", limit: 3 },
          },
        ]),
        final(style, "最終：イベント 2 件を整理しました。"),
      ];
    },
    // 結果 object の key 順も辞書順にしていない（eventId, title, score）。非 ASCII を含む。
    results: {
      search_events: {
        ok: {
          events: [
            { eventId: "e1", title: "王の死", score: 0.9 },
            { eventId: "e2", title: "葬儀", score: 0.5 },
          ],
          total: 2,
        },
      },
    },
  },
  {
    id: "B-two-tools",
    script: (route) => {
      const style = STYLES[route.style];
      return [
        toolStep(style, [
          ...style.thinking("二つ要る。"),
          { type: "text", content: "二つ調べます。" },
          {
            type: "tool_use",
            id: style.id("a"),
            name: "search_events",
            input: { query: "王の死", limit: 3 },
          },
          {
            type: "tool_use",
            id: style.id("b"),
            name: "list_codex_tags",
            input: {},
          },
        ]),
        final(style, "最終：二つの結果を整理しました。"),
      ];
    },
    results: {
      search_events: {
        ok: {
          events: [{ eventId: "e1", title: "王の死", score: 0.9 }],
          total: 1,
        },
      },
      list_codex_tags: { ok: { tags: ["政治", "人物"], count: 2 } },
    },
  },
  {
    id: "C-tool-error",
    script: (route) => {
      const style = STYLES[route.style];
      return [
        toolStep(style, [
          {
            type: "tool_use",
            id: style.id("e"),
            name: "list_codex_tags",
            input: {},
          },
        ]),
        final(style, "エラーを見ました。"),
      ];
    },
    results: { list_codex_tags: { err: "boom: DB が開けない" } },
  },
  {
    // 署名の無い thinking と、1 応答内の複数 text block。
    id: "E-nosig-multitext",
    script: (route) => {
      const style = STYLES[route.style];
      return [
        toolStep(style, [
          { type: "thinking", content: "署名なしの推論。", summary: "要約" },
          { type: "text", content: "前半。" },
          { type: "text", content: "後半。" },
          {
            type: "tool_use",
            id: style.id("n"),
            name: "list_codex_tags",
            input: {},
          },
        ]),
        final(style, "最終。"),
      ];
    },
    results: { list_codex_tags: { ok: { tags: ["政治"], count: 1 } } },
  },
  {
    // 除去なし：履歴の assistant に擬似ツール記法（<tool_call>）を残したまま両側へ流す。
    id: "F-no-strip",
    strip: false,
    script: (route) => [final(STYLES[route.style], "了解。")],
    results: {},
  },
  {
    // 履歴の端：連続する user、空の assistant、前後の空白・改行、CRLF。tool は呼ばない。
    id: "D-history-edge",
    history: [
      { role: "user", content: "最初の質問。" },
      { role: "user", content: "続けてもう一つ。" },
      { role: "assistant", content: "" },
      { role: "user", content: "  前後に空白と改行  \n" },
      { role: "assistant", content: "行1\r\n行2\n\n\n行3" },
    ],
    script: (route) => [final(STYLES[route.style], "了解。")],
    results: {},
  },
  {
    // Responses の reasoning：summary が空（content が ""）で、署名（id＋encrypted_content）だけの block。
    // 会話に戻さないと Responses は tool 継続で落ちる。reasoning → function_call の順は prompt で確かめる。
    id: "G-responses-signature-only",
    onlyStyles: ["responses"],
    script: (route) => {
      const style = STYLES[route.style];
      return [
        toolStep(style, [
          { type: "thinking", content: "", signature: RESPONSES_SIGNATURE },
          {
            type: "tool_use",
            id: style.id("g"),
            name: "search_events",
            input: { query: "戴冠", limit: 1 },
          },
        ]),
        final(style, "最終。"),
      ];
    },
    results: { search_events: { ok: { events: [], total: 0 } } },
  },
];

export function scenesFor(route: RouteCase): Scene[] {
  return SCENES.filter(
    (scene) => !scene.onlyStyles || scene.onlyStyles.includes(route.style),
  );
}

/** renderer の `agentLoop` が tool_result の content を作る規則（truncation を除く）。execute が文字列で返す。 */
export function formatToolResultContent(
  outcome: ToolOutcome | undefined,
): string {
  if (outcome?.err) throw new Error(outcome.err);
  if (outcome?.ok == null) return "No result (not found).";
  return JSON.stringify(outcome.ok);
}

export function asWireTools(
  tools: readonly AgentToolDefinition[],
): AgentWireToolDefinition[] {
  return tools.map((tool) => structuredClone(tool));
}
