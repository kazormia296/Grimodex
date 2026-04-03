import { create } from "zustand";
import * as api from "./api";
import { DEFAULT_SETTINGS } from "./types";

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

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  cache: { ...DEFAULT_SETTINGS },
  isLoaded: false,
  _timers: new Map(),

  loadAll: async () => {
    const all = await api.getSettingsByPrefix("");
    set((s) => ({
      cache: { ...DEFAULT_SETTINGS, ...all },
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
    // Update cache immediately
    set((s) => ({ cache: { ...s.cache, [key]: value } }));

    // Debounced DB write (per key)
    const state = get();
    const existing = state._timers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      await api.setSetting(key, value);
      state._timers.delete(key);
    }, 300);

    state._timers.set(key, timer);
  },

  flushPending: async () => {
    const state = get();
    // Clear all pending timers and write immediately
    for (const [key, timer] of state._timers.entries()) {
      clearTimeout(timer);
      const value = state.cache[key];
      if (value !== undefined) {
        await api.setSetting(key, value);
      }
    }
    state._timers.clear();
  },
}));
