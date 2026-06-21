/**
 * rubyProfiles.ts — 記法プロファイル + 投稿サイト登録（レジストリ）の正本。
 *
 * 設計:
 *  - 「記法プロファイル」を一次概念にする。プロファイルは、その系統の標準的なサイトが使う
 *    ExportSettings 一式（完全な設定）を表す。
 *  - 各サイトは「プロファイル参照 + 差分オーバーライド」の SiteEntry として登録する。
 *    出力が同一のサイト（aozora ルビ + double-angle 傍点 など）は同じプロファイルを共有し、
 *    定義の重複をなくす。サイト固有差分（ルビ文字数上限・傍点モード等）だけを持つ。
 *  - `resolveSitePreset(id)` がプロファイル既定 + サイトオーバーライドを合成して
 *    ExportSettings を返す。これが apply / detect / validation すべての単一の真実源。
 *
 * 重要: 既存サイトの「出力」を一切変えないこと。プロファイル値は旧 exportPresets.ts の
 * 各プリセット実値を厳密に踏襲している（rubyProfiles.test.ts の LEGACY_EXPECTED で固定）。
 */
import type { ExportPresetId, ExportSettings } from "./types";
import { DEFAULT_EXPORT_SETTINGS } from "./types";

// ────────────────────────────────────────────────────────────────────
// 記法プロファイル
// ────────────────────────────────────────────────────────────────────

export type RubyProfileId =
  | "jp-double-angle"
  | "jp-ruby-emphasis"
  | "pixiv"
  | "aozora-bunko"
  | "plain-only"
  | "generic-md"
  | "word-html";

export interface RubyProfile {
  id: RubyProfileId;
  /** 系統名（UI 見出し）i18n キー */
  labelKey: string;
  /** 記法例（UI 表示・等幅）i18n キー */
  exampleKey: string;
  /** この系統の標準サイトが使う ExportSettings 一式（exportPresetId は placeholder） */
  settings: ExportSettings;
}

/**
 * 全プロファイル共通のベース。jp-double-angle（最頻系統）の値をそのまま基準にし、
 * 各プロファイルは差分だけ上書きする。folderHeading 等は DEFAULT と異なるため明示する。
 */
const PROFILE_BASE: ExportSettings = {
  format: "plaintext",
  folderHeading: false,
  folderHeadingStyle: "squares",
  folderHeadingFormat: "standard",
  sceneDivider: "blank",
  sceneDividerCustom: "",
  sceneTitle: "none",
  rubyStyle: "aozora",
  emphasisDotsStyle: "double-angle",
  sceneBreakStyle: "asterisks",
  sceneBreakCustom: "",
  includeTrashBin: false,
  pixivChapterNewpage: false,
  narouEmphasisMode: "batch",
  // 大半のサイトは縦中横の記法を持たず、縦書きビューアが半角2桁を自動で組む。
  // → 既定は記法なし（半角数字をそのまま残す）。青空文庫/caita だけが上書きする。
  tateChuYoko: "none",
  exportPresetId: "custom",
};

function profileSettings(overrides: Partial<ExportSettings>): ExportSettings {
  return { ...PROFILE_BASE, ...overrides, exportPresetId: "custom" };
}

