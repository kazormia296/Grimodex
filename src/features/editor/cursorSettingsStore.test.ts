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

const fullscreen = vi.hoisted(() => ({
  toggleFullscreenWindow: vi.fn<() => Promise<boolean>>(),
  isWindowFullscreen: vi.fn<() => Promise<boolean>>(),
}));

// Mock settingsStore to avoid Tauri dependency
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => settings,
  },
}));

vi.mock("@/lib/windowControls", () => ({
  toggleFullscreenWindow: fullscreen.toggleFullscreenWindow,
  isWindowFullscreen: fullscreen.isWindowFullscreen,
}));

describe("useCursorSettingsStore", () => {
  beforeEach(() => {
    settings.values.clear();
    settings.set.mockClear();
    settings.getBoolean.mockClear();
    fullscreen.toggleFullscreenWindow.mockReset();
    fullscreen.toggleFullscreenWindow.mockResolvedValue(false);
    fullscreen.isWindowFullscreen.mockReset();
    fullscreen.isWindowFullscreen.mockResolvedValue(false);
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

  it("toggles Zen without changing or persisting focus and typewriter state", () => {
    useCursorSettingsStore.setState({
      focusMode: true,
      typewriterMode: false,
    });

    useCursorSettingsStore.getState().toggleZenMode();
    expect(useCursorSettingsStore.getState()).toMatchObject({
      zenMode: true,
      focusMode: true,
      typewriterMode: false,
    });
    expect(settings.set).not.toHaveBeenCalledWith(
      "editor.zenMode",
      expect.any(String),
    );
    expect(settings.set).not.toHaveBeenCalledWith(
      "editor.focusMode",
      expect.any(String),
    );
    expect(settings.set).not.toHaveBeenCalledWith(
      "editor.typewriterMode",
      expect.any(String),
    );

    useCursorSettingsStore.getState().toggleZenMode();
    expect(useCursorSettingsStore.getState()).toMatchObject({
      zenMode: false,
      focusMode: true,
      typewriterMode: false,
    });
  });

  it("starts each session outside Zen while restoring focus and typewriter independently", () => {
    settings.values.set("editor.zenMode", "true");
    settings.values.set("editor.focusMode", "true");
    settings.values.set("editor.typewriterMode", "false");

    useCursorSettingsStore.getState().initFromSettings();

    expect(useCursorSettingsStore.getState()).toMatchObject({
      zenMode: false,
      focusMode: true,
      typewriterMode: false,
    });
  });

  it("keeps Zen active when focus or typewriter is changed directly", () => {
    useCursorSettingsStore.setState({
      zenMode: true,
      focusMode: true,
      typewriterMode: false,
    });

    useCursorSettingsStore.getState().toggleFocusMode();
    useCursorSettingsStore.getState().toggleTypewriterMode();

    expect(useCursorSettingsStore.getState()).toMatchObject({
      zenMode: true,
      focusMode: false,
      typewriterMode: true,
    });
    expect(settings.set).not.toHaveBeenCalledWith(
      "editor.zenMode",
      expect.any(String),
    );
  });

  it("updates fullscreen state from the native window result", async () => {
    fullscreen.toggleFullscreenWindow.mockResolvedValue(true);

    useCursorSettingsStore.getState().toggleFullscreenMode();

    await vi.waitFor(() => {
      expect(useCursorSettingsStore.getState().fullscreenMode).toBe(true);
    });
    expect(fullscreen.toggleFullscreenWindow).toHaveBeenCalledOnce();
  });

  it("resynchronizes fullscreen state after an OS-level change", async () => {
    fullscreen.isWindowFullscreen.mockResolvedValue(true);

    await useCursorSettingsStore.getState().syncFullscreenMode();

    expect(useCursorSettingsStore.getState().fullscreenMode).toBe(true);
    expect(fullscreen.isWindowFullscreen).toHaveBeenCalledOnce();
  });

  it("keeps the last confirmed fullscreen state when switching is rejected", async () => {
    fullscreen.toggleFullscreenWindow.mockRejectedValue(
      new Error("fullscreen denied"),
    );
    useCursorSettingsStore.setState({ fullscreenMode: true });

    useCursorSettingsStore.getState().toggleFullscreenMode();
    await vi.waitFor(() => {
      expect(fullscreen.toggleFullscreenWindow).toHaveBeenCalledOnce();
    });

    expect(useCursorSettingsStore.getState().fullscreenMode).toBe(true);
  });
});
