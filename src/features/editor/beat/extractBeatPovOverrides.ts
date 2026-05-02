import type { Node as PMNode } from "@tiptap/pm/model";

// Store ALL beat POVs (not only those differing from scene POV) so render-time
// logic can handle the scene POV independently — robust against scene POV changes
// that happen outside coreSave.
export function extractBeatPovOverrides(doc: PMNode): string[] {
  const set = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name !== "sceneBeat") return true;
    const pov = node.attrs.pov as string | null | undefined;
    if (pov) set.add(pov);
    return true;
  });
  return Array.from(set);
}
