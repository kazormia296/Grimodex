import type { CodexContext } from "@/features/chat/contextBuilder";
import type { CodexEntry } from "./api";
import type { CodexRelationRow } from "./codexRelationApi";
import { extractPlainText } from "./prosemirrorTextExtractor";

const MAX_RELATION_DEPTH = 2;
const MAX_RELATION_ENTRIES = 12;

interface RelationNeighbor {
  entryId: string;
  viaLabel: string;
  depth: number;
}

function slugifyRelationType(label: string | null | undefined): string {
  const raw = (label ?? "").trim().toLowerCase();
  if (!raw) return "custom";
  return raw.replace(/\s+/g, "_").slice(0, 48) || "custom";
}

/**
 * BFS-expand Codex relations from seed entries (mentioned/pinned/always).
 * Returns lightweight CodexContext blocks tagged with relationVia for L4 pri 1.
 */
export function expandCodexRelationsBFS(
  seedEntryIds: string[],
  relations: CodexRelationRow[],
  allEntries: CodexEntry[],
  excludeIds: Set<string>,
): CodexContext[] {
  if (seedEntryIds.length === 0 || relations.length === 0) return [];

  const entryById = new Map(allEntries.map((e) => [e.id, e]));
  const adjacency = new Map<string, RelationNeighbor[]>();

  for (const rel of relations) {
    const viaForward = rel.label?.trim() || rel.relationType;
    const viaBackward = rel.label?.trim() || rel.relationType;
    const fromName = entryById.get(rel.fromCodexId)?.name ?? rel.fromCodexId;
    const toName = entryById.get(rel.toCodexId)?.name ?? rel.toCodexId;

    adjacency.set(rel.fromCodexId, [
      ...(adjacency.get(rel.fromCodexId) ?? []),
      {
        entryId: rel.toCodexId,
        viaLabel: `${viaForward} of ${fromName}`,
        depth: 0,
      },
    ]);
    adjacency.set(rel.toCodexId, [
      ...(adjacency.get(rel.toCodexId) ?? []),
      {
        entryId: rel.fromCodexId,
        viaLabel: `${viaBackward} of ${toName}`,
        depth: 0,
      },
    ]);
  }

  const seeds = new Set(seedEntryIds);
  const visited = new Set<string>([...seeds, ...excludeIds]);
  const queue: Array<{ id: string; depth: number; viaLabel: string }> = [];

  for (const seedId of seeds) {
    for (const n of adjacency.get(seedId) ?? []) {
      if (visited.has(n.entryId)) continue;
      queue.push({ id: n.entryId, depth: 1, viaLabel: n.viaLabel });
    }
  }

  const results: CodexContext[] = [];
  let qi = 0;
  while (qi < queue.length && results.length < MAX_RELATION_ENTRIES) {
    const cur = queue[qi++]!;
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);

    const entry = entryById.get(cur.id);
    if (!entry) continue;

    const summary = entry.summary ?? "";
    results.push({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      summary,
      relationVia: cur.viaLabel,
      contentFallback: summary.trim()
        ? undefined
        : extractPlainText(entry.content) || undefined,
    });

    if (cur.depth >= MAX_RELATION_DEPTH) continue;
    for (const n of adjacency.get(cur.id) ?? []) {
      if (visited.has(n.entryId)) continue;
      queue.push({
        id: n.entryId,
        depth: cur.depth + 1,
        viaLabel: n.viaLabel,
      });
    }
  }

  return results;
}

export { slugifyRelationType };
