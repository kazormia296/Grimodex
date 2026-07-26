// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { undoDepth } from "@tiptap/pm/history";
import { getEditorExtensions } from "./extensions";
import {
  resetEditorHistory,
  setEditorContentFreshHistory,
} from "./editorDocumentLoad";

describe("editorDocumentLoad", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  it("resetEditorHistory clears undo stack while keeping doc", () => {
    editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
      content: "<p>Scene A</p>",
    });
    editor.commands.insertContent(" edited");
    expect(undoDepth(editor.state)).toBeGreaterThan(0);
    const textBefore = editor.state.doc.textContent;

    resetEditorHistory(editor.view);

    expect(editor.state.doc.textContent).toBe(textBefore);
    expect(undoDepth(editor.state)).toBe(0);
    expect(editor.commands.undo()).toBe(false);
  });

  it("setEditorContentFreshHistory prevents undo from restoring previous scene", () => {
    editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
      content: "<p>Scene A</p>",
    });
    editor.commands.insertContent(" change");

    setEditorContentFreshHistory(editor, "<p>Scene B</p>", {
      emitUpdate: false,
    });
    expect(editor.state.doc.textContent).toBe("Scene B");

    expect(editor.commands.undo()).toBe(false);
    expect(editor.state.doc.textContent).toBe("Scene B");
  });
});
