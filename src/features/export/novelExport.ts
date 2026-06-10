/**
 * AIのべりすと (.novel) エクスポートの純関数層。
 *
 * ProseMirror JSON → 行配列（1 段落 = 1 行、AIのべりすとの行指向本文）の
 * 変換と、フル .novel 文字列の組み立てを行う。セクション構造は
 * src/lib/novelFormat.ts の buildNovelFile に委譲する。
 */

import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import {
  buildNovelFile,
  sanitizeCharBookTag,
  sanitizeNovelBodyLine,
  sanitizeNovelText,
  type NovelCharBookEntry,
  type NovelFile,
} from "@/lib/novelFormat";
import type { MentionNameResolver } from "./exportEngine";
import { renderRubyText } from "./rubyFormats";

interface PMNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
}

interface NovelRenderCtx {
  resolveMentionName?: MentionNameResolver;
}

// ────────────────────────────────────────────────────────────────────
// ProseMirror JSON → 行配列
// ────────────────────────────────────────────────────────────────────

/**
 * ProseMirror doc を .novel 向けの行配列に変換する。
 *
 * - 1 段落 = 1 行、空段落 = 空行（AIのべりすとの本文規約）
 * - テキストノード内の `\n`（kakuyomu 由来シーンの段落内改行）も行分割
 * - ルビは plaintext 既定の `漢字(かんじ)`、傍点はテキストのみ
 *   （青空注記は AI 入力テキストを汚すため意図的に出さない）
 * - sceneBeat はプロンプトメタデータなので除去、generatedProseBlock は unwrap
 */
export function pmDocToNovelLines(
  contentJson: string | undefined,
  ctx: NovelRenderCtx = {},
): string[] {
  if (!contentJson || contentJson === "{}") return [];
  let doc: PMNode;
  try {
    doc = JSON.parse(contentJson) as PMNode;
  } catch {
    return [];
  }
  return blockNodesToLines(doc.content ?? [], ctx);
}

/**
 * NOTE: 行配列への追記は spread（`push(...arr)`）を使わない。V8 は引数
 * 約 12.5 万個で RangeError になるため、10 万行クラスの長編本文（.novel は
 * 全文が単一シーンになりがち）で確実に落ちる。要素ループで追記する。
 */
function appendLines(target: string[], source: string[]): void {
  for (const line of source) target.push(line);
}

function blockNodesToLines(nodes: PMNode[], ctx: NovelRenderCtx): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    appendLines(lines, blockToLines(node, ctx));
  }
  return lines;
}

function blockToLines(node: PMNode, ctx: NovelRenderCtx): string[] {
  switch (node.type) {
    case "paragraph":
    case "heading": {
      const inner = renderInlineChildren(node.content ?? [], ctx);
      return inner === "" ? [""] : inner.split("\n");
    }

    case "sceneBeat":
      // Beat はプロンプトメタデータ — 出力から完全除去
      return [];

    case "generatedProseBlock":
      // 生成 prose は中身の段落だけを残す（unwrap）
      return blockNodesToLines(node.content ?? [], ctx);

    case "sceneBreak":
      return ["* * *"];

    case "horizontalRule":
      return ["---"];

    case "codeBlock": {
      const code = (node.content ?? []).map((c) => c.text ?? "").join("");
      return code === "" ? [] : code.split("\n");
    }

    case "bulletList":
    case "orderedList":
    case "taskList": {
      const lines: string[] = [];
      let index = 1;
      for (const item of node.content ?? []) {
        const marker = node.type === "orderedList" ? `${index}. ` : "・";
        index += 1;
        const itemLines = blockNodesToLines(item.content ?? [], ctx);
        appendLines(
          lines,
          itemLines.map((line, i) => (i === 0 ? marker + line : line)),
        );
      }
      return lines;
    }

    case "blockquote":
      return blockNodesToLines(node.content ?? [], ctx).map((line) =>
        line.length > 0 ? `> ${line}` : ">",
      );

    default: {
      // 未知ノード: 子にブロックがあればブロックとして、なければインラインとして展開
      const children = node.content ?? [];
      if (children.some((c) => isBlockLike(c))) {
        return blockNodesToLines(children, ctx);
      }
      const inner = renderInlineChildren(children, ctx);
      return inner === "" ? [] : inner.split("\n");
    }
  }
}

function isBlockLike(node: PMNode): boolean {
  return (
    node.type !== "text" &&
    node.type !== "hardBreak" &&
    node.type !== "ruby" &&
    node.type !== "mention" &&
    node.content !== undefined
  );
}

function renderInlineChildren(nodes: PMNode[], ctx: NovelRenderCtx): string {
  return nodes.map((n) => renderInline(n, ctx)).join("");
}

