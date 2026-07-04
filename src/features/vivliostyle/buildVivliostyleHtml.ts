import { generateExport } from "@/features/export/exportEngine";
import type {
  GenerateExportInput,
  MentionNameResolver,
} from "@/features/export/exportEngine";
import { DEFAULT_EXPORT_SETTINGS } from "@/features/export/types";
import type { ExportSettings } from "@/features/export/types";
import type { TateChuYokoPolicy } from "@/features/editor/tateChuYokoPolicy";
import type { TreeNodeData } from "@/features/tree/treeStore";

// ────────────────────────────────────────────────────────────────────
// Vivliostyle CLI に渡す組版用 HTML の生成。
//
// 投稿サイト向け publish（ExportDialog / rubyProfiles）とは独立した固定
// 設定で generateExport を呼ぶ薄いラッパー。rubyProfiles の SITE_ENTRIES
// には登録しない（vivliostyle は投稿先ではなく組版。凍結レジストリ不可侵）。
// ────────────────────────────────────────────────────────────────────

/** 生成 HTML が参照するテーマ CSS のファイル名（Rust 側 temp dir に同名で書く）。 */
export const VIVLIOSTYLE_THEME_FILENAME = "theme.css";

/** 生成 HTML 本体のファイル名。 */
export const VIVLIOSTYLE_HTML_FILENAME = "book.html";

/**
 * Vivliostyle 向け固定 ExportSettings。
 *
 * - ルビ/傍点/縦中横はすべて HTML + class で出し、組版表現は theme.css に委ねる
 * - シーン区切りは custom で実 HTML を注入（renderSceneBreak/getSceneDivider は
 *   custom 値を素通しするため、エンジン改造なしで <p class="scene-break"> を出せる）
 * - sceneTitle は none（小説の慣行。章見出し = フォルダーのみ）
 */
const VIVLIOSTYLE_EXPORT_SETTINGS: ExportSettings = {
  ...DEFAULT_EXPORT_SETTINGS,
  format: "html",
  folderHeading: true,
  folderHeadingStyle: "numbers",
  folderHeadingFormat: "standard",
  sceneTitle: "none",
  sceneDivider: "custom",
  sceneDividerCustom: '<p class="scene-break">＊　＊　＊</p>',
  sceneBreakStyle: "custom",
  sceneBreakCustom: '<p class="scene-break">＊　＊　＊</p>',
  rubyStyle: "html",
  emphasisDotsStyle: "html",
  tateChuYoko: "html-span",
  exportPresetId: "custom",
};

export interface BuildVivliostyleHtmlInput {
  nodes: TreeNodeData[];
  /** sceneId → ProseMirror JSON 文字列 */
  contentMap: Record<string, string>;
  checkedIds: Set<string>;
  projectTitle: string;
  projectLanguage: string;
  tateChuYokoPolicy?: TateChuYokoPolicy;
  resolveMentionName?: MentionNameResolver;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Vivliostyle 用文書シェル。theme.css は同ディレクトリに置かれる前提の相対参照。
 * <title> は @page の柱（env(doc-title)）にも流用される。
 */
function wrapVivliostyleHtml(
  body: string,
  title: string,
  lang: string,
): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${VIVLIOSTYLE_THEME_FILENAME}">
</head>
<body>
${body}
</body>
</html>
`;
}

/** Vivliostyle CLI に渡す組版用 HTML（完全な文書）を生成する純粋関数。 */
export function buildVivliostyleHtml(input: BuildVivliostyleHtmlInput): string {
  const exportInput: GenerateExportInput = {
    nodes: input.nodes,
    contentMap: input.contentMap,
    checkedIds: input.checkedIds,
    settings: VIVLIOSTYLE_EXPORT_SETTINGS,
    projectTitle: input.projectTitle,
    projectLanguage: input.projectLanguage,
    tateChuYokoPolicy: input.tateChuYokoPolicy,
    resolveMentionName: input.resolveMentionName,
    htmlWrapper: wrapVivliostyleHtml,
    htmlParagraphs: true,
  };
  return generateExport(exportInput);
}
