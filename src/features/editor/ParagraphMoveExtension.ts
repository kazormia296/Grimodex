import { Extension, type Editor, type RawCommands } from "@tiptap/core";
import { Fragment } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { isReducedMotion } from "@/lib/gsap";
import { CSS_DURATIONS, CSS_EASINGS } from "@/lib/animation";

/**
 * ParagraphMoveExtension — 現在の段落（最上位ブロック）を上下に入れ替えるアクション。
 *
 * VSCode の「行を上/下へ移動」相当。本文は段落主体なので「行」=「カーソルのある
 * 最上位ブロック」を隣の最上位ブロックと swap する。見出し・引用・シーンブレイク等の
 * 最上位ブロックも対象（= ブロック移動）。リスト/テーブル内にカーソルがある場合は
 * その最上位の親が動く（本文編集が主目的のため単純で予測可能な挙動）。
 *
 * 入れ替えは FLIP アニメーション（Web Animations API、transform で旧→新位置へスライド）
 * で見せる。これでブロック DOM が瞬間入れ替わる「ちらつき」も解消する（最初のキー
 * フレームが旧位置なので paint 時にフラッシュしない）。Reduced Motion 時はアニメ無しで
 * 即最終状態（/polish-motion 規律）。
 *
 * 重要: FLIP はキーボードショートカット側で `editor.commands.moveLineUp()` を呼んだ
 * **後** に行う。TipTap は commands コールバックの戻り後に view.dispatch で DOM を
 * 反映するため、コマンド内で測ると DOM が古く測定が無意味になる。
 *
 * 通常エディタと Linear モードは getEditorExtensions() を共有するため両方に適用される。
 */

/** 縦書き (editor.verticalMode = vertical-rl) かどうか。キーの向きを切り替える。 */
function isVerticalWriting(): boolean {
  return useSettingsStore.getState().getBoolean("editor.verticalMode", false);
}

interface SwapPlan {
  start: number;
  end: number;
  fragment: Fragment;
  caretPos: number;
  /** 入れ替え前後の「ブロック先頭位置」(FLIP の DOM 取得用)。 */
  currentBefore: number;
  currentAfter: number;
  neighborBefore: number;
  neighborAfter: number;
  /** doc 順で先・後のブロックの nodeSize (Codex 装飾の reorder remap 用)。 */
  firstSize: number;
  secondSize: number;
}

/**
 * ブロックと隣ブロックを入れ替える計画を組む。不可なら null。
 * indexOverride 省略時はカーソル直下の最上位ブロックを対象にする。
 * indexOverride 指定時（ドラッグ）は選択に依らず任意ブロックを対象にできる。
 */
function planSwap(
  state: EditorState,
  dir: -1 | 1,
  indexOverride?: number,
): SwapPlan | null {
  const { selection, doc } = state;
  let index: number;
  if (indexOverride !== undefined) {
    if (indexOverride < 0 || indexOverride >= doc.childCount) return null;
    index = indexOverride;
  } else {
    const { $from, $to } = selection;
    if ($from.depth === 0) return null;
    index = $from.index(0);
    // 複数の最上位ブロックに跨る選択は対象外（どのブロックを動かすか曖昧）。
    if ($to.index(0) !== index) return null;
  }

  const swapWith = index + dir;
  if (swapWith < 0 || swapWith >= doc.childCount) return null;

  const lo = Math.min(index, swapWith);
  let start = 0;
  for (let i = 0; i < lo; i++) start += doc.child(i).nodeSize;
  const first = doc.child(lo);
  const second = doc.child(lo + 1);
  const end = start + first.nodeSize + second.nodeSize;

  // 現在ブロック (キャレットあり) と隣ブロックの、入れ替え前後の先頭位置。
  const currentBefore = index === lo ? start : start + first.nodeSize;
  const currentAfter = dir === 1 ? start + second.nodeSize : start;
  const neighborBefore = index === lo ? start + first.nodeSize : start;
  const neighborAfter = dir === 1 ? start : start + second.nodeSize;

  // キャレットのブロック内オフセットを保ったまま追従させる。
  const caretPos = currentAfter + (selection.from - currentBefore);

  return {
    start,
    end,
    fragment: Fragment.fromArray([second, first]),
    caretPos,
    currentBefore,
    currentAfter,
    neighborBefore,
    neighborAfter,
    firstSize: first.nodeSize,
    secondSize: second.nodeSize,
  };
}

