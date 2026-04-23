import { create } from "zustand";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { LintLanguage, RuleConfig } from "./types";

/**
 * Current on-disk schema version of `lint.config`. Bumped when we change
 * the structure (key renames, option-shape migrations). Adding a new
 * rule or new option key is NOT a version bump — those are absorbed by
 * the deep-merge with built-in defaults.
 */
export const LINT_CONFIG_SCHEMA_VERSION = 1;

export interface LangConfig {
  enabled: boolean;
}

export interface LintFullConfig {
  schemaVersion: number;
  enabled: boolean;
  languages: Record<LintLanguage, LangConfig>;
  rules: Record<string, RuleConfig>;
}

/**
 * Built-in defaults.
 *
 * Per the design document §既定 ON / 既定 OFF:
 * - 記号・約物（A 群）+ 一文長 → 既定 ON
 * - 文末単調（ja/sentence-ending-repeat）→ 既定 OFF
 * - それ以外の Phase 1 ルールは全て A 群相当 → ON
 */
export const BUILTIN_DEFAULT_CONFIG: LintFullConfig = {
  schemaVersion: LINT_CONFIG_SCHEMA_VERSION,
  enabled: true,
  languages: {
    ja: { enabled: true },
    en: { enabled: true },
  },
  rules: {
    "ja/consecutive-punct": { enabled: true },
    "ja/dash-single": { enabled: true },
    "ja/ellipsis-single": { enabled: true },
    "ja/ellipsis-odd": { enabled: true },
    "ja/halfwidth-kana": { enabled: true },
    "ja/halfwidth-fullwidth-mix": {
      enabled: true,
      options: { policy: "all-halfwidth" },
    },
    "ja/quote-period": {
      enabled: true,
      options: { policy: "strip" },
    },
    "ja/sentence-length": {
      enabled: true,
      options: { warnAt: 80, errorAt: 120 },
    },
    "ja/sentence-ending-repeat": { enabled: false },
    "en/straight-quotes": { enabled: true },
    "en/em-dash": { enabled: true },
    "en/ellipsis": { enabled: true },
    "en/double-space": { enabled: true },
  },
};

const SETTINGS_KEY = "lint.config";

interface LintConfigState {
  /**
   * Raw user layer loaded from the settings table. Keys absent here
   * fall back to `BUILTIN_DEFAULT_CONFIG` at read time.
   */
  userLayer: Partial<LintFullConfig>;
  isLoaded: boolean;

  load: () => void;

  /** Effective (built-in merged with user layer) full config. */
  getEffective: () => LintFullConfig;

  /** Subset Rust needs: enabled rules + their options/severity. */
  getWireConfig: () => { rules: Record<string, RuleConfig> };

  /** Update / reset helpers — all flush through settings store debounce. */
  setLinterEnabled: (enabled: boolean) => void;
  setLanguageEnabled: (lang: LintLanguage, enabled: boolean) => void;
  setRule: (ruleId: string, patch: Partial<RuleConfig>) => void;
  resetRule: (ruleId: string) => void;
  resetLanguage: (lang: LintLanguage) => void;
  resetAll: () => void;
}

function parseUserLayer(raw: string): Partial<LintFullConfig> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return migrate(parsed as Partial<LintFullConfig>);
    }
  } catch {
    // malformed — fall through to empty layer (treated as "no overrides")
  }
  return {};
}

function migrate(cfg: Partial<LintFullConfig>): Partial<LintFullConfig> {
  const current = cfg.schemaVersion ?? 1;
  // No migrations yet — kept as the hook for future schema bumps.
  return { ...cfg, schemaVersion: current };
}

function persist(userLayer: Partial<LintFullConfig>) {
  const stripped = { ...userLayer, schemaVersion: LINT_CONFIG_SCHEMA_VERSION };
  useSettingsStore.getState().set(SETTINGS_KEY, JSON.stringify(stripped));
}

