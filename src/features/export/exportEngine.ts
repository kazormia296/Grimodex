/**
 * exportEngine.ts — エクスポートの中核ロジック
 *
 * 純粋関数として実装。DB/Storeアクセスなし。
 * テスト可能・再利用可能。
 */

import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import type {
  ExportSettings,
  RubyStyle,
  EmphasisDotsStyle,
  TateChuYokoExportStyle,
} from "./types";
import { defaultRubyStyle, defaultEmphasisDotsStyle } from "./types";
import { renderRubyText } from "./rubyFormats";
import {
  tateChuYokoRunAllowed,
  TATE_CHU_YOKO_RUN,
  type TateChuYokoPolicy,
} from "@/features/editor/tateChuYokoPolicy";

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
  const { format, folderHeadingStyle, folderHeadingFormat } = settings;

  if (format === "markdown") {
    const hashes = "#".repeat(depth + 1);
    return `${hashes} ${title}`;
  }

  if (format === "html") {
    const level = Math.min(depth + 1, 6);
    return `<h${level}>${escapeHtml(title)}</h${level}>`;
  }

  // plaintext
  if (folderHeadingFormat === "pixiv-chapter") {
    // pixiv 小説の章タグ。深さに関係なく [chapter:タイトル]。
    // pixivChapterNewpage が true なら章前に改ページマーカーを差し込む。
    const prefix = settings.pixivChapterNewpage ? "[newpage]\n" : "";
    return `${prefix}[chapter:${title}]`;
  }
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

/**
 * Resolve a codex/scene `@mention` node to the text that should appear in
 * exported / written-back output. Receives the entry id and the label baked
 * into the mention node at creation time; returns the display name.
 *
 * Default (no resolver supplied): the baked label is used verbatim. Callers
 * with codex-store access inject a resolver that returns the *current* entry
 * name (falling back to the label for deleted entries), so renames propagate
 * to export output and file-backed disk content — mirroring the live editor
 * display (Item A). Kept out of the pure engine via injection.
 */
export type MentionNameResolver = (id: string, fallbackLabel: string) => string;

interface RenderCtx {
  settings: ExportSettings;
  resolvedRuby: RubyStyle;
  resolvedEmphasis: EmphasisDotsStyle;
  /**
   * 明示的な縦中横マーク(TcyMark)を書き出す記法スタイル。auto の縦中横
   * (applyTateChuYoko / settings.tateChuYoko) とは独立: 明示マークはユーザ意図
   * なので policy 非依存で常に出力する。resolvedRuby/resolvedEmphasis と同じ
   * 「マーク専用の解決済みスタイル」。archive markdown は auto を "none" で切る
   * 一方で明示マークは失わないよう aozora-range で保存する。
   */
  resolvedTcy: TateChuYokoExportStyle;
  /**
   * html format 限定: 段落を実 `<p>` 要素で包み、hardBreak を `<br>` にする
   * （CSS 組版向け。Vivliostyle 連携が使う）。false（既定）は従来どおり
   * 素のテキスト行 — publish 出力（word-html/ao3 プリセット）の凍結挙動。
   */
  htmlParagraphs: boolean;
  /** Optional `@mention` → display-name resolver. See {@link MentionNameResolver}. */
  resolveMentionName?: MentionNameResolver;
  /**
   * Mirrors `editor.markdownStrictLineBreaks`. When true, the parser ignores
   * the GFM "single-newline = hardBreak" shortcut and only honours the
   * CommonMark hardBreak markers (`  \n` / `\\\n`). The exporter must match —
   * a bare `\n` would re-parse as a soft break and silently lose the node.
   */
  strictLineBreaks: boolean;
  /**
   * Which half-width digit runs count as 縦中横 (tate-chu-yoko) — mirrors the
   * editor's `editor.tateChuYoko` setting so export notation marks exactly the
   * runs the vertical editor preview would combine. Only consulted when
   * `settings.tateChuYoko !== "none"`. `"off"` suppresses all notation.
   */
  tateChuYokoPolicy: TateChuYokoPolicy;
}

