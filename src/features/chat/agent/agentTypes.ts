// LLMに送るツールパラメータスキーマ (JSON Schema サブセット)
export interface ToolParameterSchema {
  type: string;
  description: string;
  items?: { type: string };
  enum?: string[];
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

// LLMレスポンスのブロック
export type ResponseBlock =
  | { type: "text"; content: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "thinking"; content: string; summary?: string };

// LLMレスポンス（パース済み）
export interface AgentLLMResponse {
  blocks: ResponseBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
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
  | { role: "assistant"; content: string; toolUses?: ToolUseBlock[] }
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
