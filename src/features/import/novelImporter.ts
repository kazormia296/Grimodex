/**
 * AIのべりすと (.novel) → Grimodex インポート計画の純関数層。
 *
 * 文字列レベルの parse は src/lib/novelFormat.ts が担当し、ここでは
 * ProseMirror 変換と Grimodex のインポート入力（ImportedNode /
 * ParsedCodexEntry）への組み立てを行う。
 */

import type { NovelFile } from "@/lib/novelFormat";
import { stripBracketWrapper } from "@/lib/novelFormat";
import type { ImportedNode } from "./importTypes";
import type { ParsedCodexEntry } from "./novelcrafterParser";

/** キャラクターブック 1 エントリの取り込み草案（タイプは UI で選択）。 */
export interface NovelCodexDraft {
  /** 先頭タグ。 */
  name: string;
  /** 残りタグ。 */
  aliases: string[];
  /** 外周ブラケット除去済みの説明文。 */
  description: string;
}

export interface NovelImportPlan {
  projectTitle: string;
  /** ルート直下に作る単一シーン。 */
  scene: ImportedNode;
  codexDrafts: NovelCodexDraft[];
  memory: string;
  footnote: string;
  /** 本文の行数（プレビュー表示用）。 */
  bodyLineCount: number;
  /** 本文の文字数（改行除く、プレビュー表示用）。 */
  bodyCharCount: number;
  warnings: string[];
}

/** `<br>`（自己閉じ/大文字耐性）と生改行の両方を行区切りとして分解する。 */
export function splitNovelBodyLines(body: string): string[] {
  return body.split(/<br\s*\/?>|\n/i);
}

/**
 * .novel 本文を ProseMirror JSON に変換する。1 行 = 1 段落（AIのべりすとの
 * 本文は行指向）。空行は空段落になる — kakuyomu の「空行 = 段落区切り」
 * 規約とは意図的に異なる。
 */
export function novelBodyToProseMirror(body: string): string {
  if (!body.trim()) {
    return JSON.stringify({ type: "doc", content: [] });
  }
  const content = splitNovelBodyLines(body).map((line) =>
    line.length > 0
      ? {
          type: "paragraph",
          content: [{ type: "text", text: line }],
        }
      : { type: "paragraph" },
  );
  return JSON.stringify({ type: "doc", content });
}

/** parse 済み NovelFile からインポート計画を組み立てる。 */
export function buildNovelImportPlan(
  novel: NovelFile,
  fallbackTitle: string,
): NovelImportPlan {
  const warnings: string[] = [];
  const projectTitle = novel.title.trim() || fallbackTitle.trim() || "Imported";

  const lines = novel.body.trim() ? splitNovelBodyLines(novel.body) : [];
  if (lines.length === 0) {
    warnings.push("本文が空です（キャラクターブックのみ取り込みます）");
  }

  const codexDrafts: NovelCodexDraft[] = novel.charBook.map((entry) => ({
    name: entry.tags[0]!,
    aliases: entry.tags.slice(1),
    description: stripBracketWrapper(entry.content),
  }));

  return {
    projectTitle,
    scene: {
      kind: "scene",
      id: crypto.randomUUID(),
      title: projectTitle,
      bodyProseMirror: novelBodyToProseMirror(novel.body),
    },
    codexDrafts,
    memory: novel.memory.trim(),
    footnote: novel.footnote.trim(),
    bodyLineCount: lines.length,
    bodyCharCount: lines.reduce((sum, line) => sum + line.length, 0),
    warnings,
  };
}

/**
 * 草案を importCodexEntries の入力に変換する。`summary` に説明文を入れると
 * importApi 側が ProseMirror 化して codex の content に書き込む。
 */
export function codexDraftsToParsedEntries(
  drafts: NovelCodexDraft[],
  typeSlugs: string[],
): ParsedCodexEntry[] {
  return drafts.map((draft, i) => ({
    id: crypto.randomUUID(),
    ncId: "",
    type: typeSlugs[i] || "character",
    name: draft.name,
    aliases: draft.aliases,
    summary: draft.description,
    content: "{}",
    contextMode: "mentioned" as const,
    tagsCache: "[]",
  }));
}