export const useLintConfigStore = create<LintConfigState>()((set, get) => ({
  userLayer: {},
  isLoaded: false,

  load: () => {
    // Defer until settingsStore has loaded (call this after loadAll).
    const raw = useSettingsStore.getState().get(SETTINGS_KEY, "");
    set({ userLayer: parseUserLayer(raw), isLoaded: true });
  },

  getEffective: () => {
    const user = get().userLayer;
    return {
      schemaVersion: LINT_CONFIG_SCHEMA_VERSION,
      enabled: user.enabled ?? BUILTIN_DEFAULT_CONFIG.enabled,
      languages: {
        ja: {
          enabled:
            user.languages?.ja?.enabled ??
            BUILTIN_DEFAULT_CONFIG.languages.ja.enabled,
        },
        en: {
          enabled:
            user.languages?.en?.enabled ??
            BUILTIN_DEFAULT_CONFIG.languages.en.enabled,
        },
      },
      rules: mergeRules(user.rules),
    };
  },

  getWireConfig: () => {
    const eff = get().getEffective();
    return { rules: eff.rules };
  },

  setLinterEnabled: (enabled) => {
    const user = { ...get().userLayer, enabled };
    set({ userLayer: user });
    persist(user);
  },

  setLanguageEnabled: (lang, enabled) => {
    const user = get().userLayer;
    const next: Partial<LintFullConfig> = {
      ...user,
      languages: {
        ja: user.languages?.ja ?? BUILTIN_DEFAULT_CONFIG.languages.ja,
        en: user.languages?.en ?? BUILTIN_DEFAULT_CONFIG.languages.en,
        [lang]: { enabled },
      } as Record<LintLanguage, LangConfig>,
    };
    set({ userLayer: next });
    persist(next);
  },

  setRule: (ruleId, patch) => {
    const user = get().userLayer;
    const existing = user.rules?.[ruleId] ?? {};
    const mergedOptions = {
      ...(existing.options ?? {}),
      ...(patch.options ?? {}),
    };
    const nextRule: RuleConfig = {
      ...existing,
      ...patch,
      options:
        Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
    };
    const next: Partial<LintFullConfig> = {
      ...user,
      rules: { ...(user.rules ?? {}), [ruleId]: nextRule },
    };
    set({ userLayer: next });
    persist(next);
  },

  resetRule: (ruleId) => {
    const user = get().userLayer;
    if (!user.rules || !(ruleId in user.rules)) return;
    const { [ruleId]: _removed, ...rest } = user.rules;
    const next: Partial<LintFullConfig> = { ...user, rules: rest };
    set({ userLayer: next });
    persist(next);
  },

  resetLanguage: (lang) => {
    const user = get().userLayer;
    const nextRules = { ...(user.rules ?? {}) };
    for (const key of Object.keys(nextRules)) {
      if (key.startsWith(`${lang}/`)) delete nextRules[key];
    }
    const nextLanguages = { ...(user.languages ?? {}) } as Record<
      LintLanguage,
      LangConfig
    >;
    delete (nextLanguages as Record<string, LangConfig>)[lang];
    const next: Partial<LintFullConfig> = {
      ...user,
      rules: nextRules,
      languages: nextLanguages,
    };
    set({ userLayer: next });
    persist(next);
  },

  resetAll: () => {
    set({ userLayer: {} });
    persist({});
  },
}));

function mergeRules(
  user: Record<string, RuleConfig> | undefined,
): Record<string, RuleConfig> {
  const out: Record<string, RuleConfig> = {};
  for (const [id, def] of Object.entries(BUILTIN_DEFAULT_CONFIG.rules)) {
    const u = user?.[id];
    out[id] = {
      enabled: u?.enabled ?? def.enabled ?? true,
      severity: u?.severity ?? def.severity,
      options: { ...(def.options ?? {}), ...(u?.options ?? {}) },
    };
  }
  // Include user-declared rules not in defaults (forward compatibility).
  if (user) {
    for (const [id, cfg] of Object.entries(user)) {
      if (!(id in out)) out[id] = cfg;
    }
  }
  return out;
}
