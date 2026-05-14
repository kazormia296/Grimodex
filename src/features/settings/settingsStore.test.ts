import { describe, it, expect } from "vitest";
import { KEY_SCOPE, DEFAULT_SETTINGS } from "./types";

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
      "export.format",
      "export.sceneDivider",
      "beat.injectIntoContext",
      "beat.inferRoles",
      "ai.contextBudget.l1",
      "ai.contextBudget.reserve",
      "tree.folderNaming",
      "tree.numberingScope",
    ];
    for (const key of projects) {
      expect(KEY_SCOPE[key], `${key} should be project`).toBe("project");
    }
  });

  it("glass settings default to on with all surfaces available", () => {
    expect(DEFAULT_SETTINGS["display.glassEffectEnabled"]).toBe("true");
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
