// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "../extensions";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import { splitSentences } from "./sentenceSplit";
import {
  buildAdjacentUnitSwapTransaction,
  findUnitIndexAtFlatOffset,
} from "./reorderTransaction";

vi.mock("@/features/project/projectStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/project/projectStore")>();
  return {
    ...actual,
    getCurrentProjectLanguage: () => "en",
  };
});

function pressKey(
  ed: Editor,
  key: string,
  opts: KeyboardEventInit = {},
): boolean {
  const event = new KeyboardEvent("keydown", { key, ...opts });
  return (
    ed.view.someProp("handleKeyDown", (handler) => handler(ed.view, event)) ??
    false
  );
}

describe("ParagraphReorderExtension EN integration", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  it("swaps English sentences with Alt+Shift+Right", () => {
    const text = "She stood at the gate. He waved from afar.";
    editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
      content: `<p>${text}</p>`,
    });
    editor.commands.setTextSelection(5);
    expect(
      pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true }),
    ).toBe(true);
    expect(editor.state.doc.textContent).toBe(
      "He waved from afar. She stood at the gate.",
    );
  });

  it("preserves caret offset inside swapped English sentence", () => {
    const text = "She stood at the gate. He waved from afar.";
    editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
      content: `<p>${text}</p>`,
    });
    editor.commands.setTextSelection(8);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units = splitSentences(resolved.flat.text, "en");
    const unitIdx = findUnitIndexAtFlatOffset(units, 8);
    const result = buildAdjacentUnitSwapTransaction(
      editor.state,
      resolved,
      units,
      unitIdx,
      1,
      undefined,
      undefined,
      "en",
    );
    editor.view.dispatch(result!.tr);
    expect(editor.state.doc.textContent).toBe(
      "He waved from afar. She stood at the gate.",
    );
  });
});
