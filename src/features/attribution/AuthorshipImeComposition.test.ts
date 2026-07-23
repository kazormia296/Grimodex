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
  traceId?: string;
}

interface EditorTextRun {
  text: string;
  authorship?: EditorAuthorship;
}

function createEditorFromRuns(runs: EditorTextRun[]): Editor {
  const editor = new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: runs.map((run) => {
            const marks = run.authorship
              ? [
                  {
                    type: "authorship",
                    attrs: {
                      source: run.authorship.source ?? "unknown",
                      timestamp: "2026-07-23T00:00:00.000Z",
                      manualOverride: run.authorship.manualOverride ?? false,
                      traceId: run.authorship.traceId ?? null,
                    },
                  },
                ]
              : undefined;
            return {
              type: "text",
              text: run.text,
              marks,
            };
          }),
        },
      ],
    },
  });
  editor.registerPlugin(createAiEditedPlugin());
  editor.commands.setTextSelection(
    runs.reduce((length, run) => length + run.text.length, 1),
  );
  return editor;
}

function createEditor(authorship: EditorAuthorship = {}): Editor {
  return createEditorFromRuns([
    {
      text: ORIGINAL,
      authorship: {
        source: authorship.source ?? "unknown",
        manualOverride: authorship.manualOverride ?? false,
        traceId: authorship.traceId,
      },
    },
  ]);
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
  compositionId = 1,
) {
  editor.view.dispatch(
    editor.state.tr
      .insertText(text, from, to)
      .setMeta("composition", compositionId),
  );
}

