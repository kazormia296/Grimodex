// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Decoration } from "@tiptap/pm/view";
import { getEditorExtensions } from "../extensions";
import { reorderUiKey } from "./ReorderInteractionExtension";
import { useReorderModifierStore } from "./reorderModifierStore";

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

describe("ReorderInteractionExtension EN", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    useReorderModifierStore.setState({ mode: "none", granularity: "sentence" });
  });

  it("altShift shows sentence bands for English prose", () => {
    editor = makeEditor("<p>She stood at the gate. He waved from afar.</p>");
    editor.commands.setTextSelection(5);
    useReorderModifierStore.getState().setMode("altShift");
    editor.view.dispatch(editor.state.tr);

    const inline = decos(editor).filter((d) =>
      classOf(d).includes("reorder-unit"),
    );
    expect(inline.length).toBeGreaterThanOrEqual(2);
    expect(
      inline.every((d) => classOf(d).includes("reorder-unit-sentence")),
    ).toBe(true);
  });
});
