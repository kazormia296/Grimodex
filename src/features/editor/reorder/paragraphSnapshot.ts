import type { EditorState } from "@tiptap/pm/state";
import { resolveParagraphAtPos, type ResolvedParagraph } from "./paragraphFlat";

/** 段落内容の指紋（split-view 同期後の stale 検出用）。 */
export function paragraphFingerprint(resolved: ResolvedParagraph): string {
  return `${resolved.pos}:${resolved.contentFrom}:${resolved.contentTo}:${resolved.flat.text}`;
}

export interface SwapSnapshot {
  paragraphPos: number;
  fingerprint: string;
  flatText: string;
  selectionFrom: number;
  selectionTo: number;
  dir: -1 | 1;
}

export function captureSwapSnapshot(
  state: EditorState,
  resolved: ResolvedParagraph,
  dir: -1 | 1,
): SwapSnapshot {
  return {
    paragraphPos: resolved.pos,
    fingerprint: paragraphFingerprint(resolved),
    flatText: resolved.flat.text,
    selectionFrom: state.selection.from,
    selectionTo: state.selection.to,
    dir,
  };
}

export function isSwapSnapshotValid(
  state: EditorState,
  snapshot: SwapSnapshot,
): boolean {
  const current = resolveParagraphAtPos(state, snapshot.paragraphPos);
  if (!current) return false;
  if (paragraphFingerprint(current) !== snapshot.fingerprint) return false;
  const { from, to } = state.selection;
  return from === snapshot.selectionFrom && to === snapshot.selectionTo;
}

/** overlay 確定時に保存 ctx の段落が現 doc と一致するか。 */
export function revalidateParagraphContext(
  state: EditorState,
  stored: ResolvedParagraph,
): ResolvedParagraph | null {
  const current = resolveParagraphAtPos(state, stored.pos);
  if (!current) return null;
  if (paragraphFingerprint(current) !== paragraphFingerprint(stored)) {
    return null;
  }
  return current;
}
