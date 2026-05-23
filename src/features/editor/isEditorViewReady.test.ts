import { describe, expect, it } from "vitest";
import { isEditorViewReady } from "./isEditorViewReady";

describe("isEditorViewReady", () => {
  it("returns false for null/undefined", () => {
    expect(isEditorViewReady(null)).toBe(false);
    expect(isEditorViewReady(undefined)).toBe(false);
  });

  it("returns false when view.dom throws (not mounted)", () => {
    const editor = {
      isDestroyed: false,
      get view() {
        throw new Error("view not available");
      },
    };
    expect(isEditorViewReady(editor as never)).toBe(false);
  });

  it("returns true when view.dom is accessible", () => {
    const editor = {
      isDestroyed: false,
      view: { dom: {} },
    };
    expect(isEditorViewReady(editor as never)).toBe(true);
  });

  it("returns false for destroyed editors", () => {
    const editor = {
      isDestroyed: true,
      view: { dom: {} },
    };
    expect(isEditorViewReady(editor as never)).toBe(false);
  });
});
