// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { FindReplaceExtension } from "./FindReplaceExtension";

describe("FindReplaceExtension live match state", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("rebuilds hits after ordinary document edits and keeps the current hit", () => {
    editor = new Editor({
      extensions: [StarterKit, FindReplaceExtension],
      content: "<p>one two one</p>",
    });

    editor.commands.setFindQuery("one");
    editor.commands.findNext();
    expect(editor.storage.findReplace.matches).toHaveLength(2);
    expect(editor.storage.findReplace.currentIndex).toBe(1);

    editor.commands.insertContentAt(1, "one ");

    expect(editor.storage.findReplace.matches).toHaveLength(3);
    expect(editor.storage.findReplace.currentIndex).toBe(2);
    expect(
      editor.view.dom.querySelectorAll(".find-match, .find-current"),
    ).toHaveLength(3);
    expect(editor.view.dom.querySelectorAll(".find-current")).toHaveLength(1);
  });
});
