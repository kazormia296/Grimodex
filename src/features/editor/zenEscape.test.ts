// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Plugin } from "@tiptap/pm/state";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { handleZenEscapeKeyDown } from "./zenEscape";

const editorEscapeHandler = vi.fn(() => false);

const EditorEscapeExtension = Extension.create({
  name: "testEditorEscape",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(_view, event) {
            if (event.key !== "Escape") return false;
            return editorEscapeHandler();
          },
        },
      }),
    ];
  },
});

function dispatchEscape(
  editor: Editor,
  options: { isComposing?: boolean; keyCode?: number } = {},
) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  if (options.isComposing) {
    Object.defineProperty(event, "isComposing", { value: true });
  }
  Object.defineProperty(event, "keyCode", {
    value: options.keyCode ?? 27,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

describe("handleZenEscapeKeyDown", () => {
  let editor: Editor;

  beforeEach(() => {
    editorEscapeHandler.mockReset().mockReturnValue(false);
    useCursorSettingsStore.setState({ zenMode: true });
    editor = new Editor({
      extensions: [StarterKit, EditorEscapeExtension],
      editorProps: {
        handleKeyDown: handleZenEscapeKeyDown,
      },
      content: "<p>本文</p>",
    });
  });

  afterEach(() => {
    editor.destroy();
  });

  it("exits Zen before ProseMirror blanket-consumes an unhandled Escape", () => {
    const event = dispatchEscape(editor);

    expect(event.defaultPrevented).toBe(true);
    expect(editorEscapeHandler).toHaveBeenCalledOnce();
    expect(useCursorSettingsStore.getState().zenMode).toBe(false);
  });

  it("leaves Zen active when an editor overlay handles Escape first", () => {
    editorEscapeHandler.mockReturnValue(true);

    const event = dispatchEscape(editor);

    expect(event.defaultPrevented).toBe(true);
    expect(editorEscapeHandler).toHaveBeenCalledOnce();
    expect(useCursorSettingsStore.getState().zenMode).toBe(true);
  });

  it.each([
    ["composition", { isComposing: true }],
    ["IME process key", { keyCode: 229 }],
  ])("does not exit during %s", (_label, options) => {
    dispatchEscape(editor, options);

    expect(useCursorSettingsStore.getState().zenMode).toBe(true);
  });
});
