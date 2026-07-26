// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Decoration } from "@tiptap/pm/view";
import { getEditorExtensions } from "../extensions";
import { reorderUiKey } from "./ReorderInteractionExtension";
import { useReorderModifierStore } from "./reorderModifierStore";
import { resolveSelectionUnits } from "./selectionUnit";
import type { ReorderUnit } from "./types";

vi.mock("@/features/project/projectStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/project/projectStore")>();
  return {
    ...actual,
    getCurrentProjectLanguage: () => "en",
  };
});

function makeEditor(html: string): Editor {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    content: html,
  });
}

function decos(editor: Editor): Decoration[] {
  return reorderUiKey.getState(editor.state)?.decorations.find() ?? [];
}

function classOf(d: Decoration): string {
  return (
    (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs
      ?.class ?? ""
  );
}

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

describe("ReorderInteractionExtension EN phrase", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    useReorderModifierStore.setState({ mode: "none", granularity: "sentence" });
  });

  it("altShift + phrase granularity shows phrase bands", () => {
    editor = makeEditor("<p>She stood at the gate.</p>");
    editor.commands.setReorderGranularity("phrase");
    editor.commands.setTextSelection(3);
    useReorderModifierStore.getState().setMode("altShift");
    editor.view.dispatch(editor.state.tr);

    const inline = decos(editor).filter((d) =>
      classOf(d).includes("reorder-unit"),
    );
    expect(inline.length).toBeGreaterThanOrEqual(3);
    expect(
      inline.every((d) => classOf(d).includes("reorder-unit-phrase")),
    ).toBe(true);
  });

  it("keeps phrase boundaries frozen across consecutive keyboard swaps", () => {
    editor = makeEditor("<p>She stood at the gate.</p>");
    editor.commands.setReorderGranularity("phrase");
    editor.commands.setTextSelection(5);
    useReorderModifierStore.getState().setMode("altShift");
    editor.view.dispatch(editor.state.tr);

    expect(
      reorderUiKey
        .getState(editor.state)
        ?.freeze?.units0.map((u: ReorderUnit) => u.surface),
    ).toEqual(["She", "stood", "at the gate."]);

    expect(
      pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true }),
    ).toBe(true);
    expect(editor.state.doc.textContent).toBe("She at the gate. stood");

    const ctx = resolveSelectionUnits(editor.state, "phrase", "en");
    expect(ctx?.units[ctx.unitIndex]?.surface).toBe("stood");

    expect(
      pressKey(editor, "ArrowLeft", { altKey: true, shiftKey: true }),
    ).toBe(true);
    expect(editor.state.doc.textContent).toBe("She stood at the gate.");
  });
});
