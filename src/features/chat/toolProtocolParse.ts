/**
 * Hermes/ChatML テキストツールプロトコルの **解決・パース・エンコード** を
 * 一箇所に集約した共有ユーティリティ。
 *
 * 役割分担:
 * - [`toolProtocol.ts`](./toolProtocol.ts) `stripToolProtocol` … 表示・履歴の strip（純関数）
 * - 本モジュール … Agent ループで本文 `<tool_call>` を実ツール呼び出しへ変換する
 *   受信パース + プロトコル解決 + （Phase B 用）送信エンコード
 *
 * Rust 側（src-tauri/src/ai.rs）は独立実装。論理を一致させ、両方をテストで gate する。
 */
import {
  type AiProvider,
  type AiSettings,
  type ToolProtocolMode,
} from "./types";
import { stripToolProtocol } from "./toolProtocol";

/** 解決後のプロトコル（曖昧さを排した二値）。 */
export type ResolvedToolProtocol = "native" | "hermes";

/**
 * Hermes 解決の対象となる HTTP OpenAI 互換プロバイダ。
 * Anthropic / CLI はここに含めない（常に native）。
 */
const HTTP_OPENAI_COMPAT: readonly AiProvider[] = [
  "openrouter",
  "openai",
  "ollama",
  "openai-compatible",
  "ai-novelist",
];

/**
 * provider / model / mode からツールプロトコルを解決する。
 * Rust `resolve_tool_protocol` と同一論理（provider ゲート最優先・auto は
 * model 名に `hermes` を含む場合のみ Hermes）。
 */
export function resolveToolProtocol(
  provider: AiProvider,
  model: string,
  mode: ToolProtocolMode = "auto",
): ResolvedToolProtocol {
  // provider ゲート: HTTP OpenAI 互換以外は常に native。
  if (!HTTP_OPENAI_COMPAT.includes(provider)) return "native";
  if (mode === "native") return "native";
  if (mode === "hermes") return "hermes";
  // auto: model 名に `hermes` を含むときのみ Hermes（qwen 等は対象外）。
  return model.toLowerCase().includes("hermes") ? "hermes" : "native";
}

/** AiSettings から Hermes プロトコルかどうかを判定する薄いラッパ。 */
export function isHermesProtocol(
  settings: AiSettings | null | undefined,
): boolean {
  if (!settings) return false;
  return (
    resolveToolProtocol(
      settings.provider,
      settings.model,
      settings.toolProtocolMode ?? "auto",
    ) === "hermes"
  );
}

