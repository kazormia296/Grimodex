// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { resetEditorHistory } from "./editorDocumentLoad";
import { FindReplaceExtension } from "./FindReplaceExtension";

describe("FindReplaceExtension document switching", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("resets to the first hit and restores decorations after a fresh-history load", () => {
    editor = new Editor({
      extensions: [StarterKit, FindReplaceExtension],
      content: "<p>old old</p>",
    });

    editor.commands.setFindQuery("old");
    editor.commands.findNext();
    expect(editor.storage.findReplace.currentIndex).toBe(1);

    editor.commands.setContent("<p>new old middle old</p>", {
      emitUpdate: false,
    });
    resetEditorHistory(editor.view);

    expect(editor.storage.findReplace.matches).toHaveLength(2);
    expect(editor.storage.findReplace.currentIndex).toBe(0);
    expect(
      editor.view.dom.querySelectorAll(".find-match, .find-current"),
    ).toHaveLength(2);
    expect(editor.view.dom.querySelectorAll(".find-current")).toHaveLength(1);
  });
});
