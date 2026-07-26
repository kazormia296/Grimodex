// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "../extensions";
import { useReorderModifierStore } from "./reorderModifierStore";

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

describe("ReorderInteractionExtension altShift undo batch", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    useReorderModifierStore.setState({ mode: "none", granularity: "sentence" });
  });

  it("groups swaps during Alt+Shift into a single undo step", () => {
    const original = "She stood at the gate.";
    editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
      content: `<p>${original}</p>`,
    });
    editor.commands.setReorderGranularity("phrase");
    editor.commands.setTextSelection(5);
    // happy-dom の focus() では view.hasFocus() が true にならないため、実アプリ
    // のバッチ経路（セッション生成→swap 除外→commit）を強制的に通す。
    editor.view.hasFocus = () => true;

    useReorderModifierStore.getState().setMode("altShift");
    expect(
      pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true }),
    ).toBe(true);
    expect(editor.state.doc.textContent).toBe("She at the gate. stood");

    useReorderModifierStore.getState().setMode("none");

    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe(original);
    expect(editor.commands.undo()).toBe(false);
  });

  it("requires only one undo after multiple swaps in one Alt+Shift hold", () => {
    const original = "AAA. BBB. CCC.";
    editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
      content: `<p>${original}</p>`,
    });
    editor.commands.setReorderGranularity("sentence");
    editor.commands.setTextSelection(1);
    editor.view.hasFocus = () => true;

    useReorderModifierStore.getState().setMode("altShift");
    expect(
      pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true }),
    ).toBe(true);
    expect(editor.state.doc.textContent).toBe("BBB. AAA. CCC.");
    expect(
      pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true }),
    ).toBe(true);
    expect(editor.state.doc.textContent).toBe("BBB. CCC. AAA.");

    useReorderModifierStore.getState().setMode("none");

    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe(original);
    expect(editor.commands.undo()).toBe(false);
  });

  it("undo only reverts the reordered range, not unrelated content", () => {
    // 段落2「Keep me.」は入替えと無関係。commit イベントが全文 replace だと、
    // 後続の（履歴外）変更を巻き込んで undo が全体を巻き戻す＝データ消失。
    // 差分範囲に限定した commit なら段落2の変更は保持される。
    editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
      content: `<p>AAA. BBB. CCC.</p><p>Keep me.</p>`,
    });
    editor.commands.setReorderGranularity("sentence");
    editor.commands.setTextSelection(1);
    editor.view.hasFocus = () => true;

    useReorderModifierStore.getState().setMode("altShift");
    expect(
      pressKey(editor, "ArrowRight", { altKey: true, shiftKey: true }),
    ).toBe(true);
    useReorderModifierStore.getState().setMode("none");
    expect(editor.state.doc.textContent).toBe("BBB. AAA. CCC.Keep me.");

    // 履歴外の別段落変更（live sync / 外部更新を模擬）。
    const endPos = editor.state.doc.content.size - 1;
    editor.view.dispatch(
      editor.state.tr.insertText("!", endPos).setMeta("addToHistory", false),
    );
    expect(editor.state.doc.textContent).toBe("BBB. AAA. CCC.Keep me.!");

    // reorder の undo は段落1だけを戻し、段落2の「!」は保持する。
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe("AAA. BBB. CCC.Keep me.!");
  });
});
