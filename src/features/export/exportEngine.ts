/**
 * exportEngine.ts — エクスポートの中核ロジック
 *
 * 純粋関数として実装。DB/Storeアクセスなし。
 * テスト可能・再利用可能。
 */

import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { ExportSettings, RubyStyle, EmphasisDotsStyle } from "./types";
import { defaultRubyStyle, defaultEmphasisDotsStyle } from "./types";

// ────────────────────────────────────────────────────────────────────
// ProseMirror JSON 型
// ────────────────────────────────────────────────────────────────────

interface PMNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: PMMark[];
  content?: PMNode[];
}

interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────
// ツリー内部表現
// ────────────────────────────────────────────────────────────────────

type ExportBlock =
  | { kind: "folder"; node: TreeNodeData; depth: number }
  | { kind: "scene"; node: TreeNodeData; folderDepth: number };

/**
 * ノードリストをフラットな「エクスポートブロック」列に変換する。
 * - Note は除外
 * - チェック済みシーンを持たないフォルダーは除外
 */
function buildBlocks(
  nodes: TreeNodeData[],
  checkedIds: Set<string>,
  parentId: string | null,
  depth: number,
): ExportBlock[] {
  const children = nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  const result: ExportBlock[] = [];
  for (const node of children) {
    if (node.nodeType === "note") continue;

    if (node.nodeType === "folder") {
      const sub = buildBlocks(nodes, checkedIds, node.id, depth + 1);
      if (sub.length === 0) continue; // チェック済みシーンなし → スキップ
      result.push({ kind: "folder", node, depth });
      result.push(...sub);
    } else if (node.nodeType === "scene") {
      if (!checkedIds.has(node.id)) continue;
      result.push({ kind: "scene", node, folderDepth: depth });
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// フォルダー見出しのレンダリング
// ────────────────────────────────────────────────────────────────────

function renderFolderHeading(
  title: string,
  depth: number,
  settings: ExportSettings,
): string {
  const { format, folderHeadingStyle } = settings;

  if (format === "markdown") {
    const hashes = "#".repeat(depth + 1);
    return `${hashes} ${title}`;
  }

  if (format === "html") {
    const level = Math.min(depth + 1, 6);
    return `<h${level}>${escapeHtml(title)}</h${level}>`;
  }

  // plaintext
  if (folderHeadingStyle === "squares") {
    const symbol =
      depth === 0 ? "■" : depth === 1 ? "□" : depth === 2 ? "◇" : "・";
    return `${symbol} ${title}`;
  }
  if (folderHeadingStyle === "brackets") {
    const [open, close] =
      depth === 0 ? ["【", "】"] : depth === 1 ? ["〈", "〉"] : ["「", "」"];
    return `${open}${title}${close}`;
  }
  // numbers: 記号なし
  return title;
}

// ────────────────────────────────────────────────────────────────────
// シーンタイトルのレンダリング
// ────────────────────────────────────────────────────────────────────

function renderSceneTitle(
  title: string,
  folderDepth: number,
  settings: ExportSettings,
): string {
  const { format, sceneTitle } = settings;
  if (sceneTitle === "none") return "";

  if (sceneTitle === "heading") {
    const depth = folderDepth; // フォルダー最深+1 → シーン見出しレベル = folderDepth+1
    if (format === "markdown") {
      const hashes = "#".repeat(depth + 1);
      return `${hashes} ${title}\n`;
    }
    if (format === "html") {
      const level = Math.min(depth + 1, 6);
      return `<h${level}>${escapeHtml(title)}</h${level}>\n`;
    }
    // plaintext: そのまま
    return `${title}\n`;
  }

  if (sceneTitle === "bold") {
    if (format === "markdown") return `**${title}**\n`;
    if (format === "html") return `<strong>${escapeHtml(title)}</strong>\n`;
    return `${title}\n`;
  }

  // plain
  return `${title}\n`;
}

// ────────────────────────────────────────────────────────────────────
// ProseMirror JSON → テキスト変換
// ────────────────────────────────────────────────────────────────────

interface RenderCtx {
  settings: ExportSettings;
  resolvedRuby: RubyStyle;
  resolvedEmphasis: EmphasisDotsStyle;
}

function renderNode(node: PMNode, ctx: RenderCtx): string {
  switch (node.type) {
    case "doc":
      return (node.content ?? []).map((c) => renderNode(c, ctx)).join("");

    case "paragraph": {
      const inner = (node.content ?? [])
        .map((c) => renderNode(c, ctx))
        .join("");
      return inner + "\n";
    }

    case "heading": {
      const inner = (node.content ?? [])
        .map((c) => renderNode(c, ctx))
        .join("");
      const level = (node.attrs?.level as number) ?? 1;
      if (ctx.settings.format === "markdown") {
        return "#".repeat(level) + " " + inner + "\n";
      }
      if (ctx.settings.format === "html") {
        return `<h${level}>${inner}</h${level}>\n`;
      }
      return inner + "\n";
    }

    case "text": {
      const raw = node.text ?? "";
      return applyMarks(raw, node.marks ?? [], ctx);
    }

    case "ruby":
      return renderRuby(
        (node.attrs?.base as string) ?? "",
        (node.attrs?.annotation as string) ?? "",
        ctx.resolvedRuby,
      );

    case "sceneBeat":
      // Beat はプロンプトメタデータ — Export 時は完全除去
      return "";

    case "generatedProseBlock":
      // 生成 prose は中身の段落だけを残す（unwrap）
      return (node.content ?? []).map((c) => renderNode(c, ctx)).join("");

    case "sceneBreak":
      return renderSceneBreak(ctx.settings);

    case "bulletList":
    case "orderedList":
      return renderList(node, ctx);

    case "listItem":
      return (node.content ?? []).map((c) => renderNode(c, ctx)).join("");

    case "taskList":
      return renderList(node, ctx, true);

    case "taskItem": {
      const checked = Boolean(node.attrs?.checked);
      const inner = (node.content ?? [])
        .map((c) => renderNode(c, ctx))
        .join("")
        .trimEnd();
      return `- [${checked ? "x" : " "}] ${inner}\n`;
    }

    case "blockquote": {
      const inner = (node.content ?? [])
        .map((c) => renderNode(c, ctx))
        .join("")
        .trimEnd()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return inner + "\n";
    }

    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? "";
      const code = (node.content ?? [])
        .map((c) => c.text ?? "")
        .join("");
      return "```" + lang + "\n" + code + "\n```\n";
    }

    case "horizontalRule":
      return "---\n";

    case "image": {
      const src = (node.attrs?.src as string) ?? "";
      const alt = (node.attrs?.alt as string) ?? "";
      const title = node.attrs?.title as string | undefined;
      if (ctx.settings.format === "markdown") {
        return title
          ? `![${alt}](${src} "${title}")`
          : `![${alt}](${src})`;
      }
      return "";
    }

    case "table":
      return renderTable(node, ctx);

    case "tableRow":
    case "tableHeader":
    case "tableCell":
      return (node.content ?? []).map((c) => renderNode(c, ctx)).join("");

    default:
      // 未知ノードは子要素を再帰
      return (node.content ?? []).map((c) => renderNode(c, ctx)).join("");
  }
}

function renderList(node: PMNode, ctx: RenderCtx, task = false): string {
  const ordered = node.type === "orderedList";
  let index = 1;
  const lines: string[] = [];
  for (const child of node.content ?? []) {
    const inner = (child.content ?? [])
      .map((c) => renderNode(c, ctx))
      .join("")
      .trimEnd();
    if (task && child.type === "taskItem") {
      lines.push(renderNode(child, ctx).trimEnd());
    } else {
      const prefix = ordered ? `${index}. ` : "- ";
      lines.push(
        prefix +
          inner
            .split("\n")
            .filter(Boolean)
            .join("\n"),
      );
      index += 1;
    }
  }
  return lines.join("\n") + "\n";
}

function renderTable(node: PMNode, ctx: RenderCtx): string {
  if (ctx.settings.format !== "markdown") return "";
  const rows = node.content ?? [];
  if (rows.length === 0) return "";
  const rendered = rows.map((row) => {
    const cells = (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((c) => renderNode(c, ctx))
        .join("")
        .trim()
        .replace(/\|/g, "\\|"),
    );
    return `| ${cells.join(" | ")} |`;
  });
  if (rendered.length >= 1) {
    const colCount = (rows[0].content ?? []).length;
    const sep = `| ${Array(colCount).fill("---").join(" | ")} |`;
    rendered.splice(1, 0, sep);
  }
  return rendered.join("\n") + "\n";
}

function applyMarks(text: string, marks: PMMark[], ctx: RenderCtx): string {
  let result = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "emphasisDots":
        result = renderEmphasisDots(result, ctx.resolvedEmphasis);
        break;
      case "bold":
        if (ctx.settings.format === "markdown") result = `**${result}**`;
        else if (ctx.settings.format === "html")
          result = `<strong>${result}</strong>`;
        break;
      case "italic":
        if (ctx.settings.format === "markdown") result = `*${result}*`;
        else if (ctx.settings.format === "html") result = `<em>${result}</em>`;
        break;
      case "strike":
        if (ctx.settings.format === "markdown") result = `~~${result}~~`;
        else if (ctx.settings.format === "html") result = `<s>${result}</s>`;
        break;
      case "code":
        if (ctx.settings.format === "markdown") result = `\`${result}\``;
        else if (ctx.settings.format === "html") result = `<code>${result}</code>`;
        break;
      case "link": {
        const href = (mark.attrs?.href as string) ?? "";
        if (ctx.settings.format === "markdown") {
          result = `[${result}](${href})`;
        } else if (ctx.settings.format === "html") {
          result = `<a href="${escapeHtml(href)}">${result}</a>`;
        }
        break;
      }
      // その他のマークは無視（テキストはそのまま）
    }
  }
  return result;
}

