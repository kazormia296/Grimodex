import { Extension } from "@tiptap/core";
import {
  Plugin,
  PluginKey,
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
 * @returns 同一視覚行にある最端のdoc位置。検出できなければ startPos を返す。
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

  let startCoords: { bottom: number };
  try {
    startCoords = view.coordsAtPos(startPos, startSide);
  } catch {
    // coordsAtPos が失敗する場合はテキストブロック端にフォールバック
    return dir === "right" ? parentEnd : parentStart;
  }
  const refBottom = startCoords.bottom;

  const step = dir === "right" ? 1 : -1;
  const checkSide = dir === "right" ? -1 : 1;
  const limit = dir === "right" ? parentEnd : parentStart;

  let bestPos = startPos;
  let pos = startPos + step;

  while (dir === "right" ? pos <= limit : pos >= limit) {
    let coords: { bottom: number };
    try {
      coords = view.coordsAtPos(pos, checkSide);
    } catch {
      break;
    }
    // bottom が 8px 以上ずれたら別の視覚行
    if (Math.abs(coords.bottom - refBottom) >= 8) break;
    bestPos = pos;
    pos += step;
  }

  return bestPos;
}

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
    // NodeSelection からは選択端をheadとして扱う
    headPos = dir === "right" ? selection.$to.pos : selection.$from.pos;
    anchorPos = extending ? selection.$from.pos : headPos;
    const $pos = state.doc.resolve(headPos);
    if (!$pos.parent.isTextblock) return false;
  } else {
    return false;
  }

  const targetPos = findVisualLineEdge(view, headPos, dir);

  // 既に行端にいても true を返しブラウザのネイティブ処理を防ぐ
  if (targetPos !== headPos) {
    const newSel = extending
      ? TextSelection.create(state.doc, anchorPos, targetPos)
      : TextSelection.create(state.doc, targetPos);
    view.dispatch(state.tr.setSelection(newSel).scrollIntoView());
  }
  return true;
}

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
            switch (event.key) {
              case "End":
                return handleEndHome(view, "right", event.shiftKey);
              case "Home":
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
