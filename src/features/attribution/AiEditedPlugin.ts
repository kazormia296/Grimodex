import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export const aiEditedKey = new PluginKey("aiEdited");

/** Minimum edit ratio to trigger ai → mixed transition */
export const EDIT_RATIO_THRESHOLD = 0.1;
/** Minimum absolute character change to trigger ai → mixed transition */
export const EDIT_ABS_THRESHOLD = 5;

/** Edit ratio to trigger mixed → human transition (80% of original changed) */
export const HUMAN_RATIO_THRESHOLD = 0.8;
/** Minimum absolute character change to trigger mixed → human transition */
export const HUMAN_ABS_THRESHOLD = 10;

/**
 * ProseMirror plugin that automatically reclassifies "ai" marks
 * as "mixed" (Agent Trace compliant) when the user edits text within
 * an AI-attributed range beyond a minimum threshold.
 *
 * Transitions:
 *   ai → mixed:  fires when BOTH conditions are met:
 *     - edit ratio >= 10% of the original span length
 *     - absolute change >= 5 characters
 *   mixed → human: fires when BOTH conditions are met:
 *     - edit ratio >= 80% of the original span length
 *     - absolute change >= 10 characters
 *
 * This prevents trivial typo corrections from reclassifying text.
 */
export function createAiEditedPlugin(): Plugin {
  return new Plugin({
    key: aiEditedKey,
    appendTransaction(transactions, oldState, newState) {
      // Only react to transactions that change the doc AND originate
      // from user input (not programmatic inserts).
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

      // Build a list of AI/mixed-marked spans from the old document
      const oldSpans: { start: number; end: number; len: number; source: string }[] = [];
      oldState.doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (!node.isText) return;
        const mark = node.marks.find(
          (m) =>
            m.type === authorshipType &&
            (m.attrs.source === "ai" || m.attrs.source === "mixed"),
        );
        if (mark) {
          oldSpans.push({
            start: pos,
            end: pos + node.nodeSize,
            len: node.nodeSize,
            source: mark.attrs.source as string,
          });
        }
      });

      let changed = false;

      newState.doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (!node.isText) return;

        const mark = node.marks.find(
          (m) =>
            m.type === authorshipType &&
            (m.attrs.source === "ai" || m.attrs.source === "mixed"),
        );
        if (!mark) return;

        // Skip marks that were manually overridden by the user
        if (mark.attrs.manualOverride) return;

        const currentSource = mark.attrs.source as string;
        const nodeEnd = pos + node.nodeSize;
        let overlaps = false;
        let totalChangedChars = 0;

        for (const transaction of transactions) {
          if (!transaction.docChanged) continue;
          for (let i = 0; i < transaction.steps.length; i++) {
            const stepMap = transaction.mapping.maps[i];
            stepMap.forEach(
              (
                oldStart: number,
                oldEnd: number,
                newStart: number,
                newEnd: number,
              ) => {
                // Check overlap with current node range in new doc
                const mappedOldStart = transaction.mapping.map(oldStart, -1);
                const mappedOldEnd = transaction.mapping.map(oldEnd, 1);
                if (mappedOldStart < nodeEnd && mappedOldEnd > pos) {
                  overlaps = true;
                  // Estimate changed characters from this step
                  const deleted = oldEnd - oldStart;
                  const inserted = newEnd - newStart;
                  totalChangedChars += Math.max(deleted, inserted);
                }
              },
            );
          }
        }

        if (!overlaps) return;

        // Find the original span length by matching position proximity
        // instead of using max of all spans (which was incorrect)
        let originalSpanLen = node.nodeSize;
        let bestDistance = Infinity;
        for (const span of oldSpans) {
          const distance =
            Math.abs(span.start - pos) + Math.abs(span.end - nodeEnd);
          if (distance < bestDistance) {
            bestDistance = distance;
            originalSpanLen = span.len;
          }
        }

        const editRatio =
          originalSpanLen > 0 ? totalChangedChars / originalSpanLen : 1;

        if (currentSource === "ai") {
          // ai → mixed: require BOTH thresholds to be met
          if (
            editRatio < EDIT_RATIO_THRESHOLD ||
            totalChangedChars < EDIT_ABS_THRESHOLD
          ) {
            return; // Minor edit — keep as "ai"
          }

          const newMark = authorshipType.create({
            ...mark.attrs,
            source: "mixed",
          });
          tr.addMark(pos, nodeEnd, newMark);
          changed = true;
        } else if (currentSource === "mixed") {
          // mixed → human: require BOTH thresholds to be met
          if (
            editRatio < HUMAN_RATIO_THRESHOLD ||
            totalChangedChars < HUMAN_ABS_THRESHOLD
          ) {
            return; // Not enough editing — keep as "mixed"
          }

          const newMark = authorshipType.create({
            ...mark.attrs,
            source: "human",
          });
          tr.addMark(pos, nodeEnd, newMark);
          changed = true;
        }
      });

      return changed ? tr : null;
    },
  });
}
