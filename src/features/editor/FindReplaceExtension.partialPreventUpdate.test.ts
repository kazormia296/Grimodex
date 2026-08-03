// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { FindReplaceExtension } from "./FindReplaceExtension";

describe("FindReplaceExtension partial preventUpdate transactions", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("maps the current hit instead of treating an inline rollback as a document load", () => {
    editor = new Editor({
      extensions: [StarterKit, FindReplaceExtension],
      content: "<p>one two one three one</p>",
    });
    editor.commands.setFindQuery("one");
    editor.commands.findNext();
    editor.commands.findNext();
    expect(editor.storage.findReplace.currentIndex).toBe(2);

    editor.view.dispatch(
      editor.state.tr.insertText("prefix ", 1).setMeta("preventUpdate", true),
    );

    expect(editor.storage.findReplace.matches).toHaveLength(3);
    expect(editor.storage.findReplace.currentIndex).toBe(2);
    expect(editor.view.dom.querySelectorAll(".find-current")).toHaveLength(1);
  });
});
