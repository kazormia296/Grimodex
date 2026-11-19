import type { Editor } from "@tiptap/core";
import type { InlineAiContext } from "./inlineAiTypes";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { visibleCodexForAi } from "@/features/codex/context/codexHiddenFromAi";

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
    // ユーザー定義のインライン追記指示 (project_settings)。両呼び出し点を1箇所でカバー。
    customInstruction: useSettingsStore
      .getState()
      .get("aiPrompt.custom.inline", ""),
  };
}

/**
 * AI へ送る context を作る。`buildInlineAiContext` との違いは、作者が hidden（AI に
 * 秘匿）と印した Codex を要約から除くこと。エディタ由来の項目（選択・カーソル・本文）は
 * await の前に同期で取り、DB を引く hidden 判定の間にカーソルが動いても変わらない。
 * 判定は chat の通常の文脈と同じ正本（`listCodexIdsHiddenFromAi`）で、現在の場面が
 * あればその場面の Phase で解決する。AI へ送る経路は必ずこちらを使う。
 */
export async function buildInlineAiContextForSend(
  input: BuildInlineAiContextInput & {
    projectId?: string | null;
    /** 現在の場面。Codex・Snippet の編集中など場面でないときは null。 */
    sceneId?: string | null;
  },
): Promise<InlineAiContext> {
  const { projectId, sceneId, ...rest } = input;
  const base = buildInlineAiContext({ ...rest, matchedCodexIds: [] });
  // Phase で hidden を解除された Codex は、base ではなく Phase 解決後の要約を渡す。
  const visible = await visibleCodexForAi(rest.matchedCodexIds, {
    projectId,
    sceneId,
  });
  return {
    ...base,
    codexSummaries: buildCodexSummaries(
      visible.ids,
      rest.codexEntries,
      visible.summaries,
    ),
  };
}

function buildCodexSummaries(
  matchedIds: string[],
  entries: CodexEntryLike[],
  resolvedSummaries?: ReadonlyMap<string, string | null>,
): string {
  if (matchedIds.length === 0) return "";
  const idSet = new Set(matchedIds);
  const lines: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!idSet.has(entry.id)) continue;
    const summary = (
      (resolvedSummaries?.has(entry.id)
        ? resolvedSummaries.get(entry.id)
        : entry.summary) ?? ""
    ).trim();
    if (!summary) continue;
    const line = `- ${entry.name}: ${summary}`;
    if (total + line.length + 1 > CODEX_SUMMARIES_LIMIT) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}
