import type { Node as PMNode } from "@tiptap/pm/model";
import type { MentionRole } from "@/features/codex/CodexMentionExtension";

export interface BeatMention {
  beatId: string;
  codexId: string;
  role: MentionRole;
}

const ROLE_PRIORITY: Record<MentionRole, number> = {
  actor: 2,
  target: 1,
  mentioned: 0,
};

/**
 * Walk the doc tree and extract all mention nodes that appear inside sceneBeat
 * nodes. When the same (beatId, codexId) pair appears multiple times, the
 * highest-priority role wins: actor > target > mentioned.
 */
export function extractBeatMentions(doc: PMNode): BeatMention[] {
  const map = new Map<string, BeatMention>();

  doc.descendants((node, _pos, parent) => {
    if (node.type.name !== "mention") return true;
    if (!parent || parent.type.name !== "sceneBeat") return true;

    const beatId = parent.attrs.id as string | undefined;
    const codexId = node.attrs.id as string | undefined;
    const role = (node.attrs.role as MentionRole) ?? "mentioned";

    if (!beatId || !codexId) return true;

    const key = `${beatId}::${codexId}`;
    const existing = map.get(key);
    if (!existing || ROLE_PRIORITY[role] > ROLE_PRIORITY[existing.role]) {
      map.set(key, { beatId, codexId, role });
    }
    return true;
  });

  return Array.from(map.values());
}