function renderInline(node: PMNode, ctx: NovelRenderCtx): string {
  switch (node.type) {
    case "text":
      // マークは全て plain（.novel はプレーンテキスト）
      return node.text ?? "";

    case "hardBreak":
      return "\n";

    case "ruby":
      return renderRubyText(
        (node.attrs?.base as string) ?? "",
        (node.attrs?.annotation as string) ?? "",
        "parentheses",
      );

    case "mention": {
      const id = (node.attrs?.id as string) ?? "";
      const label = (node.attrs?.label as string | undefined) ?? "";
      const fallback = label || id;
      return ctx.resolveMentionName
        ? ctx.resolveMentionName(id, fallback)
        : fallback;
    }

    default:
      return renderInlineChildren(node.content ?? [], ctx);
  }
}

// ────────────────────────────────────────────────────────────────────
// シーン順序の解決
// ────────────────────────────────────────────────────────────────────

/**
 * チェック済みシーン ID をツリーの表示順（sortOrder DFS）で返す。
 * Note ノードは除外（exportEngine.buildBlocks と同じ規約）。
 */
export function collectCheckedSceneIdsInOrder(
  nodes: TreeNodeData[],
  checkedIds: Set<string>,
): string[] {
  const result: string[] = [];

  function walk(parentId: string | null): void {
    const children = nodes
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
    for (const node of children) {
      if (node.nodeType === "folder") {
        walk(node.id);
      } else if (node.nodeType === "scene" && checkedIds.has(node.id)) {
        result.push(node.id);
      }
    }
  }

  walk(null);
  return result;
}

// ────────────────────────────────────────────────────────────────────
// フル .novel 生成
// ────────────────────────────────────────────────────────────────────

export interface NovelExportCodexEntry {
  name: string;
  aliases: string[];
  /** codexEntries.content の ProseMirror JSON 文字列。 */
  contentJson: string;
  /** content が空のときのフォールバック（plain text）。 */
  summary: string;
}

export interface GenerateNovelExportInput {
  title: string;
  /** メモリ（長期記憶）セクションへ。 */
  outline: string;
  /** 脚注／システムメッセージセクションへ。 */
  aiInstructions: string;
  /** 表示順に並んだシーンの ProseMirror JSON 文字列。 */
  sceneDocs: string[];
  codexEntries: NovelExportCodexEntry[];
  resolveMentionName?: MentionNameResolver;
}

/**
 * フル .novel 文字列を生成する純関数。
 *
 * - 本文 = シーンを 1 空行区切りで結合し `<br>` 改行にエンコード
 * - キャラクターブック = name+aliases → タグ列、説明文 = `[...]` で wrap
 * - パラメータ/禁止ワード/作品ID/スクリプト/チャットテンプレートは空
 */
export function generateNovelExport(input: GenerateNovelExportInput): string {
  const ctx: NovelRenderCtx = { resolveMentionName: input.resolveMentionName };

  const bodyLines: string[] = [];
  for (const doc of input.sceneDocs) {
    const sceneLines = trimTrailingEmptyLines(pmDocToNovelLines(doc, ctx));
    if (sceneLines.length === 0) continue;
    if (bodyLines.length > 0) bodyLines.push("");
    appendLines(bodyLines, sceneLines);
  }
  const body = bodyLines.map(sanitizeNovelBodyLine).join("<br>");

  const charBook: NovelCharBookEntry[] = input.codexEntries
    .map((entry) => {
      const tags = [entry.name, ...entry.aliases]
        .map(sanitizeCharBookTag)
        .filter((t) => t.length > 0);
      const descLines = pmDocToNovelLines(entry.contentJson, ctx);
      const desc = descLines.length > 0 ? descLines.join("\n") : entry.summary;
      return { tags, content: wrapCharBookBrackets(sanitizeNovelText(desc)) };
    })
    .filter((e) => e.tags.length > 0);

  const novel: NovelFile = {
    body,
    memory: sanitizeNovelText(input.outline.trim()),
    footnote: sanitizeNovelText(input.aiInstructions.trim()),
    params: "",
    charBook,
    charBookRaw: "",
    bannedWords: "",
    title: sanitizeNovelText(input.title.trim()).replace(/\n+/g, " "),
    workId: "",
    script: "",
    chatTemplate: "",
    extraSections: [],
  };
  return buildNovelFile(novel);
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end);
}

/**
 * 説明文を AIのべりすとの慣習どおり `[...]` で囲む（既に囲まれていれば
 * 二重 wrap しない）。空文字は空のまま。
 */
function wrapCharBookBrackets(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return `[${trimmed}]`;
}