/** コマンド本体: 隣接ブロックを swap してキャレットを追従させる (アニメは別途)。 */
function applySwap(
  state: EditorState,
  tr: Transaction,
  dispatch: ((tr: Transaction) => void) | undefined,
  dir: -1 | 1,
): boolean {
  const plan = planSwap(state, dir);
  if (!plan) return false;
  if (!dispatch) return true;
  tr.replaceWith(plan.start, plan.end, plan.fragment);
  // CodexHighlightPlugin に「これは reorder」と伝え、置換で落ちる装飾を per-block
  // オフセットで再構築させて保持する (移動中の折り返しズレ・ちらつきを防ぐ)。
  tr.setMeta("codexHighlightReorder", {
    start: plan.start,
    firstSize: plan.firstSize,
    secondSize: plan.secondSize,
  });
  const caretPos = Math.min(Math.max(plan.caretPos, 0), tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(caretPos)));
  // scrollIntoView しない: 隣接ブロックの 1 つ移動では行は視界に残る。FLIP 中に
  // スクロール補正が走ると視覚的に煩いため省く。
  dispatch(tr);
  return true;
}

const MOVE_ANIM_MS = parseFloat(CSS_DURATIONS.normal);

interface BlockOffset {
  el: HTMLElement;
  left: number;
  top: number;
}

/**
 * ブロック DOM の位置を view.dom 基準の相対座標で返す。スクロール量は view.dom と
 * ブロックの双方に同じだけ効くので、相対座標はスクロール不変 = FLIP 差分が安定する。
 */
function blockOffset(view: EditorView, pos: number): BlockOffset | null {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  const r = dom.getBoundingClientRect();
  const base = view.dom.getBoundingClientRect();
  return { el: dom, left: r.left - base.left, top: r.top - base.top };
}

function flipBlock(
  view: EditorView,
  posAfter: number,
  before: BlockOffset | null,
): void {
  if (!before) return;
  const after = blockOffset(view, posAfter);
  if (!after) return;
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  after.el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: "translate(0px, 0px)" },
    ],
    { duration: MOVE_ANIM_MS, easing: CSS_EASINGS.easeOut },
  );
}

/**
 * swap コマンドを実行し、その直後 (= DOM 反映後) に FLIP アニメを掛ける。
 * ショートカットから呼ぶ。プログラム的な editor.commands.moveLine* は素の swap のまま。
 */
function animatedMove(editor: Editor, dir: -1 | 1): boolean {
  const view = editor.view;
  const plan = planSwap(view.state, dir);
  if (!plan) return false;

  const animate = !isReducedMotion() && typeof view.dom.animate === "function";
  const beforeCurrent = animate ? blockOffset(view, plan.currentBefore) : null;
  const beforeNeighbor = animate
    ? blockOffset(view, plan.neighborBefore)
    : null;

  const ok =
    dir === -1 ? editor.commands.moveLineUp() : editor.commands.moveLineDown();
  if (!ok) return false;

  if (animate) {
    // editor.commands.* の戻り後は DOM が新状態に反映済み。新位置の要素を旧位置から
    // スライドさせる。
    flipBlock(view, plan.currentAfter, beforeCurrent);
    flipBlock(view, plan.neighborAfter, beforeNeighbor);
  }
  return true;
}

/**
 * 指定 index の最上位ブロックを隣ブロック(dir)と入れ替える（ドラッグ用）。
 * caret は動かさず transaction の mapping に委ねる（ドラッグ中に別位置の
 * キャレットを奪わないため）。FLIP アニメは掛けない（ドラッグ中の連続 swap
 * では位置がその都度変わり、スライドアニメが干渉するため即時反映にする）。
 * 成否を返す。
 */
export function swapBlockAt(
  view: EditorView,
  index: number,
  dir: -1 | 1,
): boolean {
  const plan = planSwap(view.state, dir, index);
  if (!plan) return false;
  const tr = view.state.tr;
  tr.replaceWith(plan.start, plan.end, plan.fragment);
  tr.setMeta("codexHighlightReorder", {
    start: plan.start,
    firstSize: plan.firstSize,
    secondSize: plan.secondSize,
  });
  view.dispatch(tr);
  return true;
}

export const ParagraphMoveExtension = Extension.create({
  name: "paragraphMove",

  addCommands() {
    return {
      moveLineUp:
        () =>
        ({ state, tr, dispatch }) =>
          applySwap(state, tr, dispatch, -1),
      moveLineDown:
        () =>
        ({ state, tr, dispatch }) =>
          applySwap(state, tr, dispatch, 1),
    } as Partial<RawCommands>;
  },

  addKeyboardShortcuts() {
    // 横書きは Alt+↑/↓。縦書き (vertical-rl) は行が左右に積まれるので Alt+←/→ に
    // する: → = 前の行 (上方向/前方) = moveLineUp、← = 次の行 (下方向/後方) =
    // moveLineDown (CursorOverlayPlugin の writing-mode 規約と一致)。モードに
    // 合わない向きのキーは false を返して素通しする。
    return {
      "Alt-ArrowUp": () =>
        !isVerticalWriting() && animatedMove(this.editor, -1),
      "Alt-ArrowDown": () =>
        !isVerticalWriting() && animatedMove(this.editor, 1),
      "Alt-ArrowRight": () =>
        isVerticalWriting() && animatedMove(this.editor, -1),
      "Alt-ArrowLeft": () =>
        isVerticalWriting() && animatedMove(this.editor, 1),
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
