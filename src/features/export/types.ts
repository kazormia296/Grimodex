/** エクスポート出力形式 */
export type ExportFormat = "markdown" | "plaintext" | "html";

/** フォルダー見出し記号スタイル（プレーンテキスト時のみ有効） */
export type FolderHeadingStyle = "squares" | "brackets" | "numbers";

/** フォルダー見出しのテキストフォーマット
 *  - standard: `folderHeadingStyle` の慣習どおり
 *  - pixiv-chapter: `[chapter:タイトル]` （pixiv 小説向け）
 */
export type FolderHeadingFormat = "standard" | "pixiv-chapter";

/** シーン間区切り */
export type SceneDivider =
  | "blank"
  | "blank2"
  | "asterisks"
  | "hr"
  | "rule"
  | "none"
  | "custom";

/** シーンタイトル出力スタイル */
export type SceneTitleStyle = "none" | "heading" | "bold" | "plain";

/** ルビ出力スタイル */
export type RubyStyle =
  | "html"
  | "parentheses"
  | "aozora"
  | "aozora-auto"
  | "narou-parens"
  | "hash-underscore"
  | "rb-bracket"
  | "mediawiki"
  | "wikiwiki"
  | "denden"
  | "denden-chars"
  | "renpy"
  | "game-engine"
  | "base";

/** 傍点出力スタイル */
export type EmphasisDotsStyle =
  | "html"
  | "aozora"
  | "double-angle"
  | "plain"
  | "narou-emphasis-batch"
  | "narou-emphasis-per-char";

/**
 * 縦中横（tate-chu-yoko）の記法出力スタイル。
 *
 * 本文中の「縦中横とみなす数字 run」（length ポリシーは editor.tateChuYoko 由来）を、
 * 投稿先サイトの記法で書き出すかを決める。
 *
 *  - `none`           : 記法を出さず半角数字をそのまま残す。多くの縦書きビューアは
 *                       半角2桁を自動で縦中横に組むので、書き手は数字を打つだけで足りる
 *                       （= jp-double-angle 系など大半のサイトの既定）。
 *  - `aozora-forward` : 青空文庫・前方参照型。`29［＃「29」は縦中横］` のように、
 *                       run の直後に「直前の同一文字列を縦中横」と注記する。
 *                       対象が短く明確なとき向き＝青空文庫プロファイルの既定。
 *  - `aozora-range`   : 青空文庫・範囲指定型。`［＃縦中横］29［＃縦中横終わり］` で挟む。
 *                       対象が長い・外字を含むなど前方参照で曖昧なとき向き。
 *  - `caita`          : caita の `[tatechuyoko]29[/tatechuyoko]` 記法。
 */
export type TateChuYokoExportStyle =
  | "none"
  | "aozora-forward"
  | "aozora-range"
  | "caita";

/** なろう傍点モード（UI トグル用、emphasisDotsStyle と連動） */
export type NarouEmphasisMode = "batch" | "per-char";

/** シーンブレイク出力スタイル */
export type SceneBreakStyle = "asterisks" | "hr" | "blank" | "custom";

/** 投稿サイト別ビルトインプリセット ID */
export type ExportPresetId =
  | "custom"
  // ── jp-double-angle 系統 ──
  | "narou"
  | "kakuyomu"
  | "alphapolis"
  | "pixiv"
  | "hameln"
  | "novelup"
  | "novelism"
  | "solispia"
  | "estar"
  | "aipen"
  | "sutekibungei"
  | "caita"
  | "noveland"
  // ── jp-ruby-emphasis 系統 ──
  | "noveldays"
  | "noichigo"
  | "maho"
  // ── 単独系統 ──
  | "aozora"
  | "monogatary"
  | "generic-md"
  | "word-html"
  // ── 英語圏向け ──
  | "web-fiction"
  | "ao3";

