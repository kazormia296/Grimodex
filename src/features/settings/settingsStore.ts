import { create } from "zustand";
import * as api from "./api";
import {
  DEFAULT_SETTINGS,
  KEY_SCOPE,
  LANGUAGE_DEFAULT_OVERRIDES,
} from "./types";
import { PROJECT_ID } from "@/features/project/constants";
import { globalSettingsRepository } from "@/lib/globalSettings/repository";
import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";

type Layer = Record<string, string>;

interface PendingSetting {
  value: string;
  projectId: string;
}

export interface SettingsHydrationSnapshot {
  projectId: string;
  layers: { legacy: Layer; project: Layer; global: Layer };
}

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
  /** Project authority used for all project-scoped reads and delayed writes. */
  projectId: string;
  isLoaded: boolean;
  _timers: Map<string, ReturnType<typeof setTimeout>>;
  /**
   * デバウンス中でまだ persist されていない key→value。flushPending と
   * loadAll はここを正とする — cache は loadAll の再構築で pending 書き込みを
   * 失い得るため、cache から読み戻すと古い値を永続化してしまう。
   */
  _pending: Map<string, PendingSetting>;
  _inFlight: Map<string, Promise<void>>;

  loadAll: (projectId?: string) => Promise<void>;
  prepareHydration: (projectId: string) => Promise<SettingsHydrationSnapshot>;
  applyHydration: (snapshot: SettingsHydrationSnapshot) => void;
  /** Re-point the default fallback at the given language and rebuild. */
  applyProjectLanguage: (language: string) => void;
  get: (key: string, defaultValue?: string) => string;
  getNumber: (key: string, defaultValue?: number) => number;
  getBoolean: (key: string, defaultValue?: boolean) => boolean;
  set: (key: string, value: string) => void;
  flushPending: () => Promise<void>;
  discardPending: () => void;
}

// Route a key/value write to the correct persistent store.
async function persistSetting(
  key: string,
  pending: PendingSetting,
): Promise<void> {
  const scope = KEY_SCOPE[key];
  if (scope === "global") {
    await globalSettingsRepository.updateUserPreference(key, pending.value);
  } else if (scope === "project") {
    await api.setProjectSetting(pending.projectId, key, pending.value);
  } else {
    await api.setSetting(key, pending.value);
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

export async function prepareSettingsHydration(
  projectId: string,
): Promise<SettingsHydrationSnapshot> {
  const [legacyAll, globalSettings, projectAll] = await Promise.all([
    api.getSettingsByPrefix(""),
    globalSettingsRepository.read(),
    api.getAllProjectSettings(projectId),
  ]);
  return {
    projectId,
    layers: {
      legacy: { ...legacyAll },
      project: { ...projectAll },
      global: { ...(globalSettings.userPreferences ?? {}) },
    },
  };
}

async function drainPendingSetting(key: string): Promise<void> {
  const initialState = useSettingsStore.getState();
  const existing = initialState._inFlight.get(key);
  if (existing) {
    await existing;
    if (useSettingsStore.getState()._pending.has(key)) {
      await drainPendingSetting(key);
    }
    return;
  }

  const task = (async () => {
    while (true) {
      const pending = useSettingsStore.getState()._pending.get(key);
      if (!pending) return;
      await persistSetting(key, pending);
      const latest = useSettingsStore.getState()._pending.get(key);
      if (latest === pending) {
        useSettingsStore.getState()._pending.delete(key);
        return;
      }
    }
  })();
  initialState._inFlight.set(key, task);
  try {
    await task;
  } finally {
    if (useSettingsStore.getState()._inFlight.get(key) === task) {
      useSettingsStore.getState()._inFlight.delete(key);
    }
  }
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  cache: { ...DEFAULT_SETTINGS },
  layers: { legacy: {}, project: {}, global: {} },
  projectLanguage: "ja",
  projectId: PROJECT_ID,
  isLoaded: false,
  _timers: new Map(),
  _pending: new Map(),
  _inFlight: new Map(),

  prepareHydration: prepareSettingsHydration,

  applyHydration: (snapshot) => {
    set((s) => {
      const layers = {
        legacy: { ...snapshot.layers.legacy },
        project: { ...snapshot.layers.project },
        global: { ...snapshot.layers.global },
      };
      // デバウンス中の write-through を、まだ pending を反映していない
      // 永続ソースで上書きしない（設定ダイアログを開いた直後の loadAll で
      // 直前のトグルが巻き戻るレースの防止）。
      for (const [key, pending] of s._pending) {
        if (
          KEY_SCOPE[key] === "project" &&
          pending.projectId !== snapshot.projectId
        ) {
          continue;
        }
        layers[layerForKey(key)][key] = pending.value;
      }
      return {
        layers,
        cache: buildCache(layers, s.projectLanguage),
        projectId: snapshot.projectId,
        isLoaded: true,
        _timers: s._timers,
      };
    });
  },

  loadAll: async (projectId = get().projectId) => {
    const snapshot = await prepareSettingsHydration(projectId);
    get().applyHydration(snapshot);
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
    if (!canScheduleQuiescenceMutation()) return;
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
    state._pending.set(key, { value, projectId: state.projectId });

    const timer = setTimeout(() => {
      const latestState = useSettingsStore.getState();
      if (latestState._timers.get(key) === timer) {
        latestState._timers.delete(key);
      }
      void drainPendingSetting(key).catch((error) => {
        // Normal debounce is best-effort and retains the pending value. Strict
        // lifecycle flush retries it and propagates failure to veto teardown.
        console.error(`[settings] persist failed for ${key}`, error);
      });
    }, 300);

    state._timers.set(key, timer);
  },

  flushPending: async () => {
    for (const timer of get()._timers.values()) clearTimeout(timer);
    get()._timers.clear();

    while (get()._pending.size > 0 || get()._inFlight.size > 0) {
      const keys = new Set([
        ...get()._pending.keys(),
        ...get()._inFlight.keys(),
      ]);
      const results = await Promise.allSettled(
        [...keys].map((key) => drainPendingSetting(key)),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "One or more settings failed to persist",
        );
      }
    }
  },

  discardPending: () => {
    for (const timer of get()._timers.values()) clearTimeout(timer);
    get()._timers.clear();
    get()._pending.clear();
  },
}));

registerQuiescenceProvider({
  id: createQuiescenceProviderId("settings"),
  stage: "scoped-mutations",
  flush: () => useSettingsStore.getState().flushPending(),
  discard: () => useSettingsStore.getState().discardPending(),
  recovery: () =>
    [...useSettingsStore.getState()._pending.entries()].map(
      ([key, pending]) => ({
        kind: "setting",
        projectId: pending.projectId,
        key,
        value: pending.value,
      }),
    ),
});
