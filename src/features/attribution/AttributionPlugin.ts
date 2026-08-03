import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useAttributionStore } from "./attributionStore";
import type { FilterSource } from "./attributionStore";

export const attributionKey = new PluginKey("attribution");

interface DocumentRange {
  from: number;
  to: number;
}

function decorationForTextNode(
  node: ProseMirrorNode,
  pos: number,
  filterSource: FilterSource,
): Decoration | null {
  const mark = node.marks.find(
    (candidate) => candidate.type.name === "authorship",
  );
  const source = (mark?.attrs.source as string) ?? "human";
  const len = node.nodeSize;

  if (filterSource !== null) {
    const matches =
      source === filterSource || (filterSource === "human" && !mark);
    if (!matches) {
      return Decoration.inline(pos, pos + len, {
        class: "attribution-dimmed",
      });
    }
    if (source !== "human") {
      const classMap: Record<string, string> = {
        ai: "attribution-ai",
        unknown: "attribution-unknown",
      };
      return Decoration.inline(pos, pos + len, {
        class: classMap[source] ?? "attribution-unknown",
      });
    }
    return null;
  }

  if (source === "human") return null;
  const classMap: Record<string, string> = {
    ai: "attribution-ai",
    unknown: "attribution-unknown",
  };
  const isManualOverride = mark?.attrs.manualOverride === true;
  const classes = [
    classMap[source] ?? "attribution-unknown",
    isManualOverride ? "attribution-manual-override" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return Decoration.inline(pos, pos + len, {
    class: classes,
    "data-attribution-source": source,
    "data-attribution-model": mark?.attrs.model ?? "",
    "data-attribution-timestamp": mark?.attrs.timestamp ?? "",
    "data-attribution-message-id": mark?.attrs.chatMessageId ?? "",
    "data-manual-override": isManualOverride ? "true" : "",
  });
}

function buildDecorations(
  doc: ProseMirrorNode,
  filterSource: FilterSource,
): DecorationSet {
  const decos: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const decoration = decorationForTextNode(node, pos, filterSource);
    if (decoration) decos.push(decoration);
  });

  return DecorationSet.create(doc, decos);
}

function readStepJson(
  step: Transaction["steps"][number],
): Record<string, unknown> | null {
  try {
    const json = step.toJSON();
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    return json as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Return changed ranges in the final transaction document. `null` means an
 * unknown mapless step shape and requests the correctness-preserving full
 * rebuild fallback.
 */
function changedRangesInFinalDocument(tr: Transaction): DocumentRange[] | null {
  const ranges: DocumentRange[] = [];

  for (let stepIndex = 0; stepIndex < tr.steps.length; stepIndex += 1) {
    const step = tr.steps[stepIndex];
    const stepMap = step.getMap();
    const trailingMapping = tr.mapping.slice(stepIndex + 1);
    let mappedRangeCount = 0;
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      mappedRangeCount += 1;
      ranges.push({
        from: trailingMapping.map(newStart, -1),
        to: trailingMapping.map(newEnd, 1),
      });
    });
    if (mappedRangeCount > 0) continue;

    const json = readStepJson(step);
    const stepType = json?.stepType;
    if (stepType === "docAttr") continue;
    if (stepType === "addMark" || stepType === "removeMark") {
      const from = json?.from;
      const to = json?.to;
      if (typeof from !== "number" || typeof to !== "number") return null;
      ranges.push({
        from: trailingMapping.map(from, -1),
        to: trailingMapping.map(to, 1),
      });
      continue;
    }
    if (
      stepType === "attr" ||
      stepType === "addNodeMark" ||
      stepType === "removeNodeMark"
    ) {
      const pos = json?.pos;
      if (typeof pos !== "number") return null;
      ranges.push({
        from: trailingMapping.map(pos, -1),
        to: trailingMapping.map(pos, 1),
      });
      continue;
    }
    return null;
  }

  return ranges;
}

function addTextblockAtPosition(
  doc: ProseMirrorNode,
  pos: number,
  ranges: DocumentRange[],
): void {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) return;
  const resolved = doc.resolve(pos);
  for (let depth = resolved.depth; depth >= 1; depth -= 1) {
    const node = resolved.node(depth);
    if (!node.isTextblock) continue;
    ranges.push({
      from: resolved.start(depth),
      to: resolved.end(depth),
    });
    return;
  }
}

function changedTextblockRanges(
  tr: Transaction,
  doc: ProseMirrorNode,
): DocumentRange[] | null {
  const changed = changedRangesInFinalDocument(tr);
  if (changed === null) return null;

  const textblocks: DocumentRange[] = [];
  for (const range of changed) {
    const from = Math.max(0, Math.min(range.from, doc.content.size));
    const to = Math.max(from, Math.min(range.to, doc.content.size));
    addTextblockAtPosition(doc, from, textblocks);
    addTextblockAtPosition(doc, to, textblocks);
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      textblocks.push({ from: pos + 1, to: pos + 1 + node.content.size });
      return false;
    });
  }

  textblocks.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: DocumentRange[] = [];
  for (const range of textblocks) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function buildDecorationsInRanges(
  doc: ProseMirrorNode,
  filterSource: FilterSource,
  ranges: readonly DocumentRange[],
): Decoration[] {
  const decorations: Decoration[] = [];
  for (const range of ranges) {
    doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (!node.isText) return true;
      const decoration = decorationForTextNode(node, pos, filterSource);
      if (decoration) decorations.push(decoration);
      return false;
    });
  }
  return decorations;
}

function updateDecorations(
  tr: Transaction,
  oldDecorations: DecorationSet,
  doc: ProseMirrorNode,
  filterSource: FilterSource,
): DecorationSet {
  const ranges = changedTextblockRanges(tr, doc);
  if (ranges === null) return buildDecorations(doc, filterSource);

  let decorations = oldDecorations.map(tr.mapping, doc);
  for (const range of ranges) {
    const stale = decorations.find(range.from, range.to);
    if (stale.length > 0) decorations = decorations.remove(stale);
  }
  const replacements = buildDecorationsInRanges(doc, filterSource, ranges);
  return replacements.length > 0
    ? decorations.add(doc, replacements)
    : decorations;
}

export function createAttributionPlugin(): Plugin {
  return new Plugin({
    key: attributionKey,
    state: {
      init(_, { doc }) {
        const { showAttribution, filterSource } =
          useAttributionStore.getState();
        return showAttribution
          ? buildDecorations(doc, filterSource)
          : DecorationSet.empty;
      },
      apply(tr, oldDecos, _oldState, newState) {
        const { showAttribution, filterSource } =
          useAttributionStore.getState();
        if (!showAttribution) return DecorationSet.empty;

        if (tr.getMeta("attributionUpdate") === true) {
          return buildDecorations(newState.doc, filterSource);
        }

        if (tr.docChanged) {
          return updateDecorations(tr, oldDecos, newState.doc, filterSource);
        }

        return oldDecos.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return attributionKey.getState(state);
      },
    },
  });
}
