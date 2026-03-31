import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReplaceStep } from "@tiptap/pm/transform";

export const aiEditedKey = new PluginKey("aiEdited");

/**
 * Ratio of remaining text to original length that triggers mixed → human.
 * When nodeSize / originalLength ≤ 0.2 (i.e. 80%+ removed), transition fires.
 */
export const HUMAN_LENGTH_RATIO = 0.2;

/**
 * ProseMirror plugin that automatically reclassifies authorship marks
 * when the user edits text within AI-attributed ranges.
 *
 * Transitions:
 *   ai → mixed:  Any user edit within an AI span (immediate, no threshold)
 *   mixed → human: When remaining text ≤ 20% of originalLength
 *
 * Detection strategy (hybrid):
 *   1. Primary: cursor position — the node containing the selection anchor
 *      is the node the user just edited. This correctly isolates edits even
 *      when the browser reports a wide DOM mutation across adjacent marked nodes.
 *   2. Fallback: traceId text comparison — if the cursor is not within any
 *      ai/mixed node, compare text by traceId to detect changed nodes.
 *      This handles programmatic edits and test scenarios.
 */
export function createAiEditedPlugin(): Plugin {
  return new Plugin({
    key: aiEditedKey,
    appendTransaction(transactions, oldState, newState) {
      const docChanged = transactions.some((tr) => tr.docChanged);
      if (!docChanged) return null;

      // Skip programmatic inserts (chat/snippet insertion)
      const hasProgrammatic = transactions.some(
        (tr) => tr.getMeta("programmaticInsert") === true,
      );
      if (hasProgrammatic) return null;

      const { schema, tr } = newState;
      const authorshipType = schema.marks["authorship"];
      if (!authorshipType) return null;

      // Collect old text by traceId (for fallback comparison and originalLength)
      const oldTextByTraceId = new Map<
        string,
        { text: string; originalLength: number | null }
      >();
      oldState.doc.descendants((node: ProseMirrorNode) => {
        if (!node.isText) return;
        const mark = node.marks.find(
          (m) =>
            m.type === authorshipType &&
            (m.attrs.source === "ai" || m.attrs.source === "mixed"),
        );
        if (!mark) return;
        const tid = mark.attrs.traceId as string | null;
        if (tid) {
          oldTextByTraceId.set(tid, {
            text: node.text ?? "",
            originalLength: mark.attrs.originalLength as number | null,
          });
        }
      });

      // Phase 0: Insertion detection — strip authorship marks from user-inserted text
      // so inserted characters become separate unmarked (human) nodes.
      const splitTraceIds = new Set<string>();
      let changed = false;

      for (const transaction of transactions) {
        if (transaction.getMeta("programmaticInsert") === true) continue;

        const steps = transaction.steps;
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (!(step instanceof ReplaceStep)) continue;

          const { from, to } = step as { from: number; to: number };
          const insertedSize = step.slice.content.size;
          if (insertedSize === 0) continue;

          const isPureInsertion = from === to;

          // Check if the insertion/replacement position is inside an ai/mixed span
          // Use oldState positions (step coordinates are in pre-step document)
          let aiMark = null;
          if (from < oldState.doc.content.size) {
            const $pos = oldState.doc.resolve(from);
            aiMark = $pos.marks().find(
              (m) =>
                m.type === authorshipType &&
                (m.attrs.source === "ai" || m.attrs.source === "mixed") &&
                !m.attrs.manualOverride,
            );
          }

          if (aiMark) {
            // Map the insertion range to newState coordinates
            // For multi-step transactions, map through subsequent steps
            let newFrom = from;
            let newTo = from + insertedSize;
            for (let j = i + 1; j < steps.length; j++) {
              const map = steps[j].getMap();
              newFrom = map.map(newFrom, -1);
              newTo = map.map(newTo, 1);
            }

            tr.removeMark(newFrom, newTo, authorshipType);
            changed = true;

            // For pure insertions, record traceId to skip in fallback phase
            // (the flanking AI text was not edited, just split)
            if (isPureInsertion) {
              const traceId = aiMark.attrs.traceId as string | null;
              if (traceId) splitTraceIds.add(traceId);
            }
          }
        }
      }

      const cursorPos = newState.selection.anchor;

      // Phase 1: Try cursor-based detection (for deletions / replacements)
      let cursorNodeFound = false;

      newState.doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (!node.isText) return;
        const mark = node.marks.find(
          (m) =>
            m.type === authorshipType &&
            (m.attrs.source === "ai" || m.attrs.source === "mixed"),
        );
        if (!mark) return;

        const nodeEnd = pos + node.nodeSize;
        if (cursorPos >= pos && cursorPos <= nodeEnd) {
          cursorNodeFound = true;
        }
      });

      if (cursorNodeFound) {
        // Cursor is within an ai/mixed node — only transition that node
        newState.doc.descendants((node: ProseMirrorNode, pos: number) => {
          if (!node.isText) return;
          const mark = node.marks.find(
            (m) =>
              m.type === authorshipType &&
              (m.attrs.source === "ai" || m.attrs.source === "mixed"),
          );
          if (!mark) return;
          if (mark.attrs.manualOverride) return;

          // Skip nodes whose traceId was split by pure insertion
          const traceId = mark.attrs.traceId as string | null;
          if (traceId && splitTraceIds.has(traceId)) return;

          const nodeEnd = pos + node.nodeSize;
          if (cursorPos < pos || cursorPos > nodeEnd) return;

          const didChange = applyTransition(
            tr,
            authorshipType,
            mark,
            node,
            pos,
            nodeEnd,
            oldTextByTraceId,
          );
          if (didChange) changed = true;
        });
      } else {
        // Fallback: traceId text comparison for each node
        newState.doc.descendants((node: ProseMirrorNode, pos: number) => {
          if (!node.isText) return;
          const mark = node.marks.find(
            (m) =>
              m.type === authorshipType &&
              (m.attrs.source === "ai" || m.attrs.source === "mixed"),
          );
          if (!mark) return;
          if (mark.attrs.manualOverride) return;

          const traceId = mark.attrs.traceId as string | null;

          // Skip nodes whose traceId was split by pure insertion
          if (traceId && splitTraceIds.has(traceId)) return;

          if (traceId) {
            const old = oldTextByTraceId.get(traceId);
            if (old && old.text === (node.text ?? "")) return; // unchanged
          }

          const nodeEnd = pos + node.nodeSize;
          const didChange = applyTransition(
            tr,
            authorshipType,
            mark,
            node,
            pos,
            nodeEnd,
            oldTextByTraceId,
          );
          if (didChange) changed = true;
        });
      }

      return changed ? tr : null;
    },
  });
}

/**
 * Apply ai→mixed or mixed→human transition to a single node.
 * Returns true if a transition was applied.
 */
function applyTransition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tr: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authorshipType: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mark: any,
  node: ProseMirrorNode,
  pos: number,
  nodeEnd: number,
  oldTextByTraceId: Map<
    string,
    { text: string; originalLength: number | null }
  >,
): boolean {
  const currentSource = mark.attrs.source as string;
  const traceId = mark.attrs.traceId as string | null;

  if (currentSource === "ai") {
    const newMark = authorshipType.create({
      ...mark.attrs,
      source: "mixed",
    });
    tr.addMark(pos, nodeEnd, newMark);
    return true;
  } else if (currentSource === "mixed") {
    const origLen =
      (mark.attrs.originalLength as number | null) ??
      (traceId ? (oldTextByTraceId.get(traceId)?.originalLength ?? null) : null);
    if (origLen == null || origLen === 0) return false;

    const remainingRatio = node.nodeSize / origLen;
    if (remainingRatio <= HUMAN_LENGTH_RATIO) {
      const newMark = authorshipType.create({
        ...mark.attrs,
        source: "human",
      });
      tr.addMark(pos, nodeEnd, newMark);
      return true;
    }
  }
  return false;
}