function renderRuby(
  base: string,
  annotation: string,
  style: RubyStyle,
): string {
  switch (style) {
    case "html":
      return `<ruby>${base}<rp>(</rp><rt>${annotation}</rt><rp>)</rp></ruby>`;
    case "parentheses":
      return `${base}(${annotation})`;
    case "aozora":
      return `｜${base}《${annotation}》`;
    case "base":
      return base;
  }
}

function renderEmphasisDots(text: string, style: EmphasisDotsStyle): string {
  switch (style) {
    case "html":
      return `<span class="emphasis-dots">${text}</span>`;
    case "aozora":
      return `${text}［＃「${text}」に傍点］`;
    case "double-angle":
      return `《《${text}》》`;
    case "plain":
      return text;
  }
}

function renderSceneBreak(settings: ExportSettings): string {
  switch (settings.sceneBreakStyle) {
    case "asterisks":
      return "* * *\n";
    case "hr":
      return "---\n";
    case "blank":
      return "\n";
    case "custom":
      return (settings.sceneBreakCustom || "* * *") + "\n";
  }
}

function renderSceneContent(
  contentJson: string | undefined,
  ctx: RenderCtx,
): string {
  if (!contentJson || contentJson === "{}") return "\n";
  try {
    const doc = JSON.parse(contentJson) as PMNode;
    return renderNode(doc, ctx);
  } catch {
    return "\n";
  }
}

