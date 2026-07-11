import { create } from "zustand";
import * as api from "./api";
import {
  DEFAULT_SETTINGS,
  KEY_SCOPE,
  LANGUAGE_DEFAULT_OVERRIDES,
} from "./types";
import { PROJECT_ID } from "@/features/project/constants";

type Layer = Record<string, string>;

interface SettingsState {
  cache: Record<string, string>;
  /**
   * Raw persisted layers, kept so the effective cache can be rebuilt when the
   * project language changes (which swaps the default fallback).
   * Precedence low→high: DEFAULT < language override < legacy < project < global.
   */
  layers: { legacy: Layer; project: Layer; global: Layer };
  /** Current project language; selects the LANGUAGE_DEFAULT_OVERRIDES entry. */
  projectLanguage: string;
  isLoaded: boolean;
  _timers: Map<string, ReturnType<typeof setTimeout>>;
  /**
   * デバウンス中でまだ persist されていない key→value。flushPending と
   * loadAll はここを正とする — cache は loadAll の再構築で pending 書き込みを
   * 失い得るため、cache から読み戻すと古い値を永続化してしまう。
   */
  _pending: Map<string, string>;

  loadAll: () => Promise<void>;
  /** Re-point the default fallback at the given language and rebuild. */
  applyProjectLanguage: (language: string) => void;
  get: (key: string, defaultValue?: string) => string;
  getNumber: (key: string, defaultValue?: number) => number;
  getBoolean: (key: string, defaultValue?: boolean) => boolean;
  set: (key: string, value: string) => void;
  flushPending: () => Promise<void>;
}

// Route a key/value write to the correct persistent store.
// Dynamic import of workspace store breaks the circular dep
// (workspace/store → settingsStore → workspace/store).
async function persistSetting(key: string, value: string): Promise<void> {
  const scope = KEY_SCOPE[key];
  if (scope === "global") {
    const { useWorkspaceStore } = await import("@/features/workspace/store");
    const saved = await useWorkspaceStore
      .getState()
      .updateUserPreference(key, value);
    if (saved === false) {
      throw new Error(`Failed to persist global setting: ${key}`);
    }
  } else if (scope === "project") {
    await api.setProjectSetting(PROJECT_ID, key, value);
  } else {
    await api.setSetting(key, value);
  }
}

// Which in-memory layer a write belongs to (mirrors persistSetting routing).
function layerForKey(key: string): keyof SettingsState["layers"] {
  const scope = KEY_SCOPE[key];
  if (scope === "global") return "global";
  if (scope === "project") return "project";
  return "legacy";
}

function buildCache(
  layers: SettingsState["layers"],
  projectLanguage: string,
): Record<string, string> {
  const langDefaults = LANGUAGE_DEFAULT_OVERRIDES[projectLanguage] ?? {};
  // Precedence: DEFAULT < language override < legacy < project < global.
  return {
    ...DEFAULT_SETTINGS,
    ...langDefaults,
    ...layers.legacy,
    ...layers.project,
    ...layers.global,
  };
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  cache: { ...DEFAULT_SETTINGS },
  layers: { legacy: {}, project: {}, global: {} },
  projectLanguage: "ja",
  isLoaded: false,
  _timers: new Map(),
  _pending: new Map(),

  loadAll: async () => {
    const [legacyAll, workspaceModule, projectAll] = await Promise.all([
      api.getSettingsByPrefix(""),
      import("@/features/workspace/store"),
      api.getAllProjectSettings(PROJECT_ID),
    ]);
    const globalPrefs =
      workspaceModule.useWorkspaceStore.getState().globalSettings
        ?.userPreferences ?? {};
    set((s) => {
      const layers = {
        legacy: { ...legacyAll },
        project: { ...projectAll },
        global: { ...globalPrefs },
      };
      // デバウンス中の write-through を、まだ pending を反映していない
      // 永続ソースで上書きしない（設定ダイアログを開いた直後の loadAll で
      // 直前のトグルが巻き戻るレースの防止）。
      for (const [key, value] of s._pending) {
        layers[layerForKey(key)][key] = value;
      }
      return {
        layers,
        cache: buildCache(layers, s.projectLanguage),
        isLoaded: true,
        _timers: s._timers,
      };
    });
  },

  applyProjectLanguage: (language: string) => {
    set((s) => {
      if (language === s.projectLanguage) return s;
      return {
        projectLanguage: language,
        cache: buildCache(s.layers, language),
      };
    });
  },

  get: (key: string, defaultValue?: string) => {
    const state = get();
    const val = state.cache[key];
    if (val !== undefined) return val;
    if (defaultValue !== undefined) return defaultValue;
    return DEFAULT_SETTINGS[key] ?? "";
  },

  getNumber: (key: string, defaultValue?: number) => {
    const raw = get().get(key);
    const n = parseFloat(raw);
    if (!isNaN(n)) return n;
    return defaultValue ?? parseFloat(DEFAULT_SETTINGS[key] ?? "0") ?? 0;
  },

  getBoolean: (key: string, defaultValue?: boolean) => {
    const raw = get().get(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return defaultValue ?? DEFAULT_SETTINGS[key] === "true";
  },

  set: (key: string, value: string) => {
    // Write through to the matching layer so a later language switch (which
    // rebuilds the cache) preserves this explicit value.
    set((s) => {
      const which = layerForKey(key);
      const layers = {
        ...s.layers,
        [which]: { ...s.layers[which], [key]: value },
      };
      return { layers, cache: buildCache(layers, s.projectLanguage) };
    });

    const state = get();
    const existing = state._timers.get(key);
    if (existing) clearTimeout(existing);
    state._pending.set(key, value);

    const timer = setTimeout(async () => {
      try {
        await persistSetting(key, value);
      } catch (error) {
        console.error(`[settings] persist failed for ${key}`, error);
      } finally {
        state._timers.delete(key);
        // 後続の set で pending が更新されている場合は消さない
        // （その値は新しいタイマーが persist する）。
        if (state._pending.get(key) === value) state._pending.delete(key);
      }
    }, 300);

    state._timers.set(key, timer);
  },

  flushPending: async () => {
    const state = get();
    let firstError: unknown;
    for (const [key, timer] of state._timers.entries()) {
      clearTimeout(timer);
      // cache は loadAll で pending 未反映の値に巻き戻り得るため、
      // 「書くべき値」の正は _pending。
      const value = state._pending.get(key) ?? state.cache[key];
      if (value !== undefined) {
        try {
          await persistSetting(key, value);
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    state._timers.clear();
    state._pending.clear();
    if (firstError) throw firstError;
  },
}));
