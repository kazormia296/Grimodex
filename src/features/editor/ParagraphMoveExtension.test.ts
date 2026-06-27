// @vitest-environment happy-dom
//
// ParagraphMoveExtension の段落上下移動コマンドの単体テスト。gate しているのは
//   - moveLineUp / moveLineDown が最上位ブロックを隣と swap すること
//   - 端 (先頭/末尾) では false を返し変化させないこと
//   - 移動後もキャレットが「動かしたブロック」内に追従すること
// キーバインド (Alt+↑/↓) → コマンドの配線は addKeyboardShortcuts の 1 行委譲のため
// 非 gate (コマンド挙動を gate すれば十分)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ParagraphMoveExtension } from "./ParagraphMoveExtension";

// 縦書き判定 (editor.verticalMode) を制御するため settingsStore を最小モック。
const h = vi.hoisted(() => ({ verticalMode: false }));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      getBoolean: (key: string, def: boolean) =>
        key === "editor.verticalMode" ? h.verticalMode : def,
    }),
  },
}));

let editor: Editor;

/** keymap (addKeyboardShortcuts) を handleKeyDown 経由で発火させる。 */
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

function createEditor(content: string) {
  return new Editor({
    extensions: [StarterKit, ParagraphMoveExtension],
    content,
  });
}

/** 最上位ブロックのテキストを順に並べた配列。 */
function blockTexts(ed: Editor): string[] {
  const out: string[] = [];
  ed.state.doc.forEach((node) => out.push(node.textContent));
  return out;
}

/** 指定テキストの段落の途中にキャレットを置く。 */
function placeCaretIn(ed: Editor, text: string) {
  let pos: number | null = null;
  ed.state.doc.descendants((node, p) => {
    if (pos === null && node.isText && node.text === text) {
      pos = p + 1; // テキスト内 (先頭+1)
    }
  });
  if (pos === null) throw new Error(`no text node "${text}"`);
  ed.commands.setTextSelection(pos);
}

beforeEach(() => {
  h.verticalMode = false;
  editor = createEditor("<p>A</p><p>B</p><p>C</p>");
});

afterEach(() => {
  editor.destroy();
});

describe("ParagraphMoveExtension", () => {
  it("moveLineUp: 現在の段落を 1 つ上と入れ替える", () => {
    placeCaretIn(editor, "B");
    const ok = editor.commands.moveLineUp();
    expect(ok).toBe(true);
    expect(blockTexts(editor)).toEqual(["B", "A", "C"]);
  });

  it("moveLineDown: 現在の段落を 1 つ下と入れ替える", () => {
    placeCaretIn(editor, "B");
    const ok = editor.commands.moveLineDown();
    expect(ok).toBe(true);
    expect(blockTexts(editor)).toEqual(["A", "C", "B"]);
  });

  it("先頭ブロックで moveLineUp は false（変化なし）", () => {
    placeCaretIn(editor, "A");
    const ok = editor.commands.moveLineUp();
    expect(ok).toBe(false);
    expect(blockTexts(editor)).toEqual(["A", "B", "C"]);
  });

  it("末尾ブロックで moveLineDown は false（変化なし）", () => {
    placeCaretIn(editor, "C");
    const ok = editor.commands.moveLineDown();
    expect(ok).toBe(false);
    expect(blockTexts(editor)).toEqual(["A", "B", "C"]);
  });

  it("移動後もキャレットは動かしたブロック内に留まる", () => {
    placeCaretIn(editor, "B");
    editor.commands.moveLineUp();
    expect(editor.state.selection.$from.parent.textContent).toBe("B");
  });

  it("見出し等の異種ブロックも移動できる", () => {
    editor.destroy();
    editor = createEditor("<h2>Title</h2><p>Body</p>");
    placeCaretIn(editor, "Body");
    const ok = editor.commands.moveLineUp();
    expect(ok).toBe(true);
    // TipTap が末尾に空段落を補うことがあるため非空ブロックの順序で比較。
    expect(blockTexts(editor).filter(Boolean)).toEqual(["Body", "Title"]);
  });

  it("往復で元の順序に戻る（位置計算の対称性）", () => {
    placeCaretIn(editor, "A");
    editor.commands.moveLineDown(); // A,B,C -> B,A,C
    expect(blockTexts(editor)).toEqual(["B", "A", "C"]);
    editor.commands.moveLineUp(); // キャレットは A 内 -> B,A,C -> A,B,C
    expect(blockTexts(editor)).toEqual(["A", "B", "C"]);
  });

  it("異なるサイズのブロック間 swap でもキャレットのブロック内オフセットを保つ", () => {
    // 長い段落(9文字)と短い段落(1文字)。隣ブロックのサイズに依らず、移動した
    // ブロック内の相対オフセットが保たれることを検証 (currentStartAfter が隣の
    // nodeSize を正しく織り込む)。
    editor.destroy();
    editor = createEditor("<p>123456789</p><p>x</p>");
    editor.commands.setTextSelection(4); // 長い段落の text offset 3
    expect(editor.state.selection.$from.parentOffset).toBe(3);

    const ok = editor.commands.moveLineDown();
    expect(ok).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe("123456789");
    // 隣が短いブロックでもオフセットは 3 を維持 (キャレットは同じ文字間)。
    expect(editor.state.selection.$from.parentOffset).toBe(3);
  });

  it("複数ブロックに跨る選択 (A内〜B内) では false で無変化", () => {
    editor.commands.setTextSelection({ from: 1, to: 4 }); // A の中〜B の中
    const ok = editor.commands.moveLineUp();
    expect(ok).toBe(false);
    expect(blockTexts(editor)).toEqual(["A", "B", "C"]);
  });

  describe("writing-mode 別キーバインド", () => {
    it("横書き: Alt+↑/↓ で移動、Alt+→/← は無視", () => {
      placeCaretIn(editor, "B");
      pressKey(editor, "ArrowRight", { altKey: true }); // 横書きでは無効
      pressKey(editor, "ArrowLeft", { altKey: true }); // 横書きでは無効
      expect(blockTexts(editor)).toEqual(["A", "B", "C"]);

      pressKey(editor, "ArrowUp", { altKey: true }); // = moveLineUp
      expect(blockTexts(editor)).toEqual(["B", "A", "C"]);
    });

    it("縦書き: Alt+→ で前方(上)移動、Alt+↑/↓ は無視", () => {
      h.verticalMode = true;
      placeCaretIn(editor, "B");
      pressKey(editor, "ArrowUp", { altKey: true }); // 縦書きでは無効
      pressKey(editor, "ArrowDown", { altKey: true }); // 縦書きでは無効
      expect(blockTexts(editor)).toEqual(["A", "B", "C"]);

      pressKey(editor, "ArrowRight", { altKey: true }); // = moveLineUp (前方)
      expect(blockTexts(editor)).toEqual(["B", "A", "C"]);
    });

    it("縦書き: Alt+← で後方(下)移動", () => {
      h.verticalMode = true;
      placeCaretIn(editor, "B");
      pressKey(editor, "ArrowLeft", { altKey: true }); // = moveLineDown (後方)
      expect(blockTexts(editor)).toEqual(["A", "C", "B"]);
    });
  });
});
