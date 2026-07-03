// @vitest-environment happy-dom
//
// useCursorOverlay の配線テスト。gate しているのは
//   - 設定 (editor.caretSlideDuration / caretSlideSnappiness) が :root の
//     CSS 変数 --caret-slide-* へ反映されること（.typewriter-cursor と
//     プレビューの .caret-preview-caret が参照する）
import { it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { useCursorOverlay } from "./useCursorOverlay";

const h = vi.hoisted(() => ({
  numbers: {} as Record<string, number>,
}));

vi.mock("@/features/settings/settingsStore", () => {
  const state = {
    getBoolean: (_key: string, def = false) => def,
    getNumber: (key: string, def = 0) => h.numbers[key] ?? def,
  };
  const useSettingsStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state;
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});

let editor: Editor;

afterEach(() => {
  editor?.destroy();
  document.documentElement.style.removeProperty("--caret-slide-duration");
  document.documentElement.style.removeProperty("--caret-slide-easing");
});

it("キャレットスライド設定が :root の CSS 変数へ反映される", () => {
  h.numbers = {
    "editor.caretSlideDuration": 140,
    "editor.caretSlideSnappiness": 100,
  };
  editor = new Editor({ extensions: [StarterKit], content: "<p>hello</p>" });
  renderHook(() => useCursorOverlay(editor));

  const rootStyle = document.documentElement.style;
  expect(rootStyle.getPropertyValue("--caret-slide-duration")).toBe("140ms");
  expect(rootStyle.getPropertyValue("--caret-slide-easing")).toContain(
    "cubic-bezier(",
  );
  expect(rootStyle.getPropertyValue("--caret-slide-easing")).not.toBe(
    "cubic-bezier(0.22, 1, 0.36, 1)",
  );
});