/** 本文から抽出した 1 件のツール呼び出し。 */
export interface HermesToolCall {
  /** 合成 ID（Hermes では wire に出ず、ループ内 name ペアリング用）。 */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ParseHermesResult {
  /** タグ除去後の本文（`stripToolProtocol` と同セマンティクス）。 */
  strippedText: string;
  /** allowed に一致した有効なツール呼び出しのみ。 */
  calls: HermesToolCall[];
}

/** `arguments` / `input` を Record へ正規化（object も stringified JSON も許容）。 */
function coerceArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

/**
 * Mutating agent tools. The Hermes body-text `<tool_call>` channel (models
 * without native function calling) MUST NOT be able to invoke these: a Web
 * search result echoed into the assistant body as a `<tool_call>` is
 * indistinguishable from a genuine model call, so allowing writes via that
 * channel is an injection-driven write vector (and the only backstop, AiPolicy,
 * fail-opens to all-writes-enabled on a fresh/empty project). Native providers
 * carry tool calls in a structured field separate from body text, so they are
 * unaffected. Callers building the Hermes allow-list filter these out.
 *
 * Must stay in sync with `MUTATING_EXECUTORS` in toolExecutors.ts — a test in
 * toolExecutors.test.ts asserts the two never drift apart.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_codex_entry",
  "update_codex_entry",
  "create_snippet",
  "apply_ai_tree_plan",
  "propose_scene_body",
]);

/** Hermes allow-list = declared tool names minus mutating ones (write block). */
export function hermesAllowedToolNames(names: readonly string[]): string[] {
  return names.filter((n) => !MUTATING_TOOL_NAMES.has(n));
}

/**
 * 本文中の `<tool_call>{...}</tool_call>` を抽出する。
 * - `name` が `allowedNames` に一致するものだけ `calls` に積む（合成 ID 付与）。
 * - 壊れた JSON・未知ツール・`<tool_response>` を含め、タグは strippedText から除去。
 * - `arguments` / `input` 両キー対応。`arguments` が stringified JSON でも可。
 */
export function parseHermesToolCalls(
  content: string,
  allowedNames: readonly string[] | ReadonlySet<string>,
): ParseHermesResult {
  const strippedText = stripToolProtocol(content);
  const allowed =
    allowedNames instanceof Set
      ? allowedNames
      : new Set<string>(allowedNames as readonly string[]);
  const calls: HermesToolCall[] = [];
  if (!content || allowed.size === 0) {
    return { strippedText, calls };
  }

  const open = "<tool_call>";
  const close = "</tool_call>";
  let rest = content;
  let idx = rest.indexOf(open);
  while (idx !== -1) {
    const after = rest.slice(idx + open.length);
    const closeRel = after.indexOf(close);
    if (closeRel === -1) break; // 未閉じ: 以降は捨てる（呼び出しにしない）。
    const inner = after.slice(0, closeRel).trim();
    rest = after.slice(closeRel + close.length);
    idx = rest.indexOf(open);

    let obj: unknown;
    try {
      obj = JSON.parse(inner);
    } catch {
      continue; // 壊れた JSON はスキップ（タグは strippedText 側で除去済み）。
    }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "";
    if (!name || !allowed.has(name)) continue;
    const input = coerceArgs("arguments" in rec ? rec.arguments : rec.input);
    calls.push({ id: `hermes-${calls.length}`, name, input });
  }

  return { strippedText, calls };
}

// ---------------------------------------------------------------------------
// 送信エンコード（Phase B / spike で必要性確定後に使用）。
// ---------------------------------------------------------------------------

/** assistant 履歴の tool use を `<tool_call>` テキストへエンコードする。 */
export function formatHermesToolCall(
  name: string,
  input: Record<string, unknown>,
): string {
  return `<tool_call>\n${JSON.stringify({ name, arguments: input })}\n</tool_call>`;
}

/** tool result を `<tool_response>` テキストへエンコードする。 */
export function formatHermesToolResponse(
  name: string,
  content: string,
  isError = false,
): string {
  const payload: Record<string, unknown> = { name, content };
  if (isError) payload.is_error = true;
  return `<tool_response>\n${JSON.stringify(payload)}\n</tool_response>`;
}

/**
 * Nous Hermes 標準の function-calling system プロンプト断片を組む。
 * Rust `build_hermes_tools_preamble` と同趣旨（`<tools>` にツール schema を列挙）。
 */
export function buildHermesToolsPreamble(
  tools: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>,
): string {
  const lines = tools.map((t) =>
    JSON.stringify({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }),
  );
  return (
    "You are a function calling AI model. You are provided with function signatures within " +
    "<tools></tools> XML tags. You may call one or more functions to assist with the user query. " +
    "Don't make assumptions about what values to plug into functions. " +
    "Here are the available tools:\n<tools>\n" +
    lines.join("\n") +
    "\n</tools>\n" +
    "For each function call, return a json object with the function name and arguments within " +
    "<tool_call></tool_call> XML tags, like:\n" +
    '<tool_call>\n{"name": <function-name>, "arguments": <args-dict>}\n</tool_call>\n' +
    "The tool result is returned within <tool_response></tool_response> tags. " +
    "Only call tools listed above."
  );
}
