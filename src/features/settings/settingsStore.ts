import { create } from "zustand";
import * as api from "./api";
import { DEFAULT_SETTINGS, KEY_SCOPE } from "./types";
import { PROJECT_ID } from "@/features/project/constants";

interface SettingsState {
  cache: Record<string, string>;
  isLoaded: boolean;
  _timers: Map<string, ReturnType<typeof setTimeout>>;

  loadAll: () => Promise<void>;
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
    await useWorkspaceStore.getState().updateUserPreference(key, value);
  } else if (scope === "project") {
    await api.setProjectSetting(PROJECT_ID, key, value);
  } else {
    await api.setSetting(key, value);
  }
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  cache: { ...DEFAULT_SETTINGS },
  isLoaded: false,
  _timers: new Map(),

  loadAll: async () => {
    const [legacyAll, workspaceModule, projectAll] = await Promise.all([
      api.getSettingsByPrefix(""),
      import("@/features/workspace/store"),
      api.getAllProjectSettings(PROJECT_ID),
    ]);
    const globalPrefs =
      workspaceModule.useWorkspaceStore.getState().globalSettings
        ?.userPreferences ?? {};
    // Precedence: DEFAULT < app_settings(legacy) < project_settings < userPreferences
    set((s) => ({
      cache: {
        ...DEFAULT_SETTINGS,
        ...legacyAll,
        ...projectAll,
        ...globalPrefs,
      },
      isLoaded: true,
      _timers: s._timers,
    }));
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
    set((s) => ({ cache: { ...s.cache, [key]: value } }));

    const state = get();
    const existing = state._timers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      await persistSetting(key, value);
      state._timers.delete(key);
    }, 300);

    state._timers.set(key, timer);
  },

  flushPending: async () => {
    const state = get();
    for (const [key, timer] of state._timers.entries()) {
      clearTimeout(timer);
      const value = state.cache[key];
      if (value !== undefined) {
        await persistSetting(key, value);
      }
    }
    state._timers.clear();
  },
}));