/** ProseMirror JSON document → GFM markdown (pure, for file-backed scenes). */
export function renderPmDocToMarkdown(contentJson: string): string {
  const ctx: RenderCtx = {
    settings: {
      format: "markdown",
      folderHeading: false,
      folderHeadingStyle: "numbers",
      sceneTitle: "none",
      sceneDivider: "none",
      sceneBreakStyle: "hr",
      sceneBreakCustom: "",
      sceneDividerCustom: "",
      rubyStyle: "base",
      emphasisDotsStyle: "plain",
      includeTrashBin: false,
    },
    resolvedRuby: "base",
    resolvedEmphasis: "plain",
  };
  return renderSceneContent(contentJson, ctx).trimEnd() + "\n";
}

// ────────────────────────────────────────────────────────────────────
// シーン区切りのレンダリング
// ────────────────────────────────────────────────────────────────────

function getSceneDivider(settings: ExportSettings): string {
  switch (settings.sceneDivider) {
    case "blank":
      return "\n";
    case "blank2":
      return "\n\n";
    case "asterisks":
      return "\n* * *\n\n";
    case "hr":
      return "\n---\n\n";
    case "rule":
      return "\n────────\n\n";
    case "none":
      return "";
    case "custom":
      return `\n${settings.sceneDividerCustom}\n\n`;
  }
}

