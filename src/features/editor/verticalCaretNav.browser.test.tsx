/**
 * 縦書き (vertical-rl) の ArrowLeft/ArrowRight 列移動を実 Chromium で gate する。
 *
 * 背景バグ: 縦書きで Shift+Enter (hardBreak) の段落内改行を入れ、一行目末尾
 * (hardBreak 直前) で → (前の列 = 右) を押すと二行目行頭へ飛ぶ。原因は Chromium が
 * vertical-rl の hardBreak 境界で視覚的な列移動を適用できず横書き論理の前進 (pos+1)
 * にフォールバックすること。VerticalCaretNavExtension が ←/→ を consume して
 * ジオメトリ移動に置き換える。
 *
 * 注意: 合成 KeyboardEvent はネイティブのキャレット移動を起こさないため、この
 * スイートは「ネイティブバグの再現」ではなく「拡張が selection を正しい列へ動かす
 * / 誤前進を抑止する」ことを gate する。ネイティブ挙動の目視は Electron 開発版で行う。
 *
 * happy-dom は writing-mode のレイアウトも getBoundingClientRect の実寸も計算しない
 * ため browser test 必須 (CLAUDE.md のレイアウト/幾何ルール)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { fireEvent } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { VerticalCaretNavExtension } from "./VerticalCaretNavExtension";

// doc: <p>ABCDE<br>FGHIJ</p>
//   1 A 2 B 3 C 4 D 5 E 6 [br] 7 F 8 G 9 H 10 I 11 J 12
const POS_BEFORE_BR = 6; // 一行目末尾 (E の後、hardBreak の前)
const POS_AFTER_BR = 7; // 二行目行頭 (hardBreak の後、F の前)

let editor: Editor | null = null;
let host: HTMLElement | null = null;

function mount(vertical: boolean): Editor {
  host = document.createElement("div");
  if (vertical) host.className = "editor-vertical";
  // 縦書きの列がレイアウトされるだけの物理サイズを与える。
  host.style.cssText = "width: 400px; height: 400px; overflow: auto;";
  document.body.appendChild(host);
  editor = new Editor({
    element: host,
    extensions: [StarterKit, VerticalCaretNavExtension],
    content: "<p>ABCDE<br>FGHIJ</p>",
  });
  return editor;
}

function press(key: string, shift = false): void {
  fireEvent.keyDown(editor!.view.dom, { key, shiftKey: shift });
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
});

describe("縦書き列移動: hardBreak 境界のカーソル", () => {
  it("前提: 縦書きで vertical-rl が効き、二行目が別列 (左) に来る", () => {
    const ed = mount(true);
    expect(getComputedStyle(ed.view.dom).writingMode).toBe("vertical-rl");
    // hardBreak 前後の列 x を比較: 二行目 (F) は一行目 (E) より左
    const e = ed.view.coordsAtPos(POS_BEFORE_BR);
    const f = ed.view.coordsAtPos(POS_AFTER_BR);
    expect(f.left).toBeLessThan(e.left);
  });

  it("一行目末尾で → を押しても二行目行頭へ飛ばない (バグ回帰 gate)", () => {
    const ed = mount(true);
    ed.commands.setTextSelection(POS_BEFORE_BR);
    expect(ed.state.selection.from).toBe(POS_BEFORE_BR);
    press("ArrowRight"); // → = 前の列 (右)。一行目は最右列なので移動先なし。
    // ネイティブなら POS_AFTER_BR (行頭) へ誤前進する。拡張が抑止して据え置くこと。
    expect(ed.state.selection.from).not.toBe(POS_AFTER_BR);
    expect(ed.state.selection.from).toBe(POS_BEFORE_BR);
  });

  it("一行目末尾で ← を押すと二行目 (次の列) へ移動する", () => {
    const ed = mount(true);
    ed.commands.setTextSelection(POS_BEFORE_BR);
    press("ArrowLeft"); // ← = 次の列 (左) = 二行目
    expect(ed.state.selection.from).toBeGreaterThanOrEqual(POS_AFTER_BR);
    expect(ed.state.selection.from).toBeLessThanOrEqual(12);
  });

  it("二行目で → を押すと一行目 (前の列) へ戻る", () => {
    const ed = mount(true);
    ed.commands.setTextSelection(POS_AFTER_BR);
    press("ArrowRight"); // → = 前の列 (右) = 一行目
    expect(ed.state.selection.from).toBeLessThanOrEqual(POS_BEFORE_BR);
    expect(ed.state.selection.from).toBeGreaterThanOrEqual(1);
  });

  it("Shift+← は選択を二行目へ拡張する (anchor 据え置き)", () => {
    const ed = mount(true);
    ed.commands.setTextSelection(POS_BEFORE_BR);
    press("ArrowLeft", true);
    expect(ed.state.selection.empty).toBe(false);
    expect(ed.state.selection.anchor).toBe(POS_BEFORE_BR);
    expect(ed.state.selection.head).toBeGreaterThanOrEqual(POS_AFTER_BR);
  });
});

describe("横書き: 拡張は介入しない", () => {
  it("横書きでは → の keydown を consume せず selection を書き換えない", () => {
    const ed = mount(false);
    expect(getComputedStyle(ed.view.dom).writingMode).toBe("horizontal-tb");
    ed.commands.setTextSelection(POS_BEFORE_BR);
    press("ArrowRight");
    // 合成イベントはネイティブ移動を起こさない & 拡張は横書きで false を返すため
    // selection は据え置き (拡張が誤って縦書きロジックを適用していないことの gate)。
    expect(ed.state.selection.from).toBe(POS_BEFORE_BR);
  });
});