export const RUBY_PROFILES: Record<RubyProfileId, RubyProfile> = {
  "jp-double-angle": {
    id: "jp-double-angle",
    labelKey: "export.settings.section.jpDoubleAngle",
    exampleKey: "export.settings.profileExample.jpDoubleAngle",
    // 一般ルビ ｜漢字《かんじ》 + 二重山括弧傍点 《《重要》》（= 旧 alphapolis）
    settings: profileSettings({}),
  },
  "jp-ruby-emphasis": {
    id: "jp-ruby-emphasis",
    labelKey: "export.settings.section.jpRubyEmphasis",
    exampleKey: "export.settings.profileExample.jpRubyEmphasis",
    // 一般ルビ + 傍点はルビ代用（中黒ルビ 1 字ずつ）。
    // narouEmphasisMode は PROFILE_BASE の "batch" のまま意図的に残す（"per-char" にしない）。
    // 出力は emphasisDotsStyle のみで決まる（narouEmphasisMode は描画に未使用）。もし
    // narouEmphasisMode を "per-char" にすると、なろうの per-char トグル後の設定
    // ({narou-emphasis-per-char, per-char}) が noveldays 等と完全一致し、detect が custom では
    // なく noveldays を返してしまう（= なろう per-char→custom の現挙動が壊れる）。
    settings: profileSettings({ emphasisDotsStyle: "narou-emphasis-per-char" }),
  },
  pixiv: {
    id: "pixiv",
    labelKey: "export.settings.section.pixiv",
    exampleKey: "export.settings.profileExample.pixiv",
    // pixiv 記法 [[rb:漢字 > かんじ]] + [chapter:]（= 旧 pixiv）
    settings: profileSettings({
      folderHeading: true,
      folderHeadingFormat: "pixiv-chapter",
      rubyStyle: "rb-bracket",
      sceneBreakStyle: "custom",
      sceneBreakCustom: "[newpage]",
    }),
  },
  "aozora-bunko": {
    id: "aozora-bunko",
    labelKey: "export.settings.section.aozoraBunko",
    exampleKey: "export.settings.profileExample.aozoraBunko",
    // 青空文庫テキスト ｜漢字《かんじ》 + ［＃傍点］（= 旧 aozora）
    // 縦中横は注記一覧・工作員マニュアルの正式仕様。既定は前方参照型
    // （`29［＃「29」は縦中横］`）— 対象が短く明確な数字 run 向きで無難。
    settings: profileSettings({
      emphasisDotsStyle: "aozora",
      sceneDivider: "blank2",
      tateChuYoko: "aozora-forward",
    }),
  },
  "plain-only": {
    id: "plain-only",
    labelKey: "export.settings.section.plainOnly",
    exampleKey: "export.settings.profileExample.plainOnly",
    // 特殊表現なし: ルビ・傍点を除去（= 旧 web-fiction）
    settings: profileSettings({
      rubyStyle: "base",
      emphasisDotsStyle: "plain",
    }),
  },
  "generic-md": {
    id: "generic-md",
    labelKey: "export.settings.section.generic",
    exampleKey: "export.settings.profileExample.genericMd",
    // 汎用 Markdown 漢字(かんじ)（= 旧 generic-md）
    settings: profileSettings({
      format: "markdown",
      folderHeading: true,
      rubyStyle: "parentheses",
      emphasisDotsStyle: "plain",
      sceneBreakStyle: "hr",
      sceneDivider: "blank2",
    }),
  },
  "word-html": {
    id: "word-html",
    labelKey: "export.settings.section.generic",
    exampleKey: "export.settings.profileExample.wordHtml",
    // Word貼付 (HTML) <ruby>…</ruby>（= 旧 word-html）
    settings: profileSettings({
      format: "html",
      folderHeading: true,
      rubyStyle: "html",
      emphasisDotsStyle: "html",
      sceneBreakStyle: "hr",
    }),
  },
};

// ────────────────────────────────────────────────────────────────────
// ダイアログ表示セクション（プロファイルと独立した「見せ方」の単位）
// ────────────────────────────────────────────────────────────────────

export type SectionId =
  | "jp-double-angle"
  | "jp-ruby-emphasis"
  | "pixiv"
  | "aozora-bunko"
  | "plain-only"
  | "generic"
  | "english";

export interface ExportSection {
  id: SectionId;
  /** 見出し i18n キー */
  labelKey: string;
}

/** ダイアログのセクション表示順（B-2） */
export const SECTION_ORDER: ExportSection[] = [
  { id: "jp-double-angle", labelKey: "export.settings.section.jpDoubleAngle" },
  {
    id: "jp-ruby-emphasis",
    labelKey: "export.settings.section.jpRubyEmphasis",
  },
  { id: "pixiv", labelKey: "export.settings.section.pixiv" },
  { id: "aozora-bunko", labelKey: "export.settings.section.aozoraBunko" },
  { id: "plain-only", labelKey: "export.settings.section.plainOnly" },
  { id: "generic", labelKey: "export.settings.section.generic" },
  { id: "english", labelKey: "export.settings.section.english" },
];

