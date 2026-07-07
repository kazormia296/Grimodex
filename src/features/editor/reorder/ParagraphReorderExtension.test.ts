// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ParagraphReorderExtension } from "./ParagraphReorderExtension";

const h = vi.hoisted(() => ({ verticalMode: false }));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      getBoolean: (key: string, def: boolean) =>
        key === "editor.verticalMode" ? h.verticalMode : def,
    }),
  },
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectLanguage: () => "ja",
}));

vi.mock("./bunsetsuSegmenter", () => ({
  getCachedBunsetsuUnits: () => null,
  prefetchBunsetsuUnits: vi.fn(),
  isJapanese: (language: string | undefined) =>
    !(language ?? "ja").toLowerCase().startsWith("en"),
}));

function pressKey(
  ed: Editor,
  key: string,
  opts: KeyboardEventInit = {},
): boolean {
  const event = new KeyboardEvent("keydown", { key, ...opts });
  return (
    ed.view.someProp("handleKeyDown", (handler) => handler(ed.view, event)) ??
    false
  );
}

let editor: Editor;

beforeEach(() => {
  h.verticalMode = false;
  editor = new Editor({
    extensions: [StarterKit, ParagraphReorderExtension],
    content: "<p>A。B。C。</p>",
  });
  editor.commands.setTextSelection(2);
});

afterEach(() => {
  editor.destroy();
});

describe("ParagraphReorderExtension", () => {
  it("Alt+Shift+Down で次の文と swap", () => {
    pressKey(editor, "ArrowDown", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("B。A。C。");
  });

  it("Alt+Shift+Up で前の文と swap", () => {
    editor.commands.setTextSelection(5);
    pressKey(editor, "ArrowUp", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("A。C。B。");
  });

  it("先頭 unit で Alt+Shift+Up は無変化", () => {
    editor.commands.setTextSelection(2);
    pressKey(editor, "ArrowUp", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("A。B。C。");
  });

  it("Alt+Shift+G で粒度を切り替える", () => {
    pressKey(editor, "G", { altKey: true, shiftKey: true });
    // plugin state は内部 — toggle が true を返すことだけ確認
    expect(pressKey(editor, "G", { altKey: true, shiftKey: true })).toBe(true);
  });

  it("縦書き: Alt+Shift+Right = 前へ swap", () => {
    h.verticalMode = true;
    editor.commands.setTextSelection(5);
    pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("A。C。B。");
  });
});
