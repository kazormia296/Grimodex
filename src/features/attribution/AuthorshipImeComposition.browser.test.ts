import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import { createAiEditedPlugin } from "./AiEditedPlugin";

const ORIGINAL =
  "群衆の中からも、歔欷《きょき》の声が聞えた。暴君ディオニスは、群衆の背後から二人の様を、まじまじと見つめていたが、やがて静かに二人に近づき、顔をあからめて、こう言った。";

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
          content: runs.map((run) => {
            const marks = run.authorship
              ? [
                  {
                    type: "authorship",
                    attrs: {
                      source: run.authorship.source ?? "unknown",
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

  it("preserves a selected mark when canceled preedit restores the text", async () => {
    vi.useFakeTimers();
    const editor = createEditor();
    const originalSelection = ORIGINAL.slice(1, 4);
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dispatch(
      editor.state.tr.insertText("かな", 2, 5).setMeta("composition", 1),
    );
    editor.view.dispatch(
      editor.state.tr
        .insertText(originalSelection, 2, 4)
        .setMeta("composition", 1),
    );
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionupdate", { data: "" }),
    );
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { data: "" }),
    );
    await vi.runAllTimersAsync();

    expect(editor.state.doc.textContent).toBe(ORIGINAL);
    expect(sources(editor)).toEqual(["unknown"]);
    editor.destroy();
  });

  it("makes changed text human when composition events expose empty data", async () => {
    vi.useFakeTimers();
    const editor = createEditor({ source: "ai" });
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dispatch(
      editor.state.tr.insertText("かな", 2, 5).setMeta("composition", 1),
    );
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionupdate", { data: "" }),
    );
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { data: "" }),
    );
    await vi.runAllTimersAsync();

    expect(editor.state.doc.textContent).toBe(
      `${ORIGINAL.slice(0, 1)}かな${ORIGINAL.slice(4)}`,
    );
    expect(sources(editor)).toEqual(["ai", null, "ai"]);
    editor.destroy();
  });

  it("makes identical selected AI text human when the IME commits it", async () => {
    vi.useFakeTimers();
    const editor = createEditor({ source: "ai" });
    const originalSelection = ORIGINAL.slice(1, 4);
    editor.commands.setTextSelection({ from: 2, to: 5 });

    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { data: originalSelection }),
    );
    editor.view.dispatch(
      editor.state.tr.insertText("かな", 2, 5).setMeta("composition", 1),
    );
    editor.view.dispatch(
      editor.state.tr
        .insertText(originalSelection, 2, 4)
        .setMeta("composition", 1),
    );
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { data: originalSelection }),
    );
    await vi.runAllTimersAsync();

    expect(editor.state.doc.textContent).toBe(ORIGINAL);
    expect(sources(editor)).toEqual(["ai", null, "ai"]);
    editor.destroy();
  });

  it("does not extend manualOverride at an IME boundary", async () => {
    vi.useFakeTimers();
    const editor = createEditor({ source: "ai", manualOverride: true });
    const from = ORIGINAL.length + 1;

    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dispatch(
      editor.state.tr.insertText("あ", from, from).setMeta("composition", 1),
    );
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.runAllTimersAsync();

    expect(editor.state.doc.textContent).toBe(`${ORIGINAL}あ`);
    expect(sources(editor)).toEqual(["ai", null]);
    editor.destroy();
  });

  it("does not preserve manualOverride across an unmarked replacement boundary", async () => {
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

    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dispatch(
      editor.state.tr.insertText("あ", 4, 8).setMeta("composition", 1),
    );
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { data: "あ" }),
    );
    await vi.runAllTimersAsync();

    expect(editor.state.doc.textContent).toBe("ABCあ");
    expect(sources(editor)).toEqual(["ai", null]);
    editor.destroy();
  });
});
