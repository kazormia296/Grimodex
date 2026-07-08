import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type {
  EditorState,
  SelectionBookmark,
  Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { reorderUiKey } from "./reorderUiKey";

const TAG = "reorderHistory";

/** Alt+Shift 押下中の段落内入替えを 1 つの undo イベントにまとめるスナップショット。 */
export interface ReorderHistorySession {
  /** Alt+Shift 突入時の doc（immutable なので参照保持で十分）。 */
  beforeDoc: ProseMirrorNode;
  selectionBookmark: SelectionBookmark;
}

interface ReorderUiStateSlice {
  historySession?: ReorderHistorySession | null;
}

export function beginReorderHistorySession(
  state: EditorState,
): ReorderHistorySession {
  return {
    beforeDoc: state.doc,
    selectionBookmark: state.selection.getBookmark(),
  };
}

export function hasActiveReorderHistorySession(state: EditorState): boolean {
  const ui = reorderUiKey.getState(state) as ReorderUiStateSlice | undefined;
  return ui?.historySession != null;
}

/** 進行中セッションがあるとき、入替え tr を履歴から除外する。 */
export function stampReorderHistoryExclusion(
  tr: Transaction,
  state: EditorState,
): Transaction {
  if (hasActiveReorderHistorySession(state)) {
    tr.setMeta("addToHistory", false);
  }
  return tr;
}

/**
 * Alt+Shift 離し時に 1 つの undo イベントとして履歴へ積む。
 *
 * 途中の入替えは addToHistory:false で履歴から除外済み。ここで
 *   1. before/after が食い違う**最小範囲だけ**を before へ静かに戻す（addToHistory:false）
 *   2. その範囲を after へ再適用（undoable, closeHistory）
 * の 2 段に**分けて** dispatch する。
 *
 * - 段を分ける理由: 1 トランザクション内で after→before→after とすると正味 doc
 *   変化がゼロになり、prosemirror-history が「戻しても内容が変わらない」空イベント
 *   を記録してしまう（undo しても戻らない）。段を分けると手順 2 が真に before→after
 *   の transform になり、逆操作 = after→before が効く。同期 dispatch なので画面は
 *   最終 after しか paint しない。
 * - **全文でなく差分範囲**にする理由: エディタはシーン間で使い回され、undo スタックは
 *   シーンをまたいで残る。全文 replace を履歴に積むと、シーン切替後の undo が別シーンの
 *   内容で doc 全体を上書きしたり全消しする。差分範囲に限定すれば通常の局所編集と同じ
 *   挙動になり、この破滅的上書きを防げる。
 */
export function commitReorderHistorySession(
  view: EditorView,
  session: ReorderHistorySession | null,
): boolean {
  if (!session) return false;
  const { state } = view;
  const beforeDoc = session.beforeDoc;
  const afterDoc = state.doc;
  if (beforeDoc.eq(afterDoc)) return false;

  // before/after が食い違う最小レンジ（doc 位置）を求める。
  const start = beforeDoc.content.findDiffStart(afterDoc.content);
  if (start == null) return false;
  const diffEnd = beforeDoc.content.findDiffEnd(afterDoc.content);
  if (!diffEnd) return false;
  let beforeEnd = diffEnd.a;
  let afterEnd = diffEnd.b;
  // findDiffStart と findDiffEnd のレンジが重なる場合の補正（PM 標準イディオム）。
  const overlap = start - Math.min(beforeEnd, afterEnd);
  if (overlap > 0) {
    beforeEnd += overlap;
    afterEnd += overlap;
  }

  const afterSelectionBookmark = state.selection.getBookmark();

  try {
    // 手順 1: 差分範囲を before へ静かに戻す（履歴に積まない）。
    const revertTr = state.tr;
    revertTr.replace(start, afterEnd, beforeDoc.slice(start, beforeEnd));
    revertTr.setSelection(session.selectionBookmark.resolve(revertTr.doc));
    revertTr.setMeta("addToHistory", false);
    view.dispatch(revertTr);

    // 手順 2: 差分範囲を after へ再適用（undoable な 1 イベント）。
    const revertedState = view.state;
    let applyTr = revertedState.tr;
    applyTr.replace(start, beforeEnd, afterDoc.slice(start, afterEnd));
    applyTr.setSelection(afterSelectionBookmark.resolve(applyTr.doc));
    applyTr = closeHistory(applyTr);
    view.dispatch(applyTr);
  } catch (e) {
    debugLog.error(TAG, "commit dispatch threw", errorDetail(e));
    return false;
  }
  return true;
}
