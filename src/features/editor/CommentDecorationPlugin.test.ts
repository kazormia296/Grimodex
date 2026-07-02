// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { CommentMark } from "./CommentMark";
import {
  commentDecorationKey,
  createCommentDecorationPlugin,
  COMMENT_REBUILD_META,
} from "./CommentDecorationPlugin";
import { useCursorSettingsStore } from "./cursorSettingsStore";

function createTestEditor(content = "<p>下書きの本文テキスト</p>") {
  const editor = new Editor({
    extensions: [StarterKit, CommentMark],
    content,
  });
  editor.registerPlugin(createCommentDecorationPlugin());
  return editor;
}

function addComment(editor: Editor, from: number, to: number, text: string) {
  editor
    .chain()
    .setTextSelection({ from, to })
    .setMark("comment", { text, createdAt: "2026-07-01T00:00:00.000Z" })
    .command(({ tr }) => {
      tr.setMeta(COMMENT_REBUILD_META, true);
      return true;
    })
    .run();
}

// ProseMirror inline Decoration stores attrs in type.attrs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDecoAttrs(deco: any): Record<string, string> {
  return deco.type?.attrs ?? {};
}

describe("CommentDecorationPlugin SR attributes", () => {
  beforeEach(() => {
    useCursorSettingsStore.setState({ showComments: true });
  });

  it("exposes role=mark and aria-description with the comment body", () => {
    const editor = createTestEditor();
    addComment(editor, 1, 4, "ここ要確認");

    const decos = commentDecorationKey.getState(editor.state)!.find();
    expect(decos).toHaveLength(1);
    const attrs = getDecoAttrs(decos[0]);
    expect(attrs.class).toBe("comment-deco");
    expect(attrs.role).toBe("mark");
    expect(attrs["aria-description"]).toBe("ここ要確認");
    expect(attrs["data-comment-text"]).toBe("ここ要確認");
    editor.destroy();
  });

  it("omits aria-description when the comment body is empty", () => {
    const editor = createTestEditor();
    addComment(editor, 1, 4, "");

    const decos = commentDecorationKey.getState(editor.state)!.find();
    expect(decos).toHaveLength(1);
    const attrs = getDecoAttrs(decos[0]);
    expect(attrs.role).toBe("mark");
    expect("aria-description" in attrs).toBe(false);
    editor.destroy();
  });

  it("renders no decorations when showComments is off", () => {
    useCursorSettingsStore.setState({ showComments: false });
    const editor = createTestEditor();
    addComment(editor, 1, 4, "非表示");

    const decos = commentDecorationKey.getState(editor.state)!.find();
    expect(decos).toHaveLength(0);
    editor.destroy();
  });
});
