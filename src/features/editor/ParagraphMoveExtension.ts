import { Extension, type RawCommands } from "@tiptap/core";
import { Fragment } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { useSettingsStore } from "@/features/settings/settingsStore";

/** 縦書き (editor.verticalMode = vertical-rl) かどうか。キーの向きを切り替える。 */
function isVerticalWriting(): boolean {
  return useSettingsStore.getState().getBoolean("editor.verticalMode", false);
}

/**
 * ParagraphMoveExtension — 現在の段落（最上位ブロック）を上下に入れ替えるアクション。
 *
 * VSCode の「行を上/下へ移動」(Alt+↑ / Alt+↓) 相当。本文は段落主体なので「行」=
 * 「カーソルのある最上位ブロック」を隣の最上位ブロックと swap する。見出し・引用・
 * シーンブレイク等の最上位ブロックも対象（= ブロック移動）。リスト/テーブル内に
 * カーソルがある場合はその最上位の親（リスト/テーブル全体）が動く点に注意 — 本文
 * 編集が主目的のため最上位ブロック単位の単純で予測可能な挙動を採る。
 *
 * 通常エディタと Linear モードは getEditorExtensions() を共有するため、この拡張を
 * そこに登録すれば両方に適用される。Alt+矢印は既存ショートカットと衝突しない
 * (ToolbarShortcutsExtension は Mod 系、mention/overlay は修飾なし矢印)。
 */
function moveTopLevelBlock(
  state: EditorState,
  tr: Transaction,
  dispatch: ((tr: Transaction) => void) | undefined,
  dir: -1 | 1,
): boolean {
  const { selection, doc } = state;
  const { $from, $to } = selection;
  if ($from.depth === 0) return false;
  const index = $from.index(0);
  // 複数の最上位ブロックに跨る選択は対象外（どのブロックを動かすか曖昧）。
  if ($to.index(0) !== index) return false;

  const swapWith = index + dir;
  if (swapWith < 0 || swapWith >= doc.childCount) return false;

  const lo = Math.min(index, swapWith);
  let start = 0;
  for (let i = 0; i < lo; i++) start += doc.child(i).nodeSize;
  const first = doc.child(lo);
  const second = doc.child(lo + 1);
  const end = start + first.nodeSize + second.nodeSize;

  if (!dispatch) return true;

  // キャレットのブロック内オフセットを保ったまま追従させるため、現在ブロックの
  // 「移動前の開始位置」と「移動後の開始位置」を求める。
  const currentStartBefore = index === lo ? start : start + first.nodeSize;
  const currentStartAfter = dir === 1 ? start + second.nodeSize : start;
  const caretOffset = selection.from - currentStartBefore;

  tr.replaceWith(start, end, Fragment.fromArray([second, first]));
  const newPos = Math.min(
    Math.max(currentStartAfter + caretOffset, 0),
    tr.doc.content.size,
  );
  tr.setSelection(TextSelection.near(tr.doc.resolve(newPos)));
  tr.scrollIntoView();
  dispatch(tr);
  return true;
}

export const ParagraphMoveExtension = Extension.create({
  name: "paragraphMove",

  addCommands() {
    return {
      moveLineUp:
        () =>
        ({ state, tr, dispatch }) =>
          moveTopLevelBlock(state, tr, dispatch, -1),
      moveLineDown:
        () =>
        ({ state, tr, dispatch }) =>
          moveTopLevelBlock(state, tr, dispatch, 1),
    } as Partial<RawCommands>;
  },

  addKeyboardShortcuts() {
    // 横書きは Alt+↑/↓。縦書き (vertical-rl) は行が左右に積まれるので Alt+←/→ に
    // する: → = 前の行 (上方向/前方) = moveLineUp、← = 次の行 (下方向/後方) =
    // moveLineDown (CursorOverlayPlugin の writing-mode 規約と一致)。モードに
    // 合わない向きのキーは false を返して素通しする。
    return {
      "Alt-ArrowUp": () =>
        !isVerticalWriting() && this.editor.commands.moveLineUp(),
      "Alt-ArrowDown": () =>
        !isVerticalWriting() && this.editor.commands.moveLineDown(),
      "Alt-ArrowRight": () =>
        isVerticalWriting() && this.editor.commands.moveLineUp(),
      "Alt-ArrowLeft": () =>
        isVerticalWriting() && this.editor.commands.moveLineDown(),
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphMove: {
      /** 現在の最上位ブロックを 1 つ上のブロックと入れ替える。 */
      moveLineUp: () => ReturnType;
      /** 現在の最上位ブロックを 1 つ下のブロックと入れ替える。 */
      moveLineDown: () => ReturnType;
    };
  }
}
