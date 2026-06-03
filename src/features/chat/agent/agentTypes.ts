// LLMに送るツールパラメータスキーマ (JSON Schema サブセット)
// items / properties で再帰でき、ネストした array<object> を表現できる。
// 既存ツール定義 (`items: { type: string }`) は本型のサブセットなので後方互換。
export interface ToolParameterSchema {
  type: string;
  /** ネストしたプロパティでは省略可。トップレベルは付けるのが望ましい。 */
  description?: string;
  items?: ToolParameterSchema;
  enum?: string[];
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
}

// LLMに送るツール定義
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, ToolParameterSchema>;
    required: string[];
  };
}

// thinking ブロック（マルチターン会話で signature ごと API に返す必要がある）
export interface ThinkingBlock {
  thinking: string;
  signature: string;
}

// LLMレスポンスのブロック
export type ResponseBlock =
  | { type: "text"; content: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "thinking"; content: string; summary?: string; signature?: string };

// Web 検索 (RAG) の引用。Rust `Citation` (camelCase) と対応。
export interface Citation {
  url: string;
  title: string;
  /** 回答中で引用された抜粋 (Rust cited_text)。 */
  citedText: string;
  snippet?: string;
  publishedDate?: string;
}

// Web 検索 (RAG) 設定。Rust `WebSearchConfig` (camelCase) と対応。
export interface WebSearchConfig {
  enabled: boolean;
  /** Agent モード併用時 true。OpenRouter で server tool / web plugin を出し分ける。 */
  agentic: boolean;
  maxResults?: number;
  maxUses?: number;
  /**
   * Phase 2: ドメイン allowlist（allow モード時のみ）。Anthropic native
   * web_search / OpenRouter(exa) のドメイン制御に渡る。allowed と blocked は
   * 排他（allow 優先）。
   */
  allowedDomains?: string[];
  /** Phase 2: ドメイン blocklist（block モード時のみ）。 */
  blockedDomains?: string[];
  /**
   * Phase 2: OpenRouter(exa) の 1 ページ content token 上限（未指定 = 既定）。
   * Anthropic には対応フィールドが無いため Rust 側で無視される。
   */
  maxContentTokens?: number;
}

// LLMレスポンス（パース済み）
export interface AgentLLMResponse {
  blocks: ResponseBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  /** Web 検索引用 (RAG 無効時は undefined/空)。 */
  citations?: Citation[];
  /** このリクエストの概算コスト (USD)。OpenRouter のみ実値、他は undefined。 */
  cost?: number;
}

// アシスタントメッセージ内のtool_useブロック（多ターン会話用）
export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// エージェント会話の正規化メッセージ形式
export type AgentMessagePayload =
  | { role: "user"; content: string }
  | { role: "system"; content: string }
  | {
      role: "assistant";
      content: string;
      toolUses?: ToolUseBlock[];
      /** thinking ブロック（signature 付き）。マルチターン会話でそのまま API に返す。 */
      thinkingBlocks?: ThinkingBlock[];
    }
  | {
      role: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

// ツール実行結果
export interface ToolResult {
  toolCallId: string;
  name: string;
  content: unknown;
  summary: string;
  tokensUsed: number;
  error?: string;
}

// メッセージmetadataに保存するツール呼び出し記録
export interface ToolCallRecord {
  name: string;
  params: Record<string, unknown>;
  resultSummary: string;
  tokensUsed: number;
}

// エージェントループ進捗（UIコールバック用）
export interface AgentLoopProgress {
  totalCalls: number;
  maxCalls: number;
  tokensUsed: number;
  tokenBudget: number;
  currentToolName?: string;
}

// ── ask_user（ユーザーへの質問）ツール ───────────────────────────────────────

/** 1 質問の回答形式。single=単一選択 / multi=複数選択 / text=自由記述。 */
export type AskUserQuestionKind = "single" | "multi" | "text";

/** 正規化済みの 1 質問仕様（normalizeAskUserSpec の出力）。 */
export interface AskUserQuestionSpec {
  question: string;
  /** UI 用の短い見出し（任意）。 */
  header?: string;
  kind: AskUserQuestionKind;
  /** single/multi の選択肢。text では空配列。 */
  options: string[];
  /** single/multi に「その他（自由記述）」を許すか。 */
  allowFreeText: boolean;
}

/** 1 回の ask_user 呼び出しが内包する質問群。 */
export interface AskUserSpec {
  questions: AskUserQuestionSpec[];
}

/** 1 質問に対するユーザーの回答。 */
export interface UserQuestionAnswer {
  questionIndex: number;
  header?: string;
  question: string;
  /** single/multi の選択結果（single は length<=1）。 */
  selected?: string[];
  /** text 回答、または single/multi の「その他」自由記述。 */
  text?: string;
}

/** ask_user ツールが LLM に返す tool_result content。 */
export interface AskUserContent {
  answers: UserQuestionAnswer[];
  /** ユーザーが回答せず棄却（Skip / Stop）した場合 true。 */
  dismissed?: boolean;
  /** dismissed 時に LLM へ渡す制御メッセージ。 */
  note?: string;
}
