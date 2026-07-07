// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "../extensions";

vi.mock("@/features/project/projectStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/project/projectStore")>();
  return {
    ...actual,
    getCurrentProjectLanguage: () => "ja",
  };
});

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

describe("ParagraphReorderExtension integration", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  it("読点区切りの段落を Alt+Shift+Right で swap する", () => {
    const text =
      "段落切替、段落内文、形態素解析による分節の入れ替えテストしています";
    editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
      content: `<p>${text}</p>`,
    });
    editor.commands.setTextSelection(2);
    expect(
      pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true }),
    ).toBe(true);
    expect(editor.state.doc.textContent).toBe(
      "段落内文、段落切替、形態素解析による分節の入れ替えテストしています",
    );
  });
});
