/**
 * exportPresets.ts — プリセット適用/検出ロジック。
 *
 * 記法プロファイル + サイト登録の正本は rubyProfiles.ts に集約済み。ここは
 *  - applyExportPreset: サイト選択 → ExportSettings 完全上書き（非関連フィールドは引き継ぐ）
 *  - detectExportPreset: 設定値 → サイト ID 逆引き（レジストリ駆動）
 *  - validateUserPresetName: ユーザー定義プリセット名のバリデーション
 * の薄いラッパだけを提供する。
 */
import type { ExportPresetId, ExportSettings } from "./types";
import { resolveSitePreset, SITE_IDS, SITE_REGISTRY } from "./rubyProfiles";

/** プリセット ID の網羅（"custom" + 全登録サイト）。後方互換のため公開。 */
export const EXPORT_PRESET_IDS = [
  "custom",
  ...SITE_IDS,
] as const satisfies readonly ExportPresetId[];

// ────────────────────────────────────────────────────────────────────
// applyExportPreset — サイト選択 → ExportSettings 完全上書き
// ────────────────────────────────────────────────────────────────────
//
// 「プリセットに含まれない意思決定」は current から引き継ぐ：
//  - includeTrashBin: ゴミ箱含めるかはユーザーの判断、プリセットで上書きしない

/** サイト選択時に「現在値を引き継ぐ」フィールド一覧 */
const PRESERVED_FIELDS = ["includeTrashBin"] as const;

export function applyExportPreset(
  id: ExportPresetId,
  current: ExportSettings,
): ExportSettings {
  if (id === "custom" || !SITE_REGISTRY[id]) {
    return { ...current, exportPresetId: "custom" };
  }
  const resolved = resolveSitePreset(id);
  const preserved: Partial<ExportSettings> = {};
  for (const key of PRESERVED_FIELDS) {
    preserved[key] = current[key];
  }
  return {
    ...resolved,
    ...preserved,
    exportPresetId: id,
  };
}

// ────────────────────────────────────────────────────────────────────
// detectExportPreset — 設定値からサイト ID を逆引き
// ────────────────────────────────────────────────────────────────────
//
// レジストリをなめて resolveSitePreset と構造比較する。完全一致なら該当 ID、
// なければ "custom"。exportPresetId 自体と「引き継ぎフィールド」は比較対象外。

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

export function settingsMatch(a: ExportSettings, b: ExportSettings): boolean {
  for (const key of COMPARED_FIELDS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * 設定値からサイト ID を逆引きする。
 *
 * 同一の `settings` を共有するサイトが複数ある（alphapolis / hameln / solispia 等は
 * 実際の投稿サイト仕様上同じ記法を採用しているため）ので、現在選択中の ID を
 * `hintId` として渡すと、それが今も一致する限り維持される。
 * UI から呼ぶときは常に `settings.exportPresetId` を hint に渡してよい。
 */
export function detectExportPreset(
  settings: ExportSettings,
  hintId?: ExportPresetId,
): ExportPresetId {
  if (hintId && hintId !== "custom" && SITE_REGISTRY[hintId]) {
    if (settingsMatch(settings, resolveSitePreset(hintId))) {
      return hintId;
    }
  }
  for (const id of SITE_IDS) {
    if (settingsMatch(settings, resolveSitePreset(id))) {
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