// ────────────────────────────────────────────────────────────────────
// HTML ラッパー
// ────────────────────────────────────────────────────────────────────

function wrapHtml(body: string, title: string, lang: string): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { max-width: 40em; margin: 2em auto; font-family: serif; line-height: 1.8; }
    .emphasis-dots { text-emphasis: sesame; -webkit-text-emphasis: sesame; }
    .scene-break { text-align: center; margin: 2em 0; }
    rt { font-size: 0.5em; }
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ────────────────────────────────────────────────────────────────────
// 公開 API
// ────────────────────────────────────────────────────────────────────

export interface GenerateExportInput {
  nodes: TreeNodeData[];
  /** sceneId → ProseMirror JSON 文字列 */
  contentMap: Record<string, string>;
  checkedIds: Set<string>;
  settings: ExportSettings;
  projectTitle?: string;
  projectLanguage?: string;
}

/**
 * エクスポート文字列を生成する純粋関数。
 * DB/Store アクセスなし。すべての入力を引数で受け取る。
 */
export function generateExport(input: GenerateExportInput): string {
  const {
    nodes,
    contentMap,
    checkedIds,
    settings,
    projectTitle = "Untitled",
    projectLanguage = "ja",
  } = input;

  const resolvedRuby: RubyStyle =
    settings.rubyStyle ?? defaultRubyStyle(settings.format);
  const resolvedEmphasis: EmphasisDotsStyle =
    settings.emphasisDotsStyle ?? defaultEmphasisDotsStyle(settings.format);

  const ctx: RenderCtx = { settings, resolvedRuby, resolvedEmphasis };

  // フラットなブロック列を構築
  const blocks = buildBlocks(nodes, checkedIds, null, 0);
  if (blocks.length === 0) return "";

  // ブロックを結合
  const parts: string[] = [];
  let prevKind: "folder" | "scene" | null = null;

  for (const block of blocks) {
    if (block.kind === "folder") {
      if (!settings.folderHeading) {
        // folderHeading=false: フォルダーブロック自体をスキップ
        // ただしprevKindはリセットしない（区切り計算のため）
        continue;
      }
      const heading = renderFolderHeading(
        block.node.title,
        block.depth,
        settings,
      );
      if (parts.length === 0) {
        parts.push(heading);
      } else {
        parts.push("\n\n" + heading);
      }
      prevKind = "folder";
    } else {
      // scene
      const titleText =
        settings.sceneTitle !== "none"
          ? renderSceneTitle(block.node.title, block.folderDepth, settings)
          : "";
      const content = renderSceneContent(contentMap[block.node.id], ctx);

      if (prevKind === "scene") {
        // シーン→シーン: 区切りを挿入
        const divider = getSceneDivider(settings);
        parts.push(divider + titleText + content);
      } else if (prevKind === "folder") {
        // フォルダー見出し→シーン: 空行を入れる
        parts.push("\n\n" + titleText + content);
      } else {
        // 最初のシーン
        parts.push(titleText + content);
      }
      prevKind = "scene";
    }
  }

  let result = parts.join("");

  // 末尾に改行を1つ付加（すでに content が \n で終わる場合はそのまま）
  // result が空（Beat のみのシーンなど）のときは何もしない
  if (result && !result.endsWith("\n")) {
    result += "\n";
  }

  if (settings.format === "html") {
    return wrapHtml(result, projectTitle, projectLanguage);
  }

  return result;
}
