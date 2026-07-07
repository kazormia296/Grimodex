// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ParagraphReorderExtension } from "./ParagraphReorderExtension";
import { prefetchBunsetsuUnits, fetchBunsetsuUnits } from "./bunsetsuSegmenter";

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
  fetchBunsetsuUnits: vi.fn().mockResolvedValue([]),
  clearBunsetsuCache: vi.fn(),
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
  vi.mocked(prefetchBunsetsuUnits).mockClear();
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
  it("横書き: Alt+Shift+Right で次の文と swap", () => {
    pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("B。A。C。");
  });

  it("横書き: Alt+Shift+Left で前の文と swap", () => {
    editor.commands.setTextSelection(5);
    pressKey(editor, "ArrowLeft", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("A。C。B。");
  });

  it("横書き: 先頭 unit で Alt+Shift+Left は無変化", () => {
    editor.commands.setTextSelection(2);
    pressKey(editor, "ArrowLeft", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("A。B。C。");
  });

  it("横書き: Alt+Shift+↑/↓ は無視", () => {
    pressKey(editor, "ArrowDown", { altKey: true, shiftKey: true });
    pressKey(editor, "ArrowUp", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("A。B。C。");
  });

  it("縦書き: Alt+Shift+Down で次の文と swap", () => {
    h.verticalMode = true;
    pressKey(editor, "ArrowDown", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("B。A。C。");
  });

  it("縦書き: Alt+Shift+Up で前の文と swap", () => {
    h.verticalMode = true;
    editor.commands.setTextSelection(5);
    pressKey(editor, "ArrowUp", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("A。C。B。");
  });

  it("縦書き: Alt+Shift+←/→ は無視", () => {
    h.verticalMode = true;
    pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true });
    pressKey(editor, "ArrowLeft", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe("A。B。C。");
  });

  it("Alt+Shift+G で粒度を切り替える", () => {
    pressKey(editor, "G", { altKey: true, shiftKey: true });
    // plugin state は内部 — toggle が true を返すことだけ確認
    expect(pressKey(editor, "G", { altKey: true, shiftKey: true })).toBe(true);
  });

  it("文節 cache miss 時は文粒度で即時 swap し bunsetsu を prefetch する", () => {
    const text =
      "段落切替、段落内文、形態素解析による分節の入れ替えテストしています";
    editor.commands.setContent(`<p>${text}</p>`);
    editor.commands.setTextSelection(2);
    editor.commands.setReorderGranularity("bunsetsu");
    pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true });
    expect(editor.state.doc.textContent).toBe(
      "段落内文、段落切替、形態素解析による分節の入れ替えテストしています",
    );
    expect(fetchBunsetsuUnits).toHaveBeenCalled();
    expect(prefetchBunsetsuUnits).not.toHaveBeenCalled();
  });

  it("文節 cache miss かつ文 swap 不可のとき prefetch を開始する", () => {
    editor.commands.setContent("<p>単一unit</p>");
    editor.commands.setTextSelection(2);
    editor.commands.setReorderGranularity("bunsetsu");
    pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true });
    expect(prefetchBunsetsuUnits).toHaveBeenCalled();
  });
});