/**
 * プロジェクト言語に応じたセクション表示順。
 * 英語プロジェクトでは英語圏セクション → 汎用 → 日本語系の順に並べ替える
 * （執筆言語に一致するプラットフォーム群を先頭に出す。旧 exportPresetCatalog の挙動を踏襲）。
 * それ以外（ja / 未指定）は SECTION_ORDER のまま。
 */
export function getSectionOrder(projectLanguage: string): ExportSection[] {
  if (projectLanguage !== "en") return SECTION_ORDER;
  const priority: SectionId[] = ["english", "generic"];
  const byId = new Map(SECTION_ORDER.map((s) => [s.id, s] as const));
  const head = priority
    .map((id) => byId.get(id))
    .filter((s): s is ExportSection => s !== undefined);
  const tail = SECTION_ORDER.filter((s) => !priority.includes(s.id));
  return [...head, ...tail];
}

// ────────────────────────────────────────────────────────────────────
// サイト登録（レジストリ）
// ────────────────────────────────────────────────────────────────────

export interface SiteEntry {
  /** 永続化される exportPresetId（後方互換のため既存 ID は維持） */
  id: ExportPresetId;
  /** 表示名 i18n キー */
  labelKey: string;
  profileId: RubyProfileId;
  /** ダイアログ表示セクション（profileId と独立に指定できる） */
  section: SectionId;
  /** プロファイルと異なる軸だけ指定 */
  overrides?: Partial<ExportSettings>;
  /** ルビ文字数バリデーション上限。未指定なら検査なし */
  rubyLimit?: { baseMax: number; rubyMax: number };
  /** 設定ペイン側に出すサブオプショントグルの種別 */
  suboption?: "narou" | "pixiv";
  /** ダイアログに出す補足（i18n キー、任意） */
  noteKey?: string;
}

/**
 * 登録順 = detect の探索順 = 永続化 ID の網羅。
 * 同値群の no-hint 既定を現状維持するため、alphapolis を kakuyomu の直後に置く。
 */
