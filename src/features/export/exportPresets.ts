/**
 * exportPresets.ts — 投稿サイト別ビルトインプリセット定義と適用/検出ロジック。
 *
 * 設計:
 *  - ビルトインは「完全上書き」方式。プリセット選択時に ExportSettings をまるごと差し替える
 *    （ただし includeTrashBin など「プリセットと無関係な意思決定」は現在値を引き継ぐ）。
 *  - 手動で1項目でも変更されたら detectExportPreset で "custom" にフォールバック。
 *  - ユーザー定義プリセットは別レイヤー（exportUserPresets.ts）で管理する。
 */
import type {
  ExportPresetId,
  ExportSettings,
  ExportFormat,
  RubyStyle,
  EmphasisDotsStyle,
  SceneBreakStyle,
  SceneDivider,
  FolderHeadingStyle,
  FolderHeadingFormat,
  NarouEmphasisMode,
  SceneTitleStyle,
} from "./types";
import { DEFAULT_EXPORT_SETTINGS } from "./types";

/** プリセット ID の網羅（型ガード兼ねる） */
export const EXPORT_PRESET_IDS = [
  "custom",
  "narou",
  "kakuyomu",
  "alphapolis",
  "pixiv",
  "hameln",
  "novelup",
  "novelism",
  "aozora",
  "generic-md",
  "word-html",
  "web-fiction",
  "ao3",
] as const satisfies readonly ExportPresetId[];

/**
 * プリセットの主な対象言語。プリセット選択 UI の optgroup 並べ替え
 * （exportPresetCatalog.ts）で使う。
 *  - "ja":  日本の投稿サイト／青空文庫向け
 *  - "en":  英語圏の web 小説プラットフォーム向け
 *  - "all": 言語共通（汎用 Markdown / HTML）
 */
export type ExportPresetRegion = "ja" | "en" | "all";

export interface ExportPresetMeta {
  id: ExportPresetId;
  /** 表示名（i18n キー） */
  labelKey: string;
  /** 主な対象言語（UI のグルーピングに使用） */
  region: ExportPresetRegion;
  /** 補足説明（i18n キー、任意） */
  descriptionKey?: string;
  /** ルビ文字数バリデーション上限。null なら検査なし */
  rubyLimit: { baseMax: number; rubyMax: number } | null;
  /** プリセットが規定する ExportSettings。custom 以外で使用 */
  settings: ExportSettings;
}

// ────────────────────────────────────────────────────────────────────
// プリセット定義
// ────────────────────────────────────────────────────────────────────
//
// 各プリセットの「中身」はビルトインの設計合意（plan）に基づく。
// includeTrashBin などプリセット非関連フィールドはここでは DEFAULT を流す。

const SHARED_DEFAULTS = {
  folderHeading: false,
  folderHeadingStyle: "squares" as FolderHeadingStyle,
  folderHeadingFormat: "standard" as FolderHeadingFormat,
  sceneDividerCustom: "",
  sceneTitle: "none" as SceneTitleStyle,
  sceneBreakCustom: "",
  includeTrashBin: false,
  pixivChapterNewpage: false,
  narouEmphasisMode: "batch" as NarouEmphasisMode,
};

function makePreset(
  id: Exclude<ExportPresetId, "custom">,
  labelKey: string,
  region: ExportPresetRegion,
  overrides: {
    format: ExportFormat;
    rubyStyle: RubyStyle;
    emphasisDotsStyle: EmphasisDotsStyle;
    sceneBreakStyle: SceneBreakStyle;
    sceneDivider: SceneDivider;
    folderHeading?: boolean;
    folderHeadingFormat?: FolderHeadingFormat;
    sceneBreakCustom?: string;
    narouEmphasisMode?: NarouEmphasisMode;
    pixivChapterNewpage?: boolean;
  },
  meta: {
    descriptionKey?: string;
    rubyLimit?: { baseMax: number; rubyMax: number };
  } = {},
): ExportPresetMeta {
  const settings: ExportSettings = {
    ...DEFAULT_EXPORT_SETTINGS,
    ...SHARED_DEFAULTS,
    ...overrides,
    exportPresetId: id,
  };
  return {
    id,
    labelKey,
    region,
    descriptionKey: meta.descriptionKey,
    rubyLimit: meta.rubyLimit ?? null,
    settings,
  };
}

export const EXPORT_PRESETS: Record<
  Exclude<ExportPresetId, "custom">,
  ExportPresetMeta
