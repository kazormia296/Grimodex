import { beforeEach, describe, expect, it } from "vitest";
import { useCompactNavigationStore } from "./compactNavigationStore";

describe("compact navigation store", () => {
  beforeEach(() => {
    useCompactNavigationStore.getState().reset();
  });

  it("keeps a compact back stack separate from desktop layout state", () => {
    useCompactNavigationStore.getState().openSurface("codex");
    useCompactNavigationStore.getState().openSurface("chat");

    expect(useCompactNavigationStore.getState().activeSurface).toBe("chat");
    expect(useCompactNavigationStore.getState().backStack).toEqual([
      "editor",
      "codex",
    ]);
  });

  it("returns to the previous surface without mutating the desktop layout store", () => {
    useCompactNavigationStore.getState().openSurface("scenes");

    expect(useCompactNavigationStore.getState().goBack()).toBe(true);
    expect(useCompactNavigationStore.getState().activeSurface).toBe("editor");
    expect(useCompactNavigationStore.getState().goBack()).toBe(false);
  });

  it("supports responsive sheets as an independent navigation layer", () => {
    useCompactNavigationStore.getState().openSheet("scene-picker");
    expect(useCompactNavigationStore.getState().sheet).toEqual({
      kind: "scene-picker",
    });
    useCompactNavigationStore.getState().closeSheet();
    expect(useCompactNavigationStore.getState().sheet).toBeNull();
  });
});
