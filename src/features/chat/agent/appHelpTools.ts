/**
 * アプリ自体の使い方を答えるための read ツール 3 本（設計書 §5）。
 *
 *  - get_app_help_index: ヘルプ項目の索引（id・題・種類を 1 項目 1 行）。query／kind で絞る
 *  - get_app_help:       1 項目の詳細（実際のキー割当、OS での可否、ヘルプ文書の本文）
 *  - get_ui_state:       今の UI 状態（allowlist 項目だけ。本文・秘密・provider 設定は返さない）
 *
 * いずれも renderer 内で完結し、新しい IPC・外部送信先・保存は作らない。
 * 設定の値は返さない。存在しない id は error と索引への案内を返し、作った id は実行しない。
 * 実装本体（ヘルプ文書と locale の展開）は初回の呼び出しまで読み込まない。
 */
import type { ToolResult } from "./agentTypes";
import { countTokens } from "../contextBuilder";

type ToolReturn = Omit<ToolResult, "toolCallId">;

/** 検索語・id の長さの上限（超えたら error）。 */
export const MAX_HELP_INPUT_LENGTH = 200;
/** error の summary に未知の入力を写すときの上限。 */
const ECHO_LENGTH = 60;

function clip(text: string): string {
  return text.length > ECHO_LENGTH ? `${text.slice(0, ECHO_LENGTH)}…` : text;
}

function ok(name: string, content: unknown, summary: string): ToolReturn {
  return {
    name,
    content,
    summary,
    tokensUsed: countTokens(JSON.stringify(content)),
  };
}

function fail(name: string, message: string, content: unknown): ToolReturn {
  return {
    name,
    content,
    summary: message,
    tokensUsed: countTokens(JSON.stringify(content)),
    error: message,
  };
}

export async function getAppHelpIndexTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const { HELP_KINDS, listHelpIndex } = await import("@/help/helpIndex");
  const query =
    typeof params["query"] === "string" ? params["query"] : undefined;
  if (query !== undefined && query.length > MAX_HELP_INPUT_LENGTH) {
    return fail("get_app_help_index", "query is too long", {
      error: `query is too long (max ${MAX_HELP_INPUT_LENGTH} characters). Use a few short keywords.`,
    });
  }
  const rawKind = params["kind"];
  const kind = HELP_KINDS.find((candidate) => candidate === rawKind);
  if (rawKind !== undefined && rawKind !== null && rawKind !== "" && !kind) {
    return fail(
      "get_app_help_index",
      `Unknown kind: ${clip(String(rawKind))}`,
      {
        error: `Unknown kind. Use one of: ${HELP_KINDS.join(", ")}`,
      },
    );
  }
  const { total, items } = listHelpIndex({ query, kind });
  return ok(
    "get_app_help_index",
    {
      total,
      items,
      ...(total === 0
        ? {
            hint: "No help entry matches. The help index does not list this. Tell the user the help does not cover it (do not claim the feature does not exist, and do not guess); suggest different keywords or the related panel/settings screen if you can.",
          }
        : {}),
    },
    `${items.length} of ${total} help entries`,
  );
}

export async function getAppHelpTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const { getHelpDetail, suggestHelpIds } = await import("@/help/helpIndex");
  const id = typeof params["id"] === "string" ? params["id"].trim() : "";
  if (id.length > MAX_HELP_INPUT_LENGTH) {
    return fail("get_app_help", "id is too long", {
      error: `id is too long (max ${MAX_HELP_INPUT_LENGTH} characters). Use an id exactly as listed by get_app_help_index.`,
      suggestions: [],
    });
  }
  const detail = id ? getHelpDetail(id) : null;
  if (!detail) {
    return fail(
      "get_app_help",
      `Unknown help id: ${id ? clip(id) : "(empty)"}`,
      {
        error:
          "Unknown help id. Use an id exactly as listed by get_app_help_index.",
        suggestions: id ? suggestHelpIds(id) : [],
      },
    );
  }
  return ok("get_app_help", detail, `Help entry ${id}`);
}

export async function getUiStateTool(): Promise<ToolReturn> {
  const { readUiState } = await import("@/help/uiState");
  return ok("get_ui_state", readUiState(), "Current UI state");
}
