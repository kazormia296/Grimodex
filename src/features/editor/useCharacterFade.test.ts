// @vitest-environment happy-dom
//
// useCharacterFade の配線テスト。gate しているのは
//   - 縦書き (editor.verticalMode=true) でも characterFadeOut が実効 ON の
//     まま ghost が描かれること（旧実装は getter に !verticalMode を AND
//     して実効 OFF にしていた — スムースキャレット縦書き対応後の取り残し）
import { it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { useCharacterFade } from "./useCharacterFade";

const h = vi.hoisted(() => ({
  settings: {} as Record<string, boolean>,
}));

vi.mock("@/features/settings/settingsStore", () => {
  const state = {
    getBoolean: (key: string, def = false) => h.settings[key] ?? def,
  };
  const useSettingsStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state;
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});

let editor: Editor;

afterEach(() => {
  editor?.destroy();
  for (const el of document.querySelectorAll(".editor-fade-out-ghost")) {
    el.remove();
  }
});

it("縦書きでも削除ゴーストが描かれる（実効 OFF ゲートの再発防止）", () => {
  h.settings = {
    "editor.characterFadeOut": true,
    "editor.verticalMode": true,
  };
  editor = new Editor({
    extensions: [StarterKit],
    content: "<p>hello</p>",
  });
  renderHook(() => useCharacterFade(editor));

  const tr = editor.state.tr.delete(2, 3);
  editor.view.dispatch(tr);

  expect(document.querySelectorAll(".editor-fade-out-ghost").length).toBe(1);
});