function compositionEvent(
  type: "compositionstart" | "compositionupdate" | "compositionend",
  data = "",
): Event {
  const event = new Event(type);
  Object.defineProperty(event, "data", { value: data });
  return event;
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
    editor.view.dom.dispatchEvent(compositionEvent("compositionupdate"));
    editor.view.dom.dispatchEvent(compositionEvent("compositionend"));
    await vi.runAllTimersAsync();

    expect(editor.state.doc.textContent).toBe(ORIGINAL);
    expect(textRuns(editor)).toEqual([{ text: ORIGINAL, source: "unknown" }]);
    editor.destroy();
  });

  it("makes changed text human when composition events expose empty data", async () => {
    vi.useFakeTimers();
    const editor = createEditor({ source: "ai" });
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(compositionEvent("compositionstart"));
    replaceComposition(editor, 2, 5, "かな");
    editor.view.dom.dispatchEvent(compositionEvent("compositionupdate"));
    editor.view.dom.dispatchEvent(compositionEvent("compositionend"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL.slice(0, 1), source: "ai" },
      { text: "かな", source: null },
      { text: ORIGINAL.slice(4), source: "ai" },
    ]);
    editor.destroy();
  });

  it("preserves non-authorship marks on committed composition text", async () => {
    vi.useFakeTimers();
    const editor = createEditor({ source: "ai" });
    const boldType = editor.schema.marks["bold"];
    editor.view.dispatch(
      editor.state.tr.addMark(1, ORIGINAL.length + 1, boldType.create()),
    );
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(compositionEvent("compositionstart"));
    replaceComposition(editor, 2, 5, "かな");
    editor.view.dom.dispatchEvent(compositionEvent("compositionend", "かな"));
    await vi.runAllTimersAsync();

    let committedMarkNames: string[] | null = null;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === "かな") {
        committedMarkNames = node.marks.map((mark) => mark.type.name);
      }
    });
    expect(committedMarkNames).toEqual(["bold"]);
    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL.slice(0, 1), source: "ai" },
      { text: "かな", source: null },
      { text: ORIGINAL.slice(4), source: "ai" },
    ]);
    editor.destroy();
  });

  it("makes retyped identical selected AI text human", async () => {
    vi.useFakeTimers();
    const editor = createEditor({ source: "ai" });
    const originalSelection = ORIGINAL.slice(1, 4);
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(
      compositionEvent("compositionstart", originalSelection),
    );
    replaceComposition(editor, 2, 5, "かな");
    replaceComposition(editor, 2, 4, originalSelection);
    editor.view.dom.dispatchEvent(
      compositionEvent("compositionend", originalSelection),
    );
    await vi.runAllTimersAsync();

    expect(editor.state.doc.textContent).toBe(ORIGINAL);
    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL.slice(0, 1), source: "ai" },
      { text: originalSelection, source: null },
      { text: ORIGINAL.slice(4), source: "ai" },
    ]);

    editor.commands.undo();
    expect(textRuns(editor)).toEqual([{ text: ORIGINAL, source: "ai" }]);
    editor.commands.redo();
    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL.slice(0, 1), source: "ai" },
      { text: originalSelection, source: null },
      { text: ORIGINAL.slice(4), source: "ai" },
    ]);
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

  it("makes an IME replacement crossing a manualOverride boundary human", async () => {
    vi.useFakeTimers();
    const editor = createEditorFromRuns([
      {
        text: "ABCDE",
        authorship: {
          source: "ai",
          manualOverride: true,
          traceId: "manual-1",
        },
      },
      { text: "FG" },
    ]);
    editor.commands.setTextSelection({ from: 4, to: 8 });

    editor.view.dom.dispatchEvent(compositionEvent("compositionstart"));
    replaceComposition(editor, 4, 8, "あ");
    editor.view.dom.dispatchEvent(compositionEvent("compositionend", "あ"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([
      { text: "ABC", source: "ai" },
      { text: "あ", source: null },
    ]);
    editor.destroy();
  });

  it("makes an IME replacement across distinct manualOverride attrs human", async () => {
    vi.useFakeTimers();
    const editor = createEditorFromRuns([
      {
        text: "A",
        authorship: {
          source: "ai",
          manualOverride: true,
          traceId: "manual-1",
        },
      },
      {
        text: "B",
        authorship: {
          source: "ai",
          manualOverride: true,
          traceId: "manual-2",
        },
      },
    ]);
    editor.commands.setTextSelection({ from: 1, to: 3 });

    editor.view.dom.dispatchEvent(compositionEvent("compositionstart"));
    replaceComposition(editor, 1, 3, "あ");
    editor.view.dom.dispatchEvent(compositionEvent("compositionend", "あ"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([{ text: "あ", source: null }]);
    editor.destroy();
  });

  it("keeps manualOverride when the full replacement range has the exact mark", async () => {
    vi.useFakeTimers();
    const editor = createEditorFromRuns([
      {
        text: "ABCDE",
        authorship: {
          source: "ai",
          manualOverride: true,
          traceId: "manual-1",
        },
      },
    ]);
    editor.commands.setTextSelection({ from: 1, to: 6 });

    editor.view.dom.dispatchEvent(compositionEvent("compositionstart"));
    replaceComposition(editor, 1, 6, "あ");
    editor.view.dom.dispatchEvent(compositionEvent("compositionend", "あ"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([{ text: "あ", source: "ai" }]);
    editor.destroy();
  });

  it("captures the start selection from the first composition transaction oldState", async () => {
    vi.useFakeTimers();
    const editor = createEditor({ source: "ai" });
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(compositionEvent("compositionstart"));
    // ProseMirror flushes pending DOM state after custom compositionstart
    // handlers. Model that intervening flush by updating the selection before
    // the first transaction carrying the composition ID.
    editor.commands.setTextSelection({ from: 3, to: 4 });
    replaceComposition(editor, 3, 4, ORIGINAL.slice(2, 3));
    editor.view.dom.dispatchEvent(
      compositionEvent("compositionend", ORIGINAL.slice(2, 3)),
    );
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL.slice(0, 2), source: "ai" },
      { text: ORIGINAL.slice(2, 3), source: null },
      { text: ORIGINAL.slice(3), source: "ai" },
    ]);
    editor.destroy();
  });

  it("flushes a completed composition before the next one starts", async () => {
    vi.useFakeTimers();
    const editor = createEditor();
    const firstFrom = ORIGINAL.length + 1;

    editor.view.dom.dispatchEvent(compositionEvent("compositionstart"));
    replaceComposition(editor, firstFrom, firstFrom, "あ", 1);
    editor.view.dom.dispatchEvent(compositionEvent("compositionend", "あ"));

    const secondFrom = firstFrom + 1;
    editor.view.dom.dispatchEvent(compositionEvent("compositionstart"));
    replaceComposition(editor, secondFrom, secondFrom, "い", 2);
    editor.view.dom.dispatchEvent(compositionEvent("compositionend", "い"));
    await vi.runAllTimersAsync();

    expect(textRuns(editor)).toEqual([
      { text: ORIGINAL, source: "unknown" },
      { text: "あい", source: null },
    ]);
    editor.destroy();
  });
});
