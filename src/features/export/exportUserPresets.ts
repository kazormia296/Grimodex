/**
 * exportUserPresets.ts — ユーザー定義プリセットの永続化レイヤー。
 *
 * 保存形態: settings テーブルに JSON 文字列を1キーで持つ（key=export.userPresets）。
 * プリセット追加・削除・検索は純粋関数として実装し、永続化は呼び出し側 (ExportDialog) に任せる。
 */
import { DEFAULT_EXPORT_SETTINGS } from "./types";
import type { ExportSettings } from "./types";

export interface UserExportPreset {
  /** UUID-like 識別子。固定長である必要はない */
  id: string;
  name: string;
  settings: ExportSettings;
}

function generateId(): string {
  // crypto.randomUUID は Tauri (Node v22) でもブラウザでも利用可能。フォールバックは Date+rand。
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function parseUserPresets(json: string): UserExportPreset[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    // 最低限の shape チェック。後方互換のため緩めに通す。
    // 新しい設定項目は DEFAULT と merge し、旧プリセットをロード時に移行する。
    return parsed
      .filter(
        (p): p is UserExportPreset =>
          typeof p === "object" &&
          p !== null &&
          typeof p.id === "string" &&
          typeof p.name === "string" &&
          typeof p.settings === "object" &&
          p.settings !== null,
      )
      .map((p) => ({
        ...p,
        settings: {
          ...DEFAULT_EXPORT_SETTINGS,
          ...p.settings,
          exportPresetId: p.settings.exportPresetId ?? "custom",
        },
      }));
  } catch {
    return [];
  }
}

export function serializeUserPresets(presets: UserExportPreset[]): string {
  return JSON.stringify(presets);
}

export function addUserPreset(
  existing: UserExportPreset[],
  name: string,
  settings: ExportSettings,
): UserExportPreset[] {
  const trimmed = name.trim();
  const normalizedSettings: ExportSettings = {
    ...settings,
    // 保存時は常に custom 化。再選択で「ユーザープリセット」として扱われる。
    exportPresetId: "custom",
  };
  return [
    ...existing,
    { id: generateId(), name: trimmed, settings: normalizedSettings },
  ];
}

export function removeUserPreset(
  existing: UserExportPreset[],
  id: string,
): UserExportPreset[] {
  return existing.filter((p) => p.id !== id);
}

export function findUserPreset(
  list: UserExportPreset[],
  id: string,
): UserExportPreset | undefined {
  return list.find((p) => p.id === id);
}
