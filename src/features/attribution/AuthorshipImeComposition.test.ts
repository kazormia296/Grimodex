// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import { createAiEditedPlugin } from "./AiEditedPlugin";

const ORIGINAL =
  "群衆の中からも、歔欷《きょき》の声が聞えた。暴君ディオニスは、群衆の背後から二人の様を、まじまじと見つめていたが、やがて静かに二人に近づき、顔をあからめて、こう言った。";

interface TextRun {
  text: string;
  source: string | null;
}

interface EditorAuthorship {
  source?: "ai" | "unknown";
  manualOverride?: boolean;
}

function createEditor(authorship: EditorAuthorship = {}): Editor {
  const editor = new Editor({
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
                  attrs: {
                    source: authorship.source ?? "unknown",
                    timestamp: "2026-07-23T00:00:00.000Z",
                    manualOverride: authorship.manualOverride ?? false,
                  },
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

function textRuns(editor: Editor): TextRun[] {
  const runs: TextRun[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((candidate) => {
      return candidate.type.name === "authorship";
    });
    runs.push({
      text: node.text ?? "",
      source: mark ? (mark.attrs.source as string) : null,
    });
  });
  return runs;
}

function replaceComposition(
  editor: Editor,
  from: number,
  to: number,
  text: string,
) {
  editor.view.dispatch(
    editor.state.tr.insertText(text, from, to).setMeta("composition", 1),
  );
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("authorship mark during IME composition", () => {
  it("keeps the preedit in one span, then makes only the committed text human", async () => {
    vi.useFakeTimers();
    const editor = createEditor();
    const compositionFrom = ORIGINAL.length + 1;

    editor.view.dom.dispatchEvent(new Event("compositionstart"));
    replaceComposition(editor, compositionFrom, compositionFrom, "ｓ");
    replaceComposition(editor, compositionFrom, compositionFrom + 1, "っｓ");
    replaceComposition(editor, compositionFrom, compositionFrom + 2, "っっｓ");

    // Chromium must see one stable marked text node while the native IME owns
    // the composition. A boundary here can make getTargetRanges() jump back to
    // the beginning of the paragraph and turn the next update into data loss.
    expect(textRuns(editor)).toEqual([
      { text: `${ORIGINAL}っっｓ`, source: "unknown" },
    ]);
    const spans = editor.view.dom.querySelectorAll(
      'span[data-authorship="unknown"]',
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe(`${ORIGINAL}っっｓ`);

    editor.view.dom.dispatchEvent(new Event("compositionend"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL, source: "unknown" },
      { text: "っっｓ", source: null },
    ]);

    // Attribution cleanup must remain in the same history event as the IME
    // edit, otherwise redo could restore the committed text as "unknown".
    editor.commands.undo();
    expect(textRuns(editor)).toEqual([{ text: ORIGINAL, source: "unknown" }]);
    editor.commands.redo();
    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL, source: "unknown" },
      { text: "っっｓ", source: null },
    ]);

    editor.destroy();
  });

  it("keeps the selected attribution when composition is canceled", async () => {
    vi.useFakeTimers();
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(new Event("compositionstart"));
    editor.view.dom.dispatchEvent(new Event("compositionend"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([{ text: ORIGINAL, source: "unknown" }]);
    editor.destroy();
  });

  it("keeps attribution when canceled preedit restores selected text", async () => {
    vi.useFakeTimers();
    const editor = createEditor();
    const originalSelection = ORIGINAL.slice(1, 4);
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(new Event("compositionstart"));
    replaceComposition(editor, 2, 5, "かな");
    replaceComposition(editor, 2, 4, originalSelection);
    editor.view.dom.dispatchEvent(new Event("compositionend"));
    await vi.runAllTimersAsync();

    expect(editor.state.doc.textContent).toBe(ORIGINAL);
    expect(textRuns(editor)).toEqual([{ text: ORIGINAL, source: "unknown" }]);
    editor.destroy();
  });

  it("makes only the committed replacement human", async () => {
    vi.useFakeTimers();
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(new Event("compositionstart"));
    replaceComposition(editor, 2, 5, "かな");
    editor.view.dom.dispatchEvent(new Event("compositionend"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL.slice(0, 1), source: "unknown" },
      { text: "かな", source: null },
      { text: ORIGINAL.slice(4), source: "unknown" },
    ]);
    editor.destroy();
  });

  it("does not extend manualOverride at an IME boundary", async () => {
    vi.useFakeTimers();
    const editor = createEditor({ source: "ai", manualOverride: true });
    const compositionFrom = ORIGINAL.length + 1;

    editor.view.dom.dispatchEvent(new Event("compositionstart"));
    replaceComposition(editor, compositionFrom, compositionFrom, "あ");
    editor.view.dom.dispatchEvent(new Event("compositionend"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL, source: "ai" },
      { text: "あ", source: null },
    ]);
    editor.destroy();
  });

  it("keeps manualOverride for IME edits inside the marked run", async () => {
    vi.useFakeTimers();
    const editor = createEditor({ source: "ai", manualOverride: true });
    editor.commands.setTextSelection(5);

    editor.view.dom.dispatchEvent(new Event("compositionstart"));
    replaceComposition(editor, 5, 5, "あ");
    editor.view.dom.dispatchEvent(new Event("compositionend"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([
      {
        text: `${ORIGINAL.slice(0, 4)}あ${ORIGINAL.slice(4)}`,
        source: "ai",
      },
    ]);
    editor.destroy();
  });
});
