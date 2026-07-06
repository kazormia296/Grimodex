import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KEY_SCOPE, DEFAULT_SETTINGS } from "./types";
import { useSettingsStore } from "./settingsStore";

// loadAll / persistSetting の到達先をモックし、「永続ソースはまだ pending を
// 反映していない」状況を再現できるようにする（設定ダイアログ巻き戻りレース）。
vi.mock("./api", () => ({
  getSettingsByPrefix: vi.fn(async () => ({})),
  getAllProjectSettings: vi.fn(async () => ({})),
  setProjectSetting: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
}));
const updateUserPreferenceSpy = vi.fn(async () => {});
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      globalSettings: { userPreferences: {} },
      updateUserPreference: updateUserPreferenceSpy,
    }),
  },
}));

// Routing correctness is guaranteed by KEY_SCOPE:
// - persistSetting() in settingsStore delegates to the correct store based on KEY_SCOPE
// - These tests validate the classification that drives routing decisions

describe("KEY_SCOPE routing invariants", () => {
  it("global and project scopes are disjoint", () => {
    const globalKeys = Object.entries(KEY_SCOPE)
      .filter(([, s]) => s === "global")
      .map(([k]) => k);
    const projectKeys = Object.entries(KEY_SCOPE)
      .filter(([, s]) => s === "project")
      .map(([k]) => k);
    expect(globalKeys.filter((k) => projectKeys.includes(k))).toEqual([]);
  });

  it("all DEFAULT_SETTINGS keys have a scope", () => {
    const missing = Object.keys(DEFAULT_SETTINGS).filter(
      (k) => KEY_SCOPE[k] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("user-preference keys are global", () => {
    const globals = [
      "editor.fontFamily",
      "editor.fontSize",
      "editor.lineHeight",
      "editor.maxContentWidth",
      "editor.autoSaveDelay",
      "editor.smoothCaret",
      "editor.cursorBlink",
      "display.showWordCount",
      "display.reduceMotion",
      "display.glassEffectEnabled",
      "display.glassTransparency",
      "display.glassBackdropGradient",
      "display.glassNativeVibrancy",
      "display.glassSurfaceShell",
      "display.glassSurfaceDock",
      "display.glassSurfacePanels",
      "display.glassSurfaceChat",
      "display.glassSurfacePopovers",
      "display.glassSurfaceEditorChrome",
      "keys.bindings",
      "data.autoBackup",
      "revision.autoInterval",
      "ai.modelWhitelist",
    ];
    for (const key of globals) {
      expect(KEY_SCOPE[key], `${key} should be global`).toBe("global");
    }
  });

  it("work-specific keys are per-project", () => {
    const projects = [
      "editor.targetCharCount",
      "editor.paragraphIndent",
      "editor.wordBreak",
      "editor.lineBreak",
      "editor.textAutospace",
      "export.format",
      "export.sceneDivider",
      "beat.injectIntoContext",
      "beat.inferRoles",
      "ai.contextBudget.l1",
      "ai.contextBudget.reserve",
      "tree.folderNaming",
      "tree.numberingScope",
      "timelapse.enabled",
    ];
    for (const key of projects) {
      expect(KEY_SCOPE[key], `${key} should be project`).toBe("project");
    }
  });

  it("card layout is the default; the glass effect defaults off (mutually exclusive)", () => {
    expect(DEFAULT_SETTINGS["display.cardLayout"]).toBe("true");
    expect(DEFAULT_SETTINGS["display.glassEffectEnabled"]).toBe("false");
    // Glass surface sub-settings still default ON so the effect is complete
    // once the master toggle is enabled.
    expect(DEFAULT_SETTINGS["display.glassTransparency"]).toBe("30");
    expect(DEFAULT_SETTINGS["display.glassBackdropGradient"]).toBe("true");
    expect(DEFAULT_SETTINGS["display.glassNativeVibrancy"]).toBe("true");
    expect(DEFAULT_SETTINGS["display.glassSurfaceShell"]).toBe("true");
    expect(DEFAULT_SETTINGS["display.glassSurfaceDock"]).toBe("true");
    expect(DEFAULT_SETTINGS["display.glassSurfacePanels"]).toBe("true");
    expect(DEFAULT_SETTINGS["display.glassSurfaceChat"]).toBe("true");
    expect(DEFAULT_SETTINGS["display.glassSurfacePopovers"]).toBe("true");
    expect(DEFAULT_SETTINGS["display.glassSurfaceEditorChrome"]).toBe("true");
  });
});

function resetStore(projectLanguage: string) {
  useSettingsStore.setState({
    layers: { legacy: {}, project: {}, global: {} },
    projectLanguage: "__init__",
    _timers: new Map(),
    _pending: new Map(),
  });
  // Force a cache rebuild for the requested language.
  useSettingsStore.getState().applyProjectLanguage(projectLanguage);
}

describe("settingsStore language-linked defaults", () => {
  beforeEach(() => resetStore("ja"));

  it("ja uses the baseline DEFAULT_SETTINGS", () => {
    const g = useSettingsStore.getState().get;
    expect(g("editor.lineHeight")).toBe(DEFAULT_SETTINGS["editor.lineHeight"]);
    expect(g("editor.fontFamily")).toBe(DEFAULT_SETTINGS["editor.fontFamily"]);
    expect(g("editor.smartQuotes")).toBe("false");
  });

  it("en overrides only unset keys", () => {
    useSettingsStore.getState().applyProjectLanguage("en");
    const s = useSettingsStore.getState();
    expect(s.get("editor.fontFamily")).toBe('"Literata"');
    expect(s.get("editor.lineHeight")).toBe("1.6");
    expect(s.getBoolean("editor.smartQuotes")).toBe(true);
    expect(s.getBoolean("editor.spellCheck")).toBe(true);
    expect(s.get("editor.paragraphIndent")).toBe("1");
    expect(s.get("editor.paragraphSpacing")).toBe("0");
    // A key with no override stays at the baseline default.
    expect(s.get("editor.fontSize")).toBe(DEFAULT_SETTINGS["editor.fontSize"]);
  });

  it("an explicit user value wins over the language default", () => {
    useSettingsStore.setState({
      layers: {
        legacy: {},
        project: {},
        global: { "editor.lineHeight": "3.0" },
      },
      projectLanguage: "__x__",
    });
    useSettingsStore.getState().applyProjectLanguage("en");
    expect(useSettingsStore.getState().get("editor.lineHeight")).toBe("3.0");
    useSettingsStore.getState().applyProjectLanguage("ja");
    expect(useSettingsStore.getState().get("editor.lineHeight")).toBe("3.0");
  });

  it("switching language back to ja restores baseline defaults", () => {
    useSettingsStore.getState().applyProjectLanguage("en");
    expect(useSettingsStore.getState().get("editor.lineHeight")).toBe("1.6");
    useSettingsStore.getState().applyProjectLanguage("ja");
    expect(useSettingsStore.getState().get("editor.lineHeight")).toBe("2.0");
  });

  describe("set() write-through survives a language switch", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it("keeps a freshly-set value after applyProjectLanguage", () => {
      resetStore("en");
      useSettingsStore.getState().set("editor.lineHeight", "2.5");
      expect(useSettingsStore.getState().get("editor.lineHeight")).toBe("2.5");
      // Language switch rebuilds the cache; the pending value must persist.
      useSettingsStore.getState().applyProjectLanguage("ja");
      expect(useSettingsStore.getState().get("editor.lineHeight")).toBe("2.5");
    });
  });
});

describe("デバウンス中の loadAll と pending の整合（設定ダイアログ巻き戻りレース）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateUserPreferenceSpy.mockClear();
    resetStore("ja");
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("loadAll が pending write-through を巻き戻さない", async () => {
    useSettingsStore.getState().set("display.layerComments", "true");
    expect(
      useSettingsStore.getState().getBoolean("display.layerComments", false),
    ).toBe(true);
    // 永続ソースは空（= pending 未反映）のまま loadAll。
    await useSettingsStore.getState().loadAll();
    expect(
      useSettingsStore.getState().getBoolean("display.layerComments", false),
    ).toBe(true);
  });

  it("flushPending は loadAll 後でも pending 値を永続化する", async () => {
    useSettingsStore.getState().set("display.layerComments", "true");
    await useSettingsStore.getState().loadAll();
    await useSettingsStore.getState().flushPending();
    expect(updateUserPreferenceSpy).toHaveBeenCalledWith(
      "display.layerComments",
      "true",
    );
    expect(useSettingsStore.getState()._pending.size).toBe(0);
  });

  it("デバウンスタイマー発火で pending が掃除され、set した値が永続化される", async () => {
    useSettingsStore.getState().set("display.layerComments", "true");
    await vi.advanceTimersByTimeAsync(300);
    expect(updateUserPreferenceSpy).toHaveBeenCalledWith(
      "display.layerComments",
      "true",
    );
    expect(useSettingsStore.getState()._pending.size).toBe(0);
  });

  it("連打時は最後の値だけが pending に残り persist される", async () => {
    useSettingsStore.getState().set("display.layerComments", "true");
    useSettingsStore.getState().set("display.layerComments", "false");
    await vi.advanceTimersByTimeAsync(300);
    expect(updateUserPreferenceSpy).toHaveBeenCalledTimes(1);
    expect(updateUserPreferenceSpy).toHaveBeenCalledWith(
      "display.layerComments",
      "false",
    );
  });
});
