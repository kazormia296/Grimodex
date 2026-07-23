import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import { createAiEditedPlugin } from "./AiEditedPlugin";

const ORIGINAL =
  "群衆の中からも、歔欷《きょき》の声が聞えた。暴君ディオニスは、群衆の背後から二人の様を、まじまじと見つめていたが、やがて静かに二人に近づき、顔をあからめて、こう言った。";

function createEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, AuthorshipMark],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: ORIGINAL,
              marks: [
                {
                  type: "authorship",
                  attrs: { source: "unknown" },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  editor.registerPlugin(createAiEditedPlugin());
  editor.commands.setTextSelection(ORIGINAL.length + 1);
  return editor;
}

function sources(editor: Editor): Array<string | null> {
  const result: Array<string | null> = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((candidate) => {
      return candidate.type.name === "authorship";
    });
    result.push(mark ? (mark.attrs.source as string) : null);
  });
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("authorship IME composition in Chromium", () => {
  it("does not create a mark boundary beside the native preedit", async () => {
    vi.useFakeTimers();
    const editor = createEditor();
    const from = ORIGINAL.length + 1;

    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dispatch(
      editor.state.tr.insertText("ｓ", from, from).setMeta("composition", 1),
    );
    editor.view.dispatch(
      editor.state.tr
        .insertText("っｓ", from, from + 1)
        .setMeta("composition", 1),
    );
    editor.view.dispatch(
      editor.state.tr
        .insertText("っっｓ", from, from + 2)
        .setMeta("composition", 1),
    );

    const spans = editor.view.dom.querySelectorAll(
      'span[data-authorship="unknown"]',
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe(`${ORIGINAL}っっｓ`);
    expect(sources(editor)).toEqual(["unknown"]);

    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.runAllTimersAsync();

    expect(editor.state.doc.textContent).toBe(`${ORIGINAL}っっｓ`);
    expect(sources(editor)).toEqual(["unknown", null]);
    editor.destroy();
  });
});
