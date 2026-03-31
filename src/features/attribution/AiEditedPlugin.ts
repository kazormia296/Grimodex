import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

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
 * Overlap detection uses OLD document coordinates to avoid
 * position-mapping edge cases at node boundaries.
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

      // Step 1: Collect ai/mixed spans from the OLD document
      const oldSpans: {
        start: number;
        end: number;
        source: string;
        originalLength: number | null;
      }[] = [];
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
            source: mark.attrs.source as string,
            originalLength: mark.attrs.originalLength as number | null,
          });
        }
      });

      if (oldSpans.length === 0) return null;

      // Step 2: Determine which old spans were edited
      // Check overlap in OLD coordinate system (robust against mapping edge cases)
      const editedSpanIndices = new Set<number>();

      for (const transaction of transactions) {
        if (!transaction.docChanged) continue;
        for (let i = 0; i < transaction.steps.length; i++) {
          const stepMap = transaction.mapping.maps[i];
          // Map old span positions forward to step i's coordinate space
          const preStepMapping = transaction.mapping.slice(0, i);

          stepMap.forEach(
            (
              oldStart: number,
              oldEnd: number,
              _newStart: number,
              _newEnd: number,
            ) => {
              for (let si = 0; si < oldSpans.length; si++) {
                // Adjust span positions to step i's coordinate space
                const spanStart = preStepMapping.map(oldSpans[si].start, 1);
                const spanEnd = preStepMapping.map(oldSpans[si].end, -1);
                // Standard half-open range overlap: [oldStart, oldEnd) ∩ [spanStart, spanEnd)
                if (oldStart < spanEnd && oldEnd > spanStart) {
                  editedSpanIndices.add(si);
                }
              }
            },
          );
        }
      }

      if (editedSpanIndices.size === 0) return null;

      // Step 3: Iterate new nodes and apply transitions
      let changed = false;

      newState.doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (!node.isText) return;

        const mark = node.marks.find(
          (m) =>
            m.type === authorshipType &&
            (m.attrs.source === "ai" || m.attrs.source === "mixed"),
        );
        if (!mark) return;
        if (mark.attrs.manualOverride) return;

        const currentSource = mark.attrs.source as string;
        const nodeEnd = pos + node.nodeSize;

        // Match this new node to its closest old span
        let bestSpanIdx = -1;
        let bestDistance = Infinity;
        for (let si = 0; si < oldSpans.length; si++) {
          const span = oldSpans[si];
          const distance =
            Math.abs(span.start - pos) + Math.abs(span.end - nodeEnd);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestSpanIdx = si;
          }
        }

        // Only transition if the matched old span was actually edited
        if (bestSpanIdx < 0 || !editedSpanIndices.has(bestSpanIdx)) return;

        const matchedOldSpan = oldSpans[bestSpanIdx];

        if (currentSource === "ai") {
          // ai → mixed: immediate on any edit
          const newMark = authorshipType.create({
            ...mark.attrs,
            source: "mixed",
          });
          tr.addMark(pos, nodeEnd, newMark);
          changed = true;
        } else if (currentSource === "mixed") {
          // mixed → human: when remaining text ≤ 20% of original length
          const origLen =
            (mark.attrs.originalLength as number | null) ??
            matchedOldSpan.originalLength;
          if (origLen == null || origLen === 0) return;

          const remainingRatio = node.nodeSize / origLen;
          if (remainingRatio <= HUMAN_LENGTH_RATIO) {
            const newMark = authorshipType.create({
              ...mark.attrs,
              source: "human",
            });
            tr.addMark(pos, nodeEnd, newMark);
            changed = true;
          }
        }
      });

      return changed ? tr : null;
    },
  });
}
