import { Extension } from "@tiptap/core";
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  NodeSelection,
} from "prosemirror-state";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

const pluginKey = new PluginKey("inlineAtomNavigation");

/**
 * テキストブロックノードがインラインatomの子（ルビ等）を持つか判定する。
 */
export function textblockHasInlineAtom(node: ProseMirrorNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child.isText && child.isAtom && child.isInline) return true;
  }
  return false;
}

/**
 * 視覚行の端位置を coordsAtPos の bottom 座標で走査して返す。
 *
 * bottom を基準にする理由: ルビの <rt> アノテーションが top を押し上げるため
 * top 比較ではルビ前後で行変更と誤検出される。bottom は同一ベースライン上で安定。
 *
 * atom ノード付近で coordsAtPos が例外を投げる場合はその位置をスキップし
 * （同一行と見なして）走査を続行する。
 */
export function findVisualLineEdge(
  view: EditorView,
  startPos: number,
  dir: "left" | "right",
): number {
  const $start = view.state.doc.resolve(startPos);
  const parentStart = $start.start();
  const parentEnd = $start.end();

  const startSide =
    dir === "right"
      ? startPos === parentStart
        ? 1
        : -1
      : startPos === parentEnd
        ? -1
        : 1;

  let refBottom: number;
  try {
    refBottom = view.coordsAtPos(startPos, startSide).bottom;
  } catch {
    // 開始位置すら測定不能ならテキストブロック端にフォールバック
    return dir === "right" ? parentEnd : parentStart;
  }

  const step = dir === "right" ? 1 : -1;
  const checkSide = dir === "right" ? -1 : 1;
  const limit = dir === "right" ? parentEnd : parentStart;

  let bestPos = startPos;
  let pos = startPos + step;

  while (dir === "right" ? pos <= limit : pos >= limit) {
    let bottom: number;
    try {
      bottom = view.coordsAtPos(pos, checkSide).bottom;
    } catch {
      // atom 付近で座標取得不能 → 同一行と仮定してスキップ
      bestPos = pos;
      pos += step;
      continue;
    }
    // bottom が 8px 以上ずれたら別の視覚行
    if (Math.abs(bottom - refBottom) >= 8) break;
    bestPos = pos;
    pos += step;
  }

  return bestPos;
}

/** End/Home キー処理。視覚行の端に移動する。 */
function handleEndHome(
  view: EditorView,
  dir: "left" | "right",
  extending: boolean,
): boolean {
  const { state } = view;
  const { selection } = state;

  let headPos: number;
  let anchorPos: number;

  if (selection instanceof TextSelection) {
    headPos = selection.$head.pos;
    anchorPos = selection.$anchor.pos;
    if (!selection.$head.parent.isTextblock) return false;
  } else if (selection instanceof NodeSelection) {
    headPos = dir === "right" ? selection.$to.pos : selection.$from.pos;
    anchorPos = extending ? selection.$from.pos : headPos;
    const $pos = state.doc.resolve(headPos);
    if (!$pos.parent.isTextblock) return false;
  } else {
    return false;
  }

  const targetPos = findVisualLineEdge(view, headPos, dir);

  if (targetPos !== headPos) {
    const newSel = extending
      ? TextSelection.create(state.doc, anchorPos, targetPos)
      : TextSelection.create(state.doc, targetPos);
    view.dispatch(state.tr.setSelection(newSel).scrollIntoView());
  }
  // 既に行端でもブラウザのネイティブ処理を防ぐため true を返す
  return true;
}

/** Ctrl+Home/End キー処理。ドキュメントの先頭/末尾に移動する。 */
function handleCtrlEndHome(
  view: EditorView,
  dir: "left" | "right",
  extending: boolean,
): boolean {
  const { state } = view;
  const { doc } = state;

  // ドキュメント先頭: コンテンツ開始位置、末尾: コンテンツ終了位置
  const targetPos =
    dir === "right" ? Selection.atEnd(doc).to : Selection.atStart(doc).from;

  const { selection } = state;
  const anchorPos =
    selection instanceof TextSelection
      ? selection.$anchor.pos
      : selection instanceof NodeSelection
        ? selection.$from.pos
        : targetPos;

  const newSel = extending
    ? TextSelection.create(doc, anchorPos, targetPos)
    : TextSelection.create(doc, targetPos);
  view.dispatch(state.tr.setSelection(newSel).scrollIntoView());
  return true;
}

/** 矢印キー処理。atom含有テキストブロック内でブラウザ処理をバイパスする。 */
function handleArrow(
  view: EditorView,
  dir: 1 | -1,
  extending: boolean,
): boolean {
  const { state } = view;
  const { selection } = state;

  // NodeSelection の場合は ProseMirror の selectHorizontally に委譲
  if (selection instanceof NodeSelection) return false;
  if (!(selection instanceof TextSelection)) return false;

  // 範囲選択の解消は ProseMirror に委譲
  if (!extending && !selection.empty) return false;

  const { $head } = selection;
  if (!$head.parent.isTextblock) return false;
  if (!textblockHasInlineAtom($head.parent)) return false;

  // テキストブロック端 → ProseMirror にブロック間移動を委譲
  if (dir > 0 && $head.parentOffset >= $head.parent.content.size) return false;
  if (dir < 0 && $head.parentOffset <= 0) return false;

  // textOffset===0 で隣接ノードがatomの場合 → ProseMirror の NodeSelection 生成に委譲
  if ($head.textOffset === 0) {
    const adjacent = dir > 0 ? $head.nodeAfter : $head.nodeBefore;
    if (adjacent && !adjacent.isText && adjacent.isAtom) return false;
  }

  const newHead = $head.pos + dir;
  const newSel = extending
    ? TextSelection.create(state.doc, selection.$anchor.pos, newHead)
    : TextSelection.create(state.doc, newHead);
  view.dispatch(state.tr.setSelection(newSel).scrollIntoView());
  return true;
}

/**
 * InlineAtomNavigationExtension — インラインatom周辺のカーソル移動修正
 *
 * ProseMirrorはインラインatomノード（ルビなど）に contenteditable="false" を付与するため、
 * ブラウザのネイティブカーソル処理が以下の問題を起こす：
 *   1. End/Homeキー: ProseMirrorにバインドなし → ブラウザが誤動作
 *   2. 矢印キー: テキスト内ではProseMirrorがブラウザに委譲 → 誤動作
 *   3. 折り返し行のEnd: 視覚行末でなく次行頭へ移動する
 *
 * handleKeyDown で直接キーイベントを処理し、確実にブラウザのネイティブ動作を抑止する。
 */
export const InlineAtomNavigationExtension = Extension.create({
  name: "inlineAtomNavigation",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        props: {
          handleKeyDown(view, event) {
            const ctrl = event.ctrlKey || event.metaKey;

            switch (event.key) {
              case "End":
                if (ctrl)
                  return handleCtrlEndHome(view, "right", event.shiftKey);
                return handleEndHome(view, "right", event.shiftKey);
              case "Home":
                if (ctrl)
                  return handleCtrlEndHome(view, "left", event.shiftKey);
                return handleEndHome(view, "left", event.shiftKey);
              case "ArrowRight":
                return handleArrow(view, 1, event.shiftKey);
              case "ArrowLeft":
                return handleArrow(view, -1, event.shiftKey);
              default:
                return false;
            }
          },
        },
      }),
    ];
  },
});
