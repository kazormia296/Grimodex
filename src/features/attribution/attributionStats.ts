import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface AttributionStats {
  human: number;
  ai: number;
  unknown: number;
  unmarked: number;
  total: number;
}

export function computeAttributionStats(
  doc: ProseMirrorNode,
): AttributionStats {
  const stats: AttributionStats = {
    human: 0,
    ai: 0,
    unknown: 0,
    unmarked: 0,
    total: 0,
  };

  doc.descendants((node) => {
    if (!node.isText) return;
    const len = node.text?.length ?? 0;
    stats.total += len;

    const mark = node.marks.find((m) => m.type.name === "authorship");
    if (!mark) {
      stats.unmarked += len;
      return;
    }

    switch (mark.attrs.source) {
      case "human":
        stats.human += len;
        break;
      case "ai":
        stats.ai += len;
        break;
      case "unknown":
        stats.unknown += len;
        break;
      default:
        stats.unmarked += len;
    }
  });

  return stats;
}
