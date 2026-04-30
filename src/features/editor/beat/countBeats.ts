import type { Node as PMNode } from "@tiptap/pm/model";

export interface BeatCounts {
  total: number;
  generated: number;
}

/**
 * Counts placed beats and how many have a corresponding generatedProseBlock.
 */
export function countBeats(doc: PMNode): BeatCounts {
  const beatIds = new Set<string>();
  const generatedBeatIds = new Set<string>();

  doc.descendants((node) => {
    if (node.type.name === "sceneBeat") {
      const id = node.attrs.id as string | null;
      if (id) beatIds.add(id);
    } else if (node.type.name === "generatedProseBlock") {
      const beatId = node.attrs.beatId as string | null;
      if (beatId) generatedBeatIds.add(beatId);
    }
    return true;
  });

  let generated = 0;
  for (const id of beatIds) {
    if (generatedBeatIds.has(id)) generated++;
  }

  return { total: beatIds.size, generated };
}
