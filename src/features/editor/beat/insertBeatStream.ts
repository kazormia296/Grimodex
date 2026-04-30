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
  // AiEditedPlugin strips authorship marks from inserts that land inside an
  // AI-marked span unless this meta is set. Beat-side inserts are
  // unconditionally programmatic, so always tag them.
  tr.setMeta("programmaticInsert", true);
  tr.insert(insertAt, block);
  editor.view.dispatch(tr);

  return { blockPos: insertAt, blockSize: block.nodeSize };
}

/**
 * Append a streaming chunk of AI-authored text into the linked
 * generatedProseBlock. Re-locates the block by `beatId` on every call so
 * upstream edits during streaming don't drift the insertion point, and a
 * mid-stream beat deletion makes this a clean no-op.
 *
 * Returns `true` when the chunk was applied, `false` when the linked block
 * is no longer reachable (orphaned stream — caller should stop streaming).
 *
 * `\n` in the chunk triggers a fresh paragraph inside the block.
 */
export function appendBeatChunk(
  editor: Editor,
  beatId: string,
  chunk: string,
  authorship: { model: string; traceId: string },
): boolean {
  if (chunk.length === 0) return true;

  const block = findGeneratedBlockForBeat(editor, beatId);
  if (!block) return false;

  const authorshipType = editor.schema.marks["authorship"];
  const paragraphType = editor.schema.nodes["paragraph"];
  if (!authorshipType || !paragraphType) return false;

  const blockNode = editor.state.doc.nodeAt(block.blockPos);
  if (!blockNode) return false;
  // Tail position = end of last child paragraph inside the block.
  // blockPos + 1 enters the block; + content.size lands at the close of the
  // last child; - 1 backs into the last child's content.
  const tailPos = block.blockPos + 1 + blockNode.content.size - 1;

  const aiMark = authorshipType.create({
    source: "ai",
    model: authorship.model,
    traceId: authorship.traceId,
    timestamp: new Date().toISOString(),
  });

  const segments = chunk.split("\n");
  const { tr } = editor.state;
  tr.setMeta(BEAT_STREAM_META, true);
  // Without programmaticInsert=true, AiEditedPlugin treats each chunk after
  // the first as a user edit inside the AI span and strips its AuthorshipMark
  // (so later chunks would render as "human" attribution). Mirror the inline-AI
  // streaming convention here.
  tr.setMeta("programmaticInsert", true);
  // Streaming chunks should not pollute the undo stack; one Ctrl+Z should
  // collapse the entire generated block (which is in history via
  // ensureGeneratedBlock).
  tr.setMeta("addToHistory", false);

  let pos = tailPos;
  segments.forEach((segment, i) => {
    if (segment.length > 0) {
      tr.insert(pos, editor.schema.text(segment, [aiMark]));
      pos += segment.length;
    }
    if (i < segments.length - 1) {
      tr.split(pos, 1, [{ type: paragraphType }]);
      pos += 2; // close + open paragraph nodes
    }
  });

  editor.view.dispatch(tr);
  return true;
}