> = {
  narou: makePreset(
    "narou",
    "export.settings.preset.narou",
    "ja",
    {
      format: "plaintext",
      rubyStyle: "aozora",
      emphasisDotsStyle: "narou-emphasis-batch",
      sceneBreakStyle: "asterisks",
      sceneDivider: "blank",
    },
    {
      descriptionKey: "export.settings.presetNote.narou",
      rubyLimit: { baseMax: 10, rubyMax: 10 },
    },
  ),

  kakuyomu: makePreset(
    "kakuyomu",
    "export.settings.preset.kakuyomu",
    "ja",
    {
      format: "plaintext",
      rubyStyle: "aozora-auto",
      emphasisDotsStyle: "double-angle",
      sceneBreakStyle: "asterisks",
      sceneDivider: "blank",
    },
    {
      descriptionKey: "export.settings.presetNote.kakuyomu",
      rubyLimit: { baseMax: 20, rubyMax: 50 },
    },
  ),

  alphapolis: makePreset(
    "alphapolis",
    "export.settings.preset.alphapolis",
    "ja",
    {
      format: "plaintext",
      rubyStyle: "aozora",
      emphasisDotsStyle: "double-angle",
      sceneBreakStyle: "asterisks",
      sceneDivider: "blank",
    },
  ),

  pixiv: makePreset(
    "pixiv",
    "export.settings.preset.pixiv",
    "ja",
    {
      format: "plaintext",
      folderHeading: true,
      folderHeadingFormat: "pixiv-chapter",
      rubyStyle: "rb-bracket",
      emphasisDotsStyle: "double-angle",
      sceneBreakStyle: "custom",
      sceneBreakCustom: "[newpage]",
      sceneDivider: "blank",
    },
    { descriptionKey: "export.settings.presetNote.pixiv" },
  ),

  hameln: makePreset("hameln", "export.settings.preset.hameln", "ja", {
    format: "plaintext",
    rubyStyle: "aozora",
    emphasisDotsStyle: "double-angle",
    sceneBreakStyle: "asterisks",
    sceneDivider: "blank",
  }),

  novelup: makePreset(
    "novelup",
    "export.settings.preset.novelup",
    "ja",
    {
      format: "plaintext",
      rubyStyle: "aozora",
      emphasisDotsStyle: "double-angle",
      sceneBreakStyle: "asterisks",
      sceneDivider: "blank",
    },
    { rubyLimit: { baseMax: 50, rubyMax: 50 } },
  ),

  novelism: makePreset(
    "novelism",
    "export.settings.preset.novelism",
    "ja",
    {
      format: "plaintext",
      rubyStyle: "aozora",
      emphasisDotsStyle: "double-angle",
      sceneBreakStyle: "asterisks",
      sceneDivider: "blank",
    },
    { descriptionKey: "export.settings.presetNote.novelism" },
  ),

  aozora: makePreset(
    "aozora",
    "export.settings.preset.aozora",
    "ja",
    {
      format: "plaintext",
      rubyStyle: "aozora",
      emphasisDotsStyle: "aozora",
      sceneBreakStyle: "asterisks",
      sceneDivider: "blank2",
    },
    { descriptionKey: "export.settings.presetNote.aozora" },
  ),

  "generic-md": makePreset(
    "generic-md",
    "export.settings.preset.genericMd",
    "all",
    {
      format: "markdown",
      folderHeading: true,
      rubyStyle: "parentheses",
      emphasisDotsStyle: "plain",
      sceneBreakStyle: "hr",
      sceneDivider: "blank2",
    },
    { descriptionKey: "export.settings.presetNote.genericMd" },
  ),

  "word-html": makePreset(
    "word-html",
    "export.settings.preset.wordHtml",
    "all",
    {
      format: "html",
      folderHeading: true,
      rubyStyle: "html",
      emphasisDotsStyle: "html",
      sceneBreakStyle: "hr",
      sceneDivider: "blank",
    },
    { descriptionKey: "export.settings.presetNote.wordHtml" },
  ),

  // ── 英語圏向け ──────────────────────────────────────────────
  // 英語小説はルビ・傍点をほぼ使わないため、base ルビ（除去）+ plain 傍点
  // （除去）に寄せる。章見出しはサイト側 UI で付ける前提。
  "web-fiction": makePreset(
    "web-fiction",
    "export.settings.preset.webFiction",
    "en",
    {
      format: "plaintext",
      folderHeading: false,
      rubyStyle: "base",
      emphasisDotsStyle: "plain",
      sceneBreakStyle: "asterisks",
      sceneDivider: "blank",
    },
    { descriptionKey: "export.settings.presetNote.webFiction" },
  ),

  // AO3 (Archive of Our Own) HTML エディタへの貼付向け。word-html に近いが
  // 傍点 span を出さず（plain）、章間を blank2 で区切る。
  ao3: makePreset(
    "ao3",
    "export.settings.preset.ao3",
    "en",
    {
      format: "html",
      folderHeading: true,
      rubyStyle: "html",
      emphasisDotsStyle: "plain",
      sceneBreakStyle: "hr",
      sceneDivider: "blank2",
    },
    { descriptionKey: "export.settings.presetNote.ao3" },
  ),
};