export interface ExportSettings {
  format: ExportFormat;
  /** フォルダー名を見出しとして出力するか */
  folderHeading: boolean;
  /** プレーンテキスト時の見出し記号スタイル */
  folderHeadingStyle: FolderHeadingStyle;
  /** フォルダー見出しのテキストフォーマット（pixiv 等のサイト特化） */
  folderHeadingFormat: FolderHeadingFormat;
  /** シーン間の区切り種別 */
  sceneDivider: SceneDivider;
  /** カスタム区切り文字（sceneDivider === "custom" 時のみ使用） */
  sceneDividerCustom: string;
  /** シーンタイトルの出力スタイル */
  sceneTitle: SceneTitleStyle;
  /** ルビ出力スタイル（null = 出力形式に応じた自動選択） */
  rubyStyle: RubyStyle | null;
  /** 傍点出力スタイル（null = 出力形式に応じた自動選択） */
  emphasisDotsStyle: EmphasisDotsStyle | null;
  /** 本文中シーンブレイク（SceneBreakNode）の出力スタイル */
  sceneBreakStyle: SceneBreakStyle;
  /** カスタムシーンブレイク文字列 */
  sceneBreakCustom: string;
  /** ゴミ箱の中身を export に含める (設計書 §3.5)。デフォルト false。 */
  includeTrashBin: boolean;
  /** pixiv: 章見出しの前に [newpage] を挿入する */
  pixivChapterNewpage: boolean;
  /** なろう傍点モード（UI トグル用、emphasisDotsStyle の narou 系と連動） */
  narouEmphasisMode: NarouEmphasisMode;
  /** 縦中横の記法出力スタイル（"none" = 記法を出さず半角数字のまま） */
  tateChuYoko: TateChuYokoExportStyle;
  /** 現在選択中のプリセット ID（手動変更で "custom" にフォールバック） */
  exportPresetId: ExportPresetId;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: "plaintext",
  folderHeading: true,
  folderHeadingStyle: "squares",
  folderHeadingFormat: "standard",
  sceneDivider: "blank",
  sceneDividerCustom: "",
  sceneTitle: "none",
  rubyStyle: null,
  emphasisDotsStyle: null,
  sceneBreakStyle: "asterisks",
  sceneBreakCustom: "",
  includeTrashBin: false,
  pixivChapterNewpage: false,
  narouEmphasisMode: "batch",
  tateChuYoko: "none",
  exportPresetId: "custom",
};

/** settings テーブルのキー定数 */
export const EXPORT_SETTING_KEYS = {
  format: "export.format",
  folderHeading: "export.folderHeading",
  folderHeadingStyle: "export.folderHeadingStyle",
  folderHeadingFormat: "export.folderHeadingFormat",
  sceneDivider: "export.sceneDivider",
  sceneDividerCustom: "export.sceneDividerCustom",
  sceneTitle: "export.sceneTitle",
  rubyStyle: "export.rubyStyle",
  emphasisDotsStyle: "export.emphasisDotsStyle",
  sceneBreakStyle: "export.sceneBreakStyle",
  sceneBreakCustom: "export.sceneBreakCustom",
  includeTrashBin: "export.includeTrashBin",
  pixivChapterNewpage: "export.pixivChapterNewpage",
  narouEmphasisMode: "export.narouEmphasisMode",
  tateChuYoko: "export.tateChuYoko",
  exportPresetId: "export.exportPresetId",
  /** ユーザー定義プリセット配列を JSON 文字列で保存するキー */
  userPresets: "export.userPresets",
} as const;

/** デフォルトルビスタイル（出力形式別） */
export function defaultRubyStyle(format: ExportFormat): RubyStyle {
  return format === "plaintext" ? "parentheses" : "html";
}

/** デフォルト傍点スタイル（出力形式別） */
export function defaultEmphasisDotsStyle(
  format: ExportFormat,
): EmphasisDotsStyle {
  return format === "html" ? "html" : "aozora";
}
