import * as api from "./api";
import { KEY_SCOPE } from "./types";
import { PROJECT_ID } from "@/features/project/constants";
import { globalSettingsRepository } from "@/lib/globalSettings/repository";

const SCHEMA_VERSION_KEY = "meta.settingsSchemaVersion";
const CURRENT_VERSION = 1;

/**
 * Migrate app_settings (workspace-scoped DB) to the new split stores:
 * - Global-scope keys → GlobalSettings.userPreferences (global-settings.json)
 * - Project-scope keys → project_settings table (idempotent: skip if already present)
 *
 * Reads migration version from app_settings["meta.settingsSchemaVersion"].
 * Safe to call multiple times (idempotent after version bump).
 *
 * Must be called after the workspace DB is open and its GlobalSettings file is
 * available, but before useSettingsStore.loadAll().
 */
export async function migrateAppSettingsToScopedStores(): Promise<void> {
  const versionStr = await api.getSetting(SCHEMA_VERSION_KEY);
  const version = versionStr ? parseInt(versionStr, 10) : 0;
  if (version >= CURRENT_VERSION) return;

  const all = await api.getSettingsByPrefix("");

  const globalUpdates: Record<string, string> = {};
  const projectUpdates: Record<string, string> = {};

  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("meta.")) continue;
    const scope = KEY_SCOPE[key];
    if (scope === "global") {
      globalUpdates[key] = value;
    } else if (scope === "project") {
      projectUpdates[key] = value;
    }
  }

  // Batch-write global preferences (last-open-wins for cross-workspace conflicts)
  if (Object.keys(globalUpdates).length > 0) {
    await globalSettingsRepository.patch((current) => ({
      ...current,
      userPreferences: {
        ...(current.userPreferences ?? {}),
        ...globalUpdates,
      },
    }));
  }

  // Insert project settings idempotently (skip if already present)
  for (const [key, value] of Object.entries(projectUpdates)) {
    const existing = await api.getProjectSetting(PROJECT_ID, key);
    if (existing === null) {
      await api.setProjectSetting(PROJECT_ID, key, value);
    }
  }

  await api.setSetting(SCHEMA_VERSION_KEY, String(CURRENT_VERSION));
}

const RETIRED_DISPLAY_KEYS = [
  "display.mochiLayout",
  "display.cardLayout",
  "display.glassEffectEnabled",
  "display.glassTransparency",
  "display.glassEffectIntensity",
  "display.glassBackdropGradient",
  "display.glassNativeVibrancy",
  "display.glassSurfaceShell",
  "display.glassSurfaceDock",
  "display.glassSurfacePanels",
  "display.glassSurfaceChat",
  "display.glassSurfacePopovers",
  "display.glassSurfaceEditorChrome",
] as const;

/** Remove settings owned by the retired splitter-line layout and app-wide glass UI. */
export async function removeRetiredDisplaySettings(): Promise<void> {
  const prefs = (await globalSettingsRepository.read()).userPreferences;
  if (prefs) {
    const next = { ...prefs };
    let changed = false;
    for (const key of RETIRED_DISPLAY_KEYS) {
      if (!(key in next)) continue;
      delete next[key];
      changed = true;
    }
    if (changed) {
      await globalSettingsRepository.patch((current) => ({
        ...current,
        userPreferences: next,
      }));
    }
  }

  // Older workspaces can still contain these keys in the pre-split app_settings table.
  for (const key of RETIRED_DISPLAY_KEYS) {
    await api.deleteSetting(key);
  }
}

// 旧「死に設定」モデルキー → 機能別ロールキーの吸収マッピング。
//   ai.inlineModel       → aiModel.role.inline (inline_ai_stream)
//   ai.sessionTitleModel → aiModel.role.cheap  (session_title は cheap ロール)
const LEGACY_ROLE_MODEL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["ai.inlineModel", "aiModel.role.inline"],
  ["ai.sessionTitleModel", "aiModel.role.cheap"],
];

/**
 * 旧 `ai.inlineModel` / `ai.sessionTitleModel` を機能別ロールキーへ吸収する。
 *
 * これらは Phase 1 以前、設定 UI に ModelPicker があっても値がどのコードからも
 * 読まれない死に設定だった。Phase 2 でロール UI を露出するにあたり、既存ユーザーが
 * 設定していた値を失わせずロールキーへ移送して初めて実効化する。
 *
 * 旧キーが存在するとき、対応ロールキーが未設定（空/欠如）なら非空の旧値を移送し、
 * いずれの場合も旧キーを除去する。旧 UI ピッカーは撤去済みのため旧キーが再生産
 * されることはなく、二度目以降の呼び出しは旧キー不在で no-op になる。
 */
export async function migrateModelRoleKeys(): Promise<void> {
  const prefs = (await globalSettingsRepository.read()).userPreferences;
  if (!prefs) return;

  const next: Record<string, string> = { ...prefs };
  let changed = false;
  for (const [legacyKey, roleKey] of LEGACY_ROLE_MODEL_KEYS) {
    if (!(legacyKey in next)) continue;
    // 非空の旧値があり、ロールキーが未設定のときだけ移送する（既存ロール値優先）。
    if (next[legacyKey] && !next[roleKey]) {
      next[roleKey] = next[legacyKey];
    }
    // 旧キーは Phase 2 で UI から撤去されるため常にクリーンアップする。
    delete next[legacyKey];
    changed = true;
  }
  if (!changed) return;
  await globalSettingsRepository.patch((current) => ({
    ...current,
    userPreferences: next,
  }));
}

/**
 * Seed project_settings from globalSettings.projectDefaults.
 * Idempotent: skips keys already present in project_settings.
 * Must be called after the workspace DB is open. Used both for new workspaces
 * (default project) and for projects created later via the Project switcher.
 */
export async function seedProjectSettingsFromDefaults(
  projectId: string = PROJECT_ID,
): Promise<void> {
  const defaults =
    (await globalSettingsRepository.read()).projectDefaults ?? {};
  for (const [key, value] of Object.entries(defaults)) {
    const existing = await api.getProjectSetting(projectId, key);
    if (existing === null) {
      await api.setProjectSetting(projectId, key, value);
    }
  }
}