// ────────────────────────────────────────────────────────────────────
// applyExportPreset — プリセット選択 → ExportSettings 完全上書き
// ────────────────────────────────────────────────────────────────────
//
// 「プリセットに含まれない意思決定」は current から引き継ぐ：
//  - includeTrashBin: ゴミ箱含めるかはユーザーの判断、プリセットで上書きしない

/** プリセット選択時に「現在値を引き継ぐ」フィールド一覧 */
const PRESERVED_FIELDS = ["includeTrashBin"] as const;

export function applyExportPreset(
  id: ExportPresetId,
  current: ExportSettings,
): ExportSettings {
  if (id === "custom") {
    return { ...current, exportPresetId: "custom" };
  }
  const def = EXPORT_PRESETS[id];
  const preserved: Partial<ExportSettings> = {};
  for (const key of PRESERVED_FIELDS) {
    preserved[key] = current[key];
  }
  return {
    ...def.settings,
    ...preserved,
    exportPresetId: id,
  };
}

// ────────────────────────────────────────────────────────────────────
// detectExportPreset — 設定値からプリセット ID を逆引き
// ────────────────────────────────────────────────────────────────────
//
// プリセット定義と完全一致なら該当 ID、そうでなければ "custom"。
// exportPresetId 自体と「引き継ぎフィールド」は比較対象外。

/** プリセット同一判定で比較するフィールド一覧 */
const COMPARED_FIELDS = [
  "format",
  "folderHeading",
  "folderHeadingStyle",
  "folderHeadingFormat",
  "sceneDivider",
  "sceneDividerCustom",
  "sceneTitle",
  "rubyStyle",
  "emphasisDotsStyle",
  "sceneBreakStyle",
  "sceneBreakCustom",
  "pixivChapterNewpage",
  "narouEmphasisMode",
] as const satisfies readonly (keyof ExportSettings)[];

function settingsMatch(a: ExportSettings, b: ExportSettings): boolean {
  for (const key of COMPARED_FIELDS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * 設定値からプリセット ID を逆引きする。
 *
 * 同一の `settings` を共有するプリセットが複数ある（alphapolis / hameln / novelism は
 * 実際の投稿サイト仕様上同じ記法を採用しているため）ので、現在選択中の ID を
 * `hintId` として渡すと、それが今も一致する限り維持される。
 * UI から呼ぶときは常に `settings.exportPresetId` を hint に渡してよい。
 */
export function detectExportPreset(
  settings: ExportSettings,
  hintId?: ExportPresetId,
): ExportPresetId {
  if (hintId && hintId !== "custom" && EXPORT_PRESETS[hintId]) {
    if (settingsMatch(settings, EXPORT_PRESETS[hintId].settings)) {
      return hintId;
    }
  }
  for (const id of EXPORT_PRESET_IDS) {
    if (id === "custom") continue;
    if (settingsMatch(settings, EXPORT_PRESETS[id].settings)) {
      return id;
    }
  }
  return "custom";
}

// ────────────────────────────────────────────────────────────────────
// validateUserPresetName — カスタムプリセット名バリデーション
// ────────────────────────────────────────────────────────────────────

export type ValidateNameResult =
  | { ok: true }
  | { ok: false; reason: "empty" | "tooLong" };

export const USER_PRESET_NAME_MAX = 40;

export function validateUserPresetName(name: string): ValidateNameResult {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > USER_PRESET_NAME_MAX) {
    return { ok: false, reason: "tooLong" };
  }
  return { ok: true };
}
