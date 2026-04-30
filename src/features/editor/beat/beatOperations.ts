import type { Editor } from "@tiptap/core";
import { BEAT_STREAM_META } from "@/features/editor/GeneratedProseBlockNode";
import { findBeatById, findGeneratedBlockForBeat } from "./insertBeatStream";
import { useUnplacedBeatsStore } from "./unplacedBeatsStore";
import type { BeatType } from "@/features/editor/SceneBeatNode";

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

/**
 * Replace the linked generatedProseBlock with a fresh empty block.
 * Uses BEAT_STREAM_META so appendTransaction does not flip modified=true.
 * The caller should then invoke generate() to stream new content.
 */
export function replaceBeatBlock(editor: Editor, beatId: string): boolean {
  const block = findGeneratedBlockForBeat(editor, beatId);
  if (!block) return false;

  const blockType = editor.schema.nodes["generatedProseBlock"];
  const paraType = editor.schema.nodes["paragraph"];
  if (!blockType || !paraType) return false;

  const emptyBlock = blockType.create(
    { beatId, modified: false },
    paraType.create(),
  );
  const { tr } = editor.state;
  tr.setMeta(BEAT_STREAM_META, true);
  tr.replaceWith(block.blockPos, block.blockPos + block.blockSize, emptyBlock);
  editor.view.dispatch(tr);
  return true;
}

/**
 * Delete all content between this beat and the next sceneBeat (or doc end).
 * The beat node itself is preserved; only the prose/generated content after it
 * is removed. Returns false if the beat is not found or there is nothing to clear.
 */
export function clearBeatContent(editor: Editor, beatId: string): boolean {
  const beat = findBeatById(editor, beatId);
  if (!beat) return false;

  const from = beat.beatPos + beat.beatSize;
  const docSize = editor.state.doc.content.size;

  let nextBeatPos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (
      node.type.name === "sceneBeat" &&
      node.attrs.id !== beatId &&
      pos >= from &&
      nextBeatPos === null
    ) {
      nextBeatPos = pos;
      return false;
    }
    return true;
  });

  const to = nextBeatPos ?? docSize;
  if (from >= to) return false;

  const { tr } = editor.state;
  tr.delete(from, to);
  editor.view.dispatch(tr);
  return true;
}

/**
 * Insert an Unplaced beat as a sceneBeat node at the end of the document,
 * then remove it from the unplacedBeatsStore.
 *
 * Returns true always (insertContentAt is a fire-and-forget command).
 */
export function placeBeatAtEnd(
  editor: Editor,
  sceneId: string,
  beat: {
    id: string;
    beatType: BeatType;
    pov: string | null;
    collapsed: boolean;
    content: { type?: string; text?: string; [key: string]: unknown }[];
  },
): boolean {
  const beatJSON = {
    type: "sceneBeat",
    attrs: {
      id: beat.id,
      beatType: beat.beatType,
      pov: beat.pov,
      collapsed: false,
    },
    content: beat.content.length ? beat.content : undefined,
  };
  editor.commands.insertContentAt(editor.state.doc.content.size, beatJSON);
  useUnplacedBeatsStore.getState().removeBeat(sceneId, beat.id);
  return true;
}

/**
 * Move a Placed beat back to the Unplaced list.
 * The sceneBeat node is removed from the doc; its linked generatedProseBlock
 * (if any) stays in the doc and is unwrapped to normal paragraphs by the
 * existing appendTransaction in GeneratedProseBlockNode.
 */
export function unplaceBeat(
  editor: Editor,
  beatId: string,
  sceneId: string,
): boolean {
  const beat = findBeatById(editor, beatId);
  if (!beat) return false;
  const beatNode = editor.state.doc.nodeAt(beat.beatPos);
  if (!beatNode) return false;

  useUnplacedBeatsStore.getState().addBeat(sceneId, {
    id: beatId,
    beatType: (beatNode.attrs.beatType ?? "free") as BeatType,
    pov: (beatNode.attrs.pov ?? null) as string | null,
    collapsed: false,
    content: beatNode.content.toJSON() as {
      type?: string;
      text?: string;
      [key: string]: unknown;
    }[],
  });

  const { tr } = editor.state;
  tr.delete(beat.beatPos, beat.beatPos + beat.beatSize);
  editor.view.dispatch(tr);
  return true;
}
