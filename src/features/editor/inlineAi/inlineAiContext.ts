import type { Editor } from "@tiptap/core";
import type { InlineAiContext } from "./inlineAiTypes";

/** カーソル前後の抽出文字数（バイト換算ではなく PM 位置単位） */
const CURSOR_BEFORE_CHARS = 500;
const CURSOR_AFTER_CHARS = 200;
/** codexSummaries の合計文字数上限（LLM コンテキストの肥大化防止） */
const CODEX_SUMMARIES_LIMIT = 3000;

export interface CodexEntryLike {
  id: string;
  name: string;
  summary: string | null;
}

export interface BuildInlineAiContextInput {
  editor: Editor;
  projectTitle: string;
  sceneTitle: string;
  /** 現在のシーンで検出されている Codex エントリ ID 一覧 */
  matchedCodexIds: string[];
  /** プロジェクト内の全 Codex エントリ */
  codexEntries: CodexEntryLike[];
  /** InlineAIPalette 等から渡されるユーザー引数 */
  arg?: string;
}

/**
 * 設計書1056-1073 の 5 層サブセットに沿った context を構築する。
 * - projectTitle / sceneTitle: 作品・シーン情報
 * - sceneText: 現在のシーン全文
 * - codexSummaries: 自動検出された Codex エントリの `name: summary`
 * - selectedText: 選択範囲（あれば）
 * - cursorContext: 選択なし時のみ、カーソル前後テキストに `【カーソル】` を挿入
 */
export function buildInlineAiContext(
  input: BuildInlineAiContextInput,
): InlineAiContext {
  const {
    editor,
    projectTitle,
    sceneTitle,
    matchedCodexIds,
    codexEntries,
    arg,
  } = input;

  const doc = editor.state.doc;
  const { from, to } = editor.state.selection;
  const sceneText = editor.getText();
  const hasSelection = from !== to;
  const selectedText = hasSelection ? doc.textBetween(from, to) : undefined;

  let cursorContext: string | undefined;
  if (!hasSelection) {
    const before = doc.textBetween(
      Math.max(0, from - CURSOR_BEFORE_CHARS),
      from,
      "\n",
      " ",
    );
    const after = doc.textBetween(
      to,
      Math.min(doc.content.size, to + CURSOR_AFTER_CHARS),
      "\n",
      " ",
    );
    cursorContext = `${before}【カーソル】${after}`;
  }

  const codexSummaries = buildCodexSummaries(matchedCodexIds, codexEntries);

  return {
    projectTitle,
    sceneTitle,
    sceneText,
    codexSummaries,
    selectedText,
    cursorContext,
    arg,
  };
}

function buildCodexSummaries(
  matchedIds: string[],
  entries: CodexEntryLike[],
): string {
  if (matchedIds.length === 0) return "";
  const idSet = new Set(matchedIds);
  const lines: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!idSet.has(entry.id)) continue;
    const summary = (entry.summary ?? "").trim();
    if (!summary) continue;
    const line = `- ${entry.name}: ${summary}`;
    if (total + line.length + 1 > CODEX_SUMMARIES_LIMIT) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}