const SITE_ENTRIES: SiteEntry[] = [
  // ── 系統: 一般ルビ + 二重山括弧傍点 ──────────────────────────────
  {
    id: "kakuyomu",
    labelKey: "export.settings.preset.kakuyomu",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
    overrides: { rubyStyle: "aozora-auto" },
    rubyLimit: { baseMax: 20, rubyMax: 50 },
    noteKey: "export.settings.presetNote.kakuyomu",
  },
  {
    id: "alphapolis",
    labelKey: "export.settings.preset.alphapolis",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
  },
  {
    id: "novelism",
    labelKey: "export.settings.preset.novelism",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
    noteKey: "export.settings.presetNote.novelism",
  },
  {
    id: "solispia",
    labelKey: "export.settings.preset.solispia",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
  },
  {
    id: "estar",
    labelKey: "export.settings.preset.estar",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
    noteKey: "export.settings.presetNote.estar",
  },
  {
    id: "aipen",
    labelKey: "export.settings.preset.aipen",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
  },
  {
    id: "sutekibungei",
    labelKey: "export.settings.preset.sutekibungei",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
  },
  {
    id: "caita",
    labelKey: "export.settings.preset.caita",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
    // caita は縦中横を独自タグ [tatechuyoko]…[/tatechuyoko] で表す。
    overrides: { tateChuYoko: "caita" },
    noteKey: "export.settings.presetNote.caita",
  },
  {
    id: "noveland",
    labelKey: "export.settings.preset.noveland",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
  },
  {
    id: "hameln",
    labelKey: "export.settings.preset.hameln",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
  },
  {
    id: "novelup",
    labelKey: "export.settings.preset.novelup",
    profileId: "jp-double-angle",
    section: "jp-double-angle",
    rubyLimit: { baseMax: 50, rubyMax: 50 },
  },

  // ── 系統: 一般ルビ + 傍点はルビ代用 ──────────────────────────────
  {
    id: "narou",
    labelKey: "export.settings.preset.narou",
    profileId: "jp-ruby-emphasis",
    section: "jp-ruby-emphasis",
    overrides: { emphasisDotsStyle: "narou-emphasis-batch" },
    rubyLimit: { baseMax: 10, rubyMax: 10 },
    suboption: "narou",
    noteKey: "export.settings.presetNote.narou",
  },
  {
    id: "noveldays",
    labelKey: "export.settings.preset.noveldays",
    profileId: "jp-ruby-emphasis",
    section: "jp-ruby-emphasis",
  },
  {
    id: "noichigo",
    labelKey: "export.settings.preset.noichigo",
    profileId: "jp-ruby-emphasis",
    section: "jp-ruby-emphasis",
  },
  {
    id: "maho",
    labelKey: "export.settings.preset.maho",
    profileId: "jp-ruby-emphasis",
    section: "jp-ruby-emphasis",
  },

  // ── 単独系統 ─────────────────────────────────────────────────────
  {
    id: "pixiv",
    labelKey: "export.settings.preset.pixiv",
    profileId: "pixiv",
    section: "pixiv",
    suboption: "pixiv",
    noteKey: "export.settings.presetNote.pixiv",
  },
  {
    id: "aozora",
    labelKey: "export.settings.preset.aozora",
    profileId: "aozora-bunko",
    section: "aozora-bunko",
    noteKey: "export.settings.presetNote.aozora",
  },
  {
    id: "monogatary",
    labelKey: "export.settings.preset.monogatary",
    profileId: "plain-only",
    section: "plain-only",
    noteKey: "export.settings.presetNote.monogatary",
  },

  // ── 汎用 ─────────────────────────────────────────────────────────
  {
    id: "generic-md",
    labelKey: "export.settings.preset.genericMd",
    profileId: "generic-md",
    section: "generic",
    noteKey: "export.settings.presetNote.genericMd",
  },
  {
    id: "word-html",
    labelKey: "export.settings.preset.wordHtml",
    profileId: "word-html",
    section: "generic",
    noteKey: "export.settings.presetNote.wordHtml",
  },

  // ── 英語圏向け（現挙動維持のため残す）────────────────────────────
  {
    id: "web-fiction",
    labelKey: "export.settings.preset.webFiction",
    profileId: "plain-only",
    section: "english",
    noteKey: "export.settings.presetNote.webFiction",
  },
  {
    id: "ao3",
    labelKey: "export.settings.preset.ao3",
    profileId: "word-html",
    section: "english",
    overrides: { emphasisDotsStyle: "plain", sceneDivider: "blank2" },
    noteKey: "export.settings.presetNote.ao3",
  },
];

export const SITE_REGISTRY: Record<string, SiteEntry> = Object.fromEntries(
  SITE_ENTRIES.map((e) => [e.id, e]),
);

/** 登録サイト ID の網羅（detect の探索順 = 宣言順） */
export const SITE_IDS: ExportPresetId[] = SITE_ENTRIES.map((e) => e.id);

// ────────────────────────────────────────────────────────────────────
// 解決ヘルパ
// ────────────────────────────────────────────────────────────────────

/** プロファイル既定 + サイトオーバーライドを合成して ExportSettings を得る */
export function resolveSitePreset(siteId: string): ExportSettings {
  const entry = SITE_REGISTRY[siteId];
  if (!entry) {
    return { ...DEFAULT_EXPORT_SETTINGS, exportPresetId: "custom" };
  }
  return {
    ...RUBY_PROFILES[entry.profileId].settings,
    ...entry.overrides,
    exportPresetId: entry.id,
  };
}

export function getSiteEntry(siteId: string): SiteEntry | null {
  return SITE_REGISTRY[siteId] ?? null;
}

export function getSiteRubyLimit(
  siteId: string,
): { baseMax: number; rubyMax: number } | null {
  return SITE_REGISTRY[siteId]?.rubyLimit ?? null;
}

/** 指定セクションに属するサイト ID 一覧（宣言順を維持） */
export function siteIdsInSection(sectionId: SectionId): ExportPresetId[] {
  return SITE_IDS.filter((id) => SITE_REGISTRY[id]?.section === sectionId);
}
