import { describe, it, expect, beforeEach } from "vitest";
import { useCursorSettingsStore } from "./cursorSettingsStore";

describe("useCursorSettingsStore", () => {
  beforeEach(() => {
    useCursorSettingsStore.setState({ cursorAnimation: true });
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
});
