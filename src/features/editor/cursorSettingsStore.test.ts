import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorSettingsStore } from "./cursorSettingsStore";

const settings = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    set: vi.fn((key: string, value: string) => values.set(key, value)),
    getBoolean: vi.fn((key: string, def: boolean) => {
      const value = values.get(key);
      return value === undefined ? def : value === "true";
    }),
  };
});

// Mock settingsStore to avoid Tauri dependency
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => settings,
  },
}));

describe("useCursorSettingsStore", () => {
  beforeEach(() => {
    settings.values.clear();
    settings.set.mockClear();
    settings.getBoolean.mockClear();
    useCursorSettingsStore.setState({
      cursorAnimation: true,
      focusMode: false,
      typewriterMode: false,
      zenMode: false,
      fullscreenMode: false,
      showComments: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with cursor animation enabled", () => {
    expect(useCursorSettingsStore.getState().cursorAnimation).toBe(true);
  });

  it("toggles cursor animation", () => {
    useCursorSettingsStore.getState().toggleCursorAnimation();
    expect(useCursorSettingsStore.getState().cursorAnimation).toBe(false);

    useCursorSettingsStore.getState().toggleCursorAnimation();
    expect(useCursorSettingsStore.getState().cursorAnimation).toBe(true);
  });

  it("starts with focus mode disabled", () => {
    expect(useCursorSettingsStore.getState().focusMode).toBe(false);
  });

  it("toggles focus mode independently of cursor animation", () => {
    useCursorSettingsStore.getState().toggleFocusMode();
    expect(useCursorSettingsStore.getState().focusMode).toBe(true);
    expect(useCursorSettingsStore.getState().cursorAnimation).toBe(true);

    useCursorSettingsStore.getState().toggleFocusMode();
    expect(useCursorSettingsStore.getState().focusMode).toBe(false);
  });

  it("starts with typewriter mode disabled", () => {
    expect(useCursorSettingsStore.getState().typewriterMode).toBe(false);
  });

  it("toggles typewriter mode independently of focus mode", () => {
    useCursorSettingsStore.getState().toggleTypewriterMode();
    expect(useCursorSettingsStore.getState().typewriterMode).toBe(true);
    expect(useCursorSettingsStore.getState().focusMode).toBe(false);

    useCursorSettingsStore.getState().toggleTypewriterMode();
    expect(useCursorSettingsStore.getState().typewriterMode).toBe(false);
  });

  it("can enable focus mode and typewriter mode simultaneously", () => {
    useCursorSettingsStore.getState().toggleFocusMode();
    useCursorSettingsStore.getState().toggleTypewriterMode();
    expect(useCursorSettingsStore.getState().focusMode).toBe(true);
    expect(useCursorSettingsStore.getState().typewriterMode).toBe(true);
  });

  it("keeps Zen, focus, and typewriter state synchronized on toggle", () => {
    useCursorSettingsStore.getState().toggleZenMode();
    expect(useCursorSettingsStore.getState()).toMatchObject({
      zenMode: true,
      focusMode: true,
      typewriterMode: true,
    });
    expect(settings.values.get("editor.zenMode")).toBe("true");
    expect(settings.values.get("editor.focusMode")).toBe("true");
    expect(settings.values.get("editor.typewriterMode")).toBe("true");

    useCursorSettingsStore.getState().toggleZenMode();
    expect(useCursorSettingsStore.getState()).toMatchObject({
      zenMode: false,
      focusMode: false,
      typewriterMode: false,
    });
    expect(settings.values.get("editor.zenMode")).toBe("false");
    expect(settings.values.get("editor.focusMode")).toBe("false");
    expect(settings.values.get("editor.typewriterMode")).toBe("false");
  });

  it("restores Zen as an active composite mode from settings", () => {
    settings.values.set("editor.zenMode", "true");
    settings.values.set("editor.focusMode", "false");
    settings.values.set("editor.typewriterMode", "false");

    useCursorSettingsStore.getState().initFromSettings();

    expect(useCursorSettingsStore.getState()).toMatchObject({
      zenMode: true,
      focusMode: true,
      typewriterMode: true,
    });
  });

  it("exits Zen when either component mode is changed directly", () => {
    useCursorSettingsStore.setState({
      zenMode: true,
      focusMode: true,
      typewriterMode: true,
    });

    useCursorSettingsStore.getState().toggleFocusMode();

    expect(useCursorSettingsStore.getState()).toMatchObject({
      zenMode: false,
      focusMode: false,
      typewriterMode: true,
    });
    expect(settings.values.get("editor.zenMode")).toBe("false");
  });

  it("leaves fullscreen state unchanged until the browser confirms it", () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    vi.stubGlobal("document", {
      fullscreenElement: null,
      documentElement: { requestFullscreen },
    });

    useCursorSettingsStore.getState().toggleFullscreenMode();

    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(useCursorSettingsStore.getState().fullscreenMode).toBe(false);
  });

  it("keeps fullscreen active when exitFullscreen is rejected", async () => {
    const rejected = Promise.reject(new Error("fullscreen exit denied"));
    void rejected.catch(() => undefined);
    const exitFullscreen = vi.fn(() => rejected);
    vi.stubGlobal("document", {
      fullscreenElement: {},
      exitFullscreen,
      documentElement: {},
    });
    useCursorSettingsStore.setState({ fullscreenMode: true });

    useCursorSettingsStore.getState().toggleFullscreenMode();
    await Promise.resolve();

    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(useCursorSettingsStore.getState().fullscreenMode).toBe(true);
  });
});