/**
 * Join the markdown of a sequence of block-level nodes. Each child renderer
 * already terminates with a single `\n`, so joining with one more `\n` yields
 * the blank line CommonMark requires between paragraphs/headings/blockquotes/
 * lists. Joining with `""` collapses adjacent paragraphs into a single one
 * (soft-break joined) on the next parse, which loses paragraph structure.
 */
function renderBlockChildren(nodes: PMNode[], ctx: RenderCtx): string {
  return nodes
    .map((c) => renderNode(c, ctx))
    .filter((s) => s.length > 0)
    .join("\n");
}

function renderNode(node: PMNode, ctx: RenderCtx): string {
  switch (node.type) {
    case "doc":
      return renderBlockChildren(node.content ?? [], ctx);

    case "paragraph": {
      const inner = (node.content ?? [])
        .map((c) => renderNode(c, ctx))
        .join("");
      // Empty paragraph nodes carry "visible blank line" semantics — they
      // originate from `<p></p>` HTML blocks injected by
      // `normalizeImportedMarkdown` when the user wrote 2+ consecutive
      // blank lines. Round-trip them back as `<p></p>` so markdown-it
      // (html:true) preserves them on re-parse; emitting just `"\n"`
      // would let `renderBlockChildren`'s `"\n"`-join inflate them into
      // additional blank lines on every save (3 paragraphs → 4 blanks →
      // 4 paragraphs on the next read).
      //
      // Format-gated: only markdown needs the explicit marker — the markdown
      // round-trip (`renderPmDocToMarkdown` → `markdownToPmJson`, used by
      // `hashForDiskContent` and external-mount write-back) is the only path
      // where the doc is re-parsed and must reproduce the same node graph.
      // plaintext / html (publish-only output, no re-parse) keep the prior
      // behaviour (`"\n"` lets the doc-level `"\n"`-join surface a blank
      // line) so users don't see literal `<p></p>` in their `.txt` / `.html`
      // exports.
      if (inner === "") {
        if (ctx.settings.format === "markdown") return "<p></p>\n";
        if (ctx.settings.format === "html" && ctx.htmlParagraphs) {
          // 意図的な空行（連続空行由来の空段落）。CSS 組版では whitespace-only
          // 行は潰れるため、blank class 付き要素として高さを保持させる。
          return '<p class="blank"></p>\n';
        }
        return "\n";
      }
      if (ctx.settings.format === "html" && ctx.htmlParagraphs) {
        return `<p>${inner}</p>\n`;
      }
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
      // html format は本文を必ずエスケープする。従来の publish 用途（Word 貼付・
      // AO3）でも `<` を含む本文が構造を壊すのは誤りであり、Vivliostyle 連携では
      // 生成 HTML がヘッドレス Chromium で実行されるため、未エスケープの
      // <script> 焼き込みは原稿流出・ローカルファイル読取につながる（敵対
      // レビュー Critical）。エスケープは縦中横 wrap（<span> を差し込む）より
      // 前に行う — run は数字・記号のみでエスケープの影響を受けない。
      const rawText = node.text ?? "";
      const raw =
        ctx.settings.format === "html" ? escapeHtml(rawText) : rawText;
      const marks = node.marks ?? [];
      // 傍点(emphasisDots)が乗った run には縦中横記法を付けない。傍点も縦中横も
      // ［＃…］系の注記/囲みを出すため、両方適用すると注記がネストして青空文庫
      // として不正になる（例: 29［＃「29」は縦中横］［＃「29［＃…］」に傍点］）。
      // 傍点を優先し数字は素のまま残す（縦書きビューアが2桁を自動結合する）。
      const hasEmphasis = marks.some((m) => m.type === "emphasisDots");
      // 明示縦中横(TcyMark)は policy 非依存で常に記法を出す(resolvedTcy)。auto
      // (applyTateChuYoko)と同じく mark 装飾より先に raw を包む。text node の mark は
      // 一様なので run 単位で包める(別マークが一部に乗ると tcy run が複数 node に
      // 割れて複数記法になるが、その別マークが CSS の combine context も割るので
      // エディタ表示と一致する)。傍点が同居する run は傍点優先(注記ネスト回避)。
      const hasTcy = marks.some((m) => m.type === "tcy");
      const body = hasEmphasis
        ? raw
        : hasTcy
          ? wrapTateChuYoko(raw, ctx.resolvedTcy)
          : applyTateChuYoko(raw, ctx);
      return applyMarks(body, marks, ctx);
    }

    case "hardBreak":
      // Round-trip rule depends on the parser's `breaks` mode:
      //  - `breaks: true`  (Obsidian-default / GFM): bare `\n` already re-parses
      //    as a hardBreak — emit `\n` and keep disk content free of trailing
      //    spaces (cleaner diffs, less editor trimming friction).
      //  - `breaks: false` (CommonMark strict, opt-in): bare `\n` collapses to
      //    a soft break (space) on re-parse, permanently losing the node. Emit
      //    the spec hardBreak marker (`  \n`) so it round-trips.
      if (ctx.settings.format === "html" && ctx.htmlParagraphs) {
        // <p> 内の生 \n は whitespace として潰れるため実 <br> で出す。
        return "<br>";
      }
      return ctx.strictLineBreaks ? "  \n" : "\n";

    case "ruby": {
      // html format はルビの base/annotation もエスケープ（text と同じ理由）。
      const base = (node.attrs?.base as string) ?? "";
      const annotation = (node.attrs?.annotation as string) ?? "";
      if (ctx.settings.format === "html") {
        return renderRuby(
          escapeHtml(base),
          escapeHtml(annotation),
          ctx.resolvedRuby,
        );
      }
      return renderRuby(base, annotation, ctx.resolvedRuby);
    }

    case "mention": {
      // `@mention` is an inline atom: the display name lives in attrs (`label`),
      // never as a child text node — so without this case it falls through to
      // `default`, recurses into no children, and renders as "" (silent data
      // loss on every export and every file-backed write-back). Emit the bare
      // name (no `@`): prose reads naturally and, on the file-backed markdown
      // round-trip, the name survives as plain text (markdown has no mention
      // syntax). The matcher never sees this text — `getDocText`/`flatPmPos`
      // skip mention atoms — so Item C's prose rewrite cannot touch it.
      const id = (node.attrs?.id as string) ?? "";
      const label = (node.attrs?.label as string | undefined) ?? "";
      const fallback = label || id;
      const name = ctx.resolveMentionName
        ? ctx.resolveMentionName(id, fallback)
        : fallback;
      // html format はメンション名もエスケープ（text と同じ理由）。
      return ctx.settings.format === "html" ? escapeHtml(name) : name;
    }

    case "sceneBeat":
      // Beat はプロンプトメタデータ — Export 時は完全除去
      return "";

    case "generatedProseBlock":
      // 生成 prose は中身の段落だけを残す（unwrap）
      return renderBlockChildren(node.content ?? [], ctx);

    case "sceneBreak":
      return renderSceneBreak(ctx.settings);

    case "bulletList":
    case "orderedList":
      return renderList(node, ctx);

    case "listItem":
      // Fallback for listItem rendered outside renderList. Within renderList,
      // children are walked directly with prefix + indent applied per item.
      return renderBlockChildren(node.content ?? [], ctx);

    case "taskList":
      return renderList(node, ctx, true);

    case "taskItem": {
      // Fallback for taskItem rendered outside renderList(task). Indents
      // continuation lines by the list-marker width (2) — not the full
      // prefix width — so 4+ space indents don't trigger a code block.
      const checked = Boolean(node.attrs?.checked);
      const inner = renderBlockChildren(node.content ?? [], ctx).trimEnd();
      return listItemFormat(inner, `- [${checked ? "x" : " "}] `, "  ") + "\n";
    }

    case "blockquote": {
      const inner = renderBlockChildren(node.content ?? [], ctx).trimEnd();
      // Prefix every line with `> `; empty lines become `>` (CommonMark
      // requires the marker on blank quoted lines to keep the quote going).
      const quoted = inner
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
      return quoted + "\n";
    }

    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? "";
      const code = (node.content ?? []).map((c) => c.text ?? "").join("");
      if (ctx.settings.format === "html") {
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        return `<pre><code${cls}>${escapeHtml(code)}</code></pre>\n`;
      }
      return "```" + lang + "\n" + code + "\n```\n";
    }

    case "horizontalRule":
      // doc-level separator (`\n` between blocks) ensures the blank line CommonMark
      // needs to disambiguate `---` from a Setext H2 underline.
      return "---\n";

    case "image": {
      const src = (node.attrs?.src as string) ?? "";
      const alt = (node.attrs?.alt as string) ?? "";
      const title = node.attrs?.title as string | undefined;
      if (ctx.settings.format === "markdown") {
        return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
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

/**
 * Format a list item: first line gets `firstLine` (marker + optional task
 * decoration); subsequent non-empty lines indented by `indent` (matching the
 * LIST MARKER width, not the full prefix) so CommonMark keeps the continuation
 * inside the same list item. Empty lines stay empty so the blank-line-between-
 * paragraphs structure round-trips.
 *
 * For task items the indent is `"  "` (just `- `), not `"      "` (`- [ ] `):
 * a 4+ space indent triggers an indented code block on re-parse.
 */
function listItemFormat(
  inner: string,
  firstLine: string,
  indent: string,
): string {
  return inner
    .split("\n")
    .map((line, i) => {
      if (i === 0) return firstLine + line;
      if (line.length === 0) return "";
      return indent + line;
    })
    .join("\n");
}

function renderList(node: PMNode, ctx: RenderCtx, task = false): string {
  const ordered = node.type === "orderedList";
  // bulletList/orderedList carry a `tight` attribute from MarkdownTightLists
  // (true = `- a\n- b`, false = blank-line-separated loose list with possible
  // multi-paragraph items). TaskList doesn't carry it; default to tight.
  const tight = node.attrs?.tight !== false;
  const lines: string[] = [];
  let index = 1;
  for (const child of node.content ?? []) {
    let firstLine: string;
    let indent: string;
    if (task && child.type === "taskItem") {
      const checked = Boolean(child.attrs?.checked);
      firstLine = `- [${checked ? "x" : " "}] `;
      indent = "  "; // list marker width (`- `), not including `[x] ` decoration
    } else if (ordered) {
      firstLine = `${index}. `;
      indent = " ".repeat(firstLine.length);
      index += 1;
    } else {
      firstLine = "- ";
      indent = "  ";
    }
    const inner = renderBlockChildren(child.content ?? [], ctx).trimEnd();
    lines.push(listItemFormat(inner, firstLine, indent));
  }
  // Loose lists need a blank line between items so re-parse keeps multi-
  // paragraph children inside the right item (otherwise the next marker is
  // ambiguous with a continuation paragraph at the same indent).
  return lines.join(tight ? "\n" : "\n\n") + "\n";
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
        // Backslash MUST be escaped before pipe — otherwise a literal `\|`
        // becomes `\\|`, where `\\` consumes the backslash escape and `|`
        // splits the cell. Order matters; `g` flag on both is required.
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        // Table cells cannot contain a raw newline: a hardBreak (`  \n` / `\n`)
        // or a multi-paragraph cell would otherwise split the row / terminate
        // the table early on re-parse. Collapse trailing-space + newline into
        // an inline `<br>` (safe to run after the escapes — `<br>` has no
        // backslash or pipe).
        .replace(/ *\r?\n/g, "<br>"),
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
        else if (ctx.settings.format === "html")
          result = `<code>${result}</code>`;
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
  return renderRubyText(base, annotation, style);
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
    case "narou-emphasis-batch": {
      // |語《・・》 — 中黒は語のコードポイント長と一致させる
      const chars = [...text];
      return `|${text}《${"・".repeat(chars.length)}》`;
    }
    case "narou-emphasis-per-char":
      // |字《・》|字《・》 — 1文字ずつ分割
      return [...text].map((c) => `|${c}《・》`).join("");
  }
}

/**
 * 本文テキスト中の縦中横候補 run（半角数字・！？等の記号クラスタ・ローマ数字）に、
 * 投稿先サイトの縦中横記法を付与する。
 *
 * 対象 run は `ctx.tateChuYokoPolicy`（= editor.tateChuYoko 由来 off/2/all）で決まり、
 * エディタの縦書きプレビューが結合する run と一致する（判定は tateChuYokoRunAllowed に
 * 集約）。`settings.tateChuYoko === "none"` か policy が `"off"` のときは何もしない。
 *
 * 注意（per-text-node の限界）: text node 単位で適用するため、`20<b>26</b>` のように
 * mark 境界で割れた run は個別の run として扱う。実データではほぼ起きず、対象出力は
 * すべて plaintext なので実害は無い。エディタ装飾（TateChuYokoPlugin）は PM 位置整合の
 * ため flatten 経由で結合するが、エクスポートは位置制約が無いので単純化している。
 */
function applyTateChuYoko(text: string, ctx: RenderCtx): string {
  const style = ctx.settings.tateChuYoko ?? "none";
  if (style === "none") return text;
  const policy = ctx.tateChuYokoPolicy;
  if (policy === "off") return text;
  return text.replace(TATE_CHU_YOKO_RUN, (run) =>
    tateChuYokoRunAllowed(run, policy) ? wrapTateChuYoko(run, style) : run,
  );
}

/** 1 つの run を縦中横記法で包む（style ごとの書式）。 */
function wrapTateChuYoko(run: string, style: TateChuYokoExportStyle): string {
  switch (style) {
    case "aozora-forward":
      // 前方参照型: run の直後に「直前の同一文字列を縦中横」と注記する。
      return `${run}［＃「${run}」は縦中横］`;
    case "aozora-range":
      // 範囲指定型: ［＃縦中横］…［＃縦中横終わり］ で挟む。
      return `［＃縦中横］${run}［＃縦中横終わり］`;
    case "caita":
      return `[tatechuyoko]${run}[/tatechuyoko]`;
    case "html-span":
      // CSS 組版向け（.tcy { text-combine-upright: all }）。run は数字・記号・
      // ローマ数字のみ（TATE_CHU_YOKO_RUN）なので HTML エスケープ不要。
      return `<span class="tcy">${run}</span>`;
    case "none":
      return run;
    default: {
      // 既知 style を網羅。新 style 追加時はここで型エラーになる（exhaustive）。
      // 同時に、破損した永続ストアなど union 外の実行時値が来ても run を素通しし、
      // `undefined` 置換による本文の数字消失（fail-open データ破壊）を防ぐ。
      const _exhaustive: never = style;
      void _exhaustive;
      return run;
    }
  }
}

function renderSceneBreak(settings: ExportSettings): string {
  switch (settings.sceneBreakStyle) {
    case "asterisks":
      return "* * *\n";
    case "hr":
      return "---\n";
    case "blank":
      // doc-level join already inserts the blank-line separator between block
      // children; emit empty so the filter drops this node entirely.
      return "";
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

export interface ArchiveMarkdownOptions {
  rubyStyle?: RubyStyle;
  emphasisDotsStyle?: EmphasisDotsStyle;
  /**
   * Must match the parser's `breaks` setting (see `RenderCtx.strictLineBreaks`).
   *
   * Caller policy:
   *  - `pmJsonToMarkdown` (file-backed write-back) — reads
   *    `editor.markdownStrictLineBreaks` and passes it through; the parser
   *    on the same machine uses the same setting, so round-trip is faithful.
   *  - zipExport (`sceneSerializer`, `codexSerializer`) — pins `true`. The
   *    archive may be re-imported by a different Grimodex instance via
   *    `importApi → markdownToPmJson`; emitting the spec hardBreak marker
   *    (`  \n`) survives the receiver's `editor.markdownStrictLineBreaks`
   *    setting in either direction.
   *  - generateExport (publish path, markdown/html/plaintext) — leaves it
   *    false. Output is one-way for user consumption (Obsidian, GitHub,
   *    投稿サイト); cross-mode re-import via importApi is not the canonical
   *    flow, and diff-friendly bare `\n` is preferred for the publish format.
   */
  strictLineBreaks?: boolean;
  /** Optional `@mention` → display-name resolver. See {@link MentionNameResolver}. */
  resolveMentionName?: MentionNameResolver;
}

/** ProseMirror JSON document → GFM markdown (pure, for file-backed scenes). */
export function renderPmDocToMarkdown(
  contentJson: string,
  options: ArchiveMarkdownOptions = {},
): string {
  return renderPmDocToArchiveMarkdown(contentJson, options);
}

/** Archive-oriented markdown: plain ruby/emphasis formats, no HTML. */
export function renderPmDocToArchiveMarkdown(
  contentJson: string,
  options: ArchiveMarkdownOptions = {},
): string {
  const rubyStyle = options.rubyStyle ?? "parentheses";
  const emphasisDotsStyle = options.emphasisDotsStyle ?? "double-angle";
  const ctx: RenderCtx = {
    settings: {
      format: "markdown",
      folderHeading: false,
      folderHeadingStyle: "numbers",
      folderHeadingFormat: "standard",
      sceneTitle: "none",
      sceneDivider: "none",
      sceneBreakStyle: "hr",
      sceneBreakCustom: "",
      sceneDividerCustom: "",
      rubyStyle,
      emphasisDotsStyle,
      includeTrashBin: false,
      pixivChapterNewpage: false,
      narouEmphasisMode: "batch",
      // archive markdown は生の数字を保持する（サイト記法は焼き込まない）。
      tateChuYoko: "none",
      exportPresetId: "custom",
    },
    resolvedRuby: rubyStyle,
    resolvedEmphasis: emphasisDotsStyle,
    // auto の縦中横は "none" で焼き込まない一方、明示マーク(TcyMark)はユーザ意図
    // なので aozora-range で保存する (ruby=括弧 / 傍点=《《》》 と同じく記法として残す。
    // file-backed 再取り込みでマークには戻らないが記法テキストとして復元可能)。
    resolvedTcy: "aozora-range",
    htmlParagraphs: false,
    strictLineBreaks: options.strictLineBreaks ?? false,
    tateChuYokoPolicy: "2",
    resolveMentionName: options.resolveMentionName,
  };
  return renderSceneContent(contentJson, ctx).trimEnd() + "\n";
}

function htmlToPlainText(html: string): string {
  if (typeof DOMParser !== "undefined") {
    return (
      new DOMParser().parseFromString(html, "text/html").body.textContent ??
      html
    );
  }
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DB 本文 → archive 用 Markdown。
 * シーン/Codex は ProseMirror JSON。スニペットはプレーンテキストや HTML もあり得る。
 */
export function renderArchiveBodyFromDb(
  raw: string | null | undefined,
  options: ArchiveMarkdownOptions = {},
): string {
  if (raw == null || raw === "") return "\n";
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "{}") return "\n";

  if (trimmed.startsWith("{")) {
    return renderPmDocToArchiveMarkdown(raw, options);
  }

  const body = trimmed.startsWith("<") ? htmlToPlainText(raw) : raw;
  return body.trimEnd() + "\n";
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
  /**
   * Which half-width digit runs count as 縦中横, from `editor.tateChuYoko`
   * (off/2/all). Defaults to `"2"` (editor default) when omitted. Only matters
   * when `settings.tateChuYoko !== "none"`.
   */
  tateChuYokoPolicy?: TateChuYokoPolicy;
  /** Optional `@mention` → display-name resolver. See {@link MentionNameResolver}. */
  resolveMentionName?: MentionNameResolver;
  /**
   * html format 限定: 文書シェル（doctype/head/body）を差し替える。
   * 未指定なら従来の `wrapHtml`（インライン style）— publish 出力の凍結挙動。
   * Vivliostyle 連携は theme.css への `<link>` を持つ自前シェルを渡す。
   */
  htmlWrapper?: (body: string, title: string, lang: string) => string;
  /** html format 限定: 段落を実 `<p>` で包む。{@link RenderCtx.htmlParagraphs} 参照。 */
  htmlParagraphs?: boolean;
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
    tateChuYokoPolicy = "2",
    resolveMentionName,
    htmlWrapper,
    htmlParagraphs = false,
  } = input;

  const resolvedRuby: RubyStyle =
    settings.rubyStyle ?? defaultRubyStyle(settings.format);
  const resolvedEmphasis: EmphasisDotsStyle =
    settings.emphasisDotsStyle ?? defaultEmphasisDotsStyle(settings.format);
  // 明示縦中横マークは publish 出力ではユーザの site スタイルに合わせる
  // (auto と同じ settings.tateChuYoko。"none" 選択時は明示マークも出さない)。
  const resolvedTcy: TateChuYokoExportStyle = settings.tateChuYoko ?? "none";

  // generateExport is the user-facing publish path (markdown/html/plaintext).
  // Leaves strictLineBreaks=false for diff-friendly bare `\n` output. The
  // cross-mode hardBreak risk is handled at the archive boundary by zipExport
  // (which always emits `  \n`); publish output is one-way and not expected
  // to round-trip back through importApi. See ArchiveMarkdownOptions docs.
  const ctx: RenderCtx = {
    settings,
    resolvedRuby,
    resolvedEmphasis,
    resolvedTcy,
    htmlParagraphs,
    strictLineBreaks: false,
    tateChuYokoPolicy,
    resolveMentionName,
  };

  // フラットなブロック列を構築
  const blocks = buildBlocks(nodes, checkedIds, null, 0);
  if (blocks.length === 0) return "";

  // 「synthetic-echo」抑制用の事前集計。
  // import 側 (markdownParser.parseMarkdownSingle) は `## chapter\n\nbody` のような
  // chapter 直下に body しか無い入力に対して、本文救済のため chapter と同名の
  // synthetic scene を作る。既定 export (folderHeading=true, sceneTitle="heading")
  // をそのまま流すと `## chapter\n### chapter\nbody` のように見出しが重複し、
  // 入力と構造が一致しなくなる。
  //
  // 抑制条件 (全部満たすときのみ scene 見出しを omit):
  //  1. settings.folderHeading=true  — chapter heading が実際に出力される
  //     (false のときに抑制すると title が完全に消える)
  //  2. parent folder の直接子 (checked) scene が 1 件のみ
  //     (兄弟がいるなら区別できなくなる)
  //  3. その唯一の scene の title が parent folder の title と一致
  //
  // ユーザーが意図的に同名にしていた場合も、出力 → 再 import で
  // 「folder + synthetic scene of same name」に戻るので idempotent。
  const nodeById = new Map<string, TreeNodeData>(nodes.map((n) => [n.id, n]));
  const checkedScenesByFolder = new Map<string, number>();
  for (const n of nodes) {
    if (n.nodeType !== "scene") continue;
    if (!checkedIds.has(n.id)) continue;
    if (!n.parentId) continue;
    checkedScenesByFolder.set(
      n.parentId,
      (checkedScenesByFolder.get(n.parentId) ?? 0) + 1,
    );
  }
  function isSyntheticEcho(sceneNode: TreeNodeData): boolean {
    if (!settings.folderHeading) return false;
    if (!sceneNode.parentId) return false;
    const parent = nodeById.get(sceneNode.parentId);
    if (parent?.nodeType !== "folder") return false;
    if ((checkedScenesByFolder.get(parent.id) ?? 0) !== 1) return false;
    return parent.title === sceneNode.title;
  }

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
      const suppressTitle = isSyntheticEcho(block.node);
      const titleText =
        settings.sceneTitle !== "none" && !suppressTitle
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
    return (htmlWrapper ?? wrapHtml)(result, projectTitle, projectLanguage);
  }

  return result;
}
