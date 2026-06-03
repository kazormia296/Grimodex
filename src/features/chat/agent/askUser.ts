import type {
  AskUserContent,
  AskUserQuestionKind,
  AskUserQuestionSpec,
  AskUserSpec,
  ToolResult,
} from "./agentTypes";
import { countTokens } from "../contextBuilder";

const VALID_KINDS = new Set<AskUserQuestionKind>(["single", "multi", "text"]);

/**
 * LLM が渡した ask_user の生入力を検証・正規化する。
 * - questions が配列でない / 空 / 有効な質問が 0 件なら null（呼び出し側で error result にする）。
 * - kind が不正なら "text" に倒す。single/multi で options が空なら "text" に降格。
 * - options / header は安全側にサニタイズ。
 */
export function normalizeAskUserSpec(
  params: Record<string, unknown>,
): AskUserSpec | null {
  const raw = (params as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const questions: AskUserQuestionSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    const question = typeof r.question === "string" ? r.question.trim() : "";
    if (!question) continue;

    const rawKind = typeof r.kind === "string" ? r.kind : "";
    let kind: AskUserQuestionKind = VALID_KINDS.has(
      rawKind as AskUserQuestionKind,
    )
      ? (rawKind as AskUserQuestionKind)
      : "text";

    const options = Array.isArray(r.options)
      ? r.options.filter(
          (o): o is string => typeof o === "string" && o.trim().length > 0,
        )
      : [];

    // single/multi で選択肢が無ければ自由記述に降格（UI が空の選択肢を出さないため）。
    if ((kind === "single" || kind === "multi") && options.length === 0) {
      kind = "text";
    }

    const header =
      typeof r.header === "string" && r.header.trim()
        ? r.header.trim()
        : undefined;

    questions.push({
      question,
      header,
      kind,
      options,
      allowFreeText: r.allowFreeText === true,
    });
  }

  if (questions.length === 0) return null;
  return { questions };
}

/**
 * ユーザー回答（または dismiss）から ask_user の ToolResult を組み立てる。
 * - content: LLM に渡る構造化回答（tool_result content）。
 * - summary: metadata 永続化 → 履歴での read-only 再描画ソース（機械可読 JSON）。
 *   ToolCallRecord は summary しか保存しないため、再描画に必要な回答をここへ埋める。
 */
export function buildAskUserResult(
  toolCallId: string,
  answer: AskUserContent,
  dismissNote: string,
): ToolResult {
  const dismissed = answer.dismissed === true;
  const content: AskUserContent = dismissed
    ? { answers: [], dismissed: true, note: dismissNote }
    : { answers: answer.answers };

  const json = JSON.stringify(content);
  const summary = JSON.stringify(
    dismissed ? { dismissed: true } : { answers: content.answers },
  );

  return {
    toolCallId,
    name: "ask_user",
    content,
    summary,
    tokensUsed: countTokens(json),
  };
}

/** Skip / Stop / セッション切替などでユーザーが回答せず終えたときの sentinel。 */
export function dismissedAskUserResult(
  toolCallId: string,
  dismissNote: string,
): ToolResult {
  return buildAskUserResult(
    toolCallId,
    { answers: [], dismissed: true },
    dismissNote,
  );
}

/** 入力が不正だった場合の error result（LLM には is_error の tool_result として返る）。 */
export function invalidAskUserResult(
  toolCallId: string,
  message: string,
): ToolResult {
  return {
    toolCallId,
    name: "ask_user",
    content: null,
    summary: message,
    tokensUsed: 0,
    error: message,
  };
}
