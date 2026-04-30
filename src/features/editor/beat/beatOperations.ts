import type { Editor } from "@tiptap/core";
import { findBeatById, findGeneratedBlockForBeat } from "./insertBeatStream";

/**
 * Delete only the sceneBeat node. The linked generatedProseBlock (if any)
 * stays in the document; the appendTransaction in GeneratedProseBlockNode
 * will unwrap it on the next tick because its beatId no longer resolves.
 *
 * Returns true if a beat was found and removed.
 */
export function deleteBeatOnly(editor: Editor, beatId: string): boolean {
  const beat = findBeatById(editor, beatId);
  if (!beat) return false;
  const { tr } = editor.state;
  tr.delete(beat.beatPos, beat.beatPos + beat.beatSize);
  editor.view.dispatch(tr);
  return true;
}

/**
 * Delete the sceneBeat and its linked generatedProseBlock (if it sits as
 * the immediate next sibling). Done in one transaction so undo is one step.
 */
export function deleteBeatAndProse(editor: Editor, beatId: string): boolean {
  const beat = findBeatById(editor, beatId);
  if (!beat) return false;
  const block = findGeneratedBlockForBeat(editor, beatId);
  const { tr } = editor.state;
  // Delete from the beat's start through the end of the block (or just the
  // beat if there is no block). Higher-position-first ordering isn't needed
  // because we compute one combined range.
  const from = beat.beatPos;
  const to = block
    ? block.blockPos + block.blockSize
    : beat.beatPos + beat.beatSize;
  tr.delete(from, to);
  editor.view.dispatch(tr);
  return true;
}

/**
 * Convert a sceneBeat to a regular paragraph carrying the same inline content.
 * Mentions, bracket-instructions text, and any other inline marks survive.
 *
 * Implementation: replace the sceneBeat node with a paragraph whose content
 * is the beat's content fragment.
 */
export function convertBeatToText(editor: Editor, beatId: string): boolean {
  const beat = findBeatById(editor, beatId);
  if (!beat) return false;
  const beatNode = editor.state.doc.nodeAt(beat.beatPos);
  if (!beatNode) return false;
  const paragraphType = editor.schema.nodes["paragraph"];
  if (!paragraphType) return false;

  const para = paragraphType.create(null, beatNode.content);
  const { tr } = editor.state;
  tr.replaceWith(beat.beatPos, beat.beatPos + beat.beatSize, para);
  editor.view.dispatch(tr);
  return true;
}
