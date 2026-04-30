import type { Editor } from "@tiptap/core";
import { BEAT_STREAM_META } from "@/features/editor/GeneratedProseBlockNode";

export interface BeatLocation {
  /** Position of the sceneBeat node start. */
  beatPos: number;
  /** sceneBeat node size (so beatPos + beatSize is the position right after it). */
  beatSize: number;
}

/**
 * Locate a sceneBeat by its `attrs.id` in the editor doc.
 * Returns null if the beat is no longer present (deleted while generating, etc.).
 */
export function findBeatById(
  editor: Editor,
  beatId: string,
): BeatLocation | null {
  let result: BeatLocation | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (
      result === null &&
      node.type.name === "sceneBeat" &&
      node.attrs.id === beatId
    ) {
      result = { beatPos: pos, beatSize: node.nodeSize };
      return false;
    }
    return true;
  });
  return result;
}

/**
 * Returns the doc position of the existing generatedProseBlock immediately
 * after the beat (and within the same parent), or null if there isn't one.
 *
 * Phase A: only accepts a block that sits as the very next sibling of the beat.
 * Anything farther away (separated by a paragraph) is treated as not-linked,
 * matching the spec's note that linkage is best-effort via beatId attr.
 */
export function findGeneratedBlockForBeat(
  editor: Editor,
  beatId: string,
): { blockPos: number; blockSize: number } | null {
  const beat = findBeatById(editor, beatId);
  if (!beat) return null;
  const afterBeatPos = beat.beatPos + beat.beatSize;
  const node = editor.state.doc.nodeAt(afterBeatPos);
  if (!node || node.type.name !== "generatedProseBlock") return null;
  if (node.attrs.beatId !== beatId) return null;
  return { blockPos: afterBeatPos, blockSize: node.nodeSize };
}

/**
 * Insert a fresh generatedProseBlock immediately after the beat. The block
 * carries one empty paragraph so it satisfies the `block+` content schema.
 *
 * If a linked block already exists, returns it without creating a duplicate.
 */
export function ensureGeneratedBlock(
  editor: Editor,
  beatId: string,
): { blockPos: number; blockSize: number } | null {
  const existing = findGeneratedBlockForBeat(editor, beatId);
  if (existing) return existing;

  const beat = findBeatById(editor, beatId);
  if (!beat) return null;

  const blockType = editor.schema.nodes["generatedProseBlock"];
  const paragraphType = editor.schema.nodes["paragraph"];
  if (!blockType || !paragraphType) return null;

  const block = blockType.createChecked(
    { beatId, modified: false },
    paragraphType.createChecked(),
  );

  const insertAt = beat.beatPos + beat.beatSize;
  const { tr } = editor.state;
  tr.setMeta(BEAT_STREAM_META, true);
  tr.insert(insertAt, block);
  editor.view.dispatch(tr);

  return { blockPos: insertAt, blockSize: block.nodeSize };
}

export interface BeatStreamCursor {
  /** Position immediately after the last inserted character (within the block). */
  insertAt: number;
}

/**
 * Append a streaming chunk of AI-authored text into the open generatedProseBlock
 * at `cursor.insertAt`. The chunk is split on newlines: each `\n` triggers a
 * fresh paragraph inside the block (preserving block boundaries via beatStream meta).
 *
 * Mutates `cursor.insertAt` to the new tail position so the caller can keep
 * appending without re-locating the block.
 */
export function appendBeatChunk(
  editor: Editor,
  cursor: BeatStreamCursor,
  chunk: string,
  authorship: { model: string; traceId: string },
): void {
  if (chunk.length === 0) return;

  const authorshipType = editor.schema.marks["authorship"];
  if (!authorshipType) return;

  const paragraphType = editor.schema.nodes["paragraph"];
  if (!paragraphType) return;

  const aiMark = authorshipType.create({
    source: "ai",
    model: authorship.model,
    traceId: authorship.traceId,
    timestamp: new Date().toISOString(),
  });

  // Split chunk on \n: text segment → optional paragraph break → next segment.
  const segments = chunk.split("\n");
  const { tr } = editor.state;
  tr.setMeta(BEAT_STREAM_META, true);

  let pos = cursor.insertAt;
  segments.forEach((segment, i) => {
    if (segment.length > 0) {
      tr.insert(pos, editor.schema.text(segment, [aiMark]));
      pos += segment.length;
    }
    if (i < segments.length - 1) {
      // Paragraph break: split current paragraph at pos.
      tr.split(pos, 1, [{ type: paragraphType }]);
      pos += 2; // close + open paragraph nodes
    }
  });

  editor.view.dispatch(tr);
  cursor.insertAt = pos;
}

/**
 * Convenience: prepare a streaming session for a beat. Returns the cursor at
 * the end of the (possibly newly-created) generatedProseBlock's last paragraph,
 * or null if the beat doesn't exist.
 */
export function startBeatStream(
  editor: Editor,
  beatId: string,
): BeatStreamCursor | null {
  const block = ensureGeneratedBlock(editor, beatId);
  if (!block) return null;
  // Cursor inside the last child paragraph of the block.
  const blockNode = editor.state.doc.nodeAt(block.blockPos);
  if (!blockNode) return null;
  const lastChild = blockNode.lastChild;
  // Position at end of block content: blockPos + 1 (enter block) + content.size
  // For a fresh empty paragraph that's blockPos + 1 + 1 (enter the paragraph).
  const insertAt = lastChild
    ? block.blockPos + 1 + blockNode.content.size - 1
    : block.blockPos + 1;
  return { insertAt };
}
