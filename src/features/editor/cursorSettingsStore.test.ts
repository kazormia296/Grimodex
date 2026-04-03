import { describe, it, expect, beforeEach, vi } from "vitest";
import { useCursorSettingsStore } from "./cursorSettingsStore";

// Mock settingsStore to avoid Tauri dependency
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      set: vi.fn(),
      getBoolean: (_key: string, def: boolean) => def,
    }),
  },
}));

describe("useCursorSettingsStore", () => {
  beforeEach(() => {
    useCursorSettingsStore.setState({
      cursorAnimation: true,
      focusMode: false,
      typewriterMode: false,
      showComments: false,
    });
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
});
