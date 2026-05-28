import type { CodexContext } from "@/features/chat/contextBuilder";
import type { CodexEntry } from "./api";
import type { CodexRelationRow } from "./codexRelationApi";
import { extractPlainText } from "./prosemirrorTextExtractor";

export const DEFAULT_MAX_RELATION_DEPTH = 2;
export const DEFAULT_MAX_RELATION_ENTRIES = 12;

interface RelationNeighbor {
  entryId: string;
  viaLabel: string;
  depth: number;
}

export interface ExpandRelationsOptions {
  /** Max BFS depth from any seed (default 2). */
  maxDepth?: number;
  /** Max total entries returned across the BFS (default 12). */
  maxEntries?: number;
}

function slugifyRelationType(label: string | null | undefined): string {
  const raw = (label ?? "").trim().toLowerCase();
  if (!raw) return "custom";
  return raw.replace(/\s+/g, "_").slice(0, 48) || "custom";
}

/**
 * relationVia は contextBuilder で可視プロース行 (`経由: ...`) として system
 * prompt に注入される。旧実装は HTML コメントだったため `--` が含まれると
 * コメント境界が壊れる懸念から `--` → `- -` の置換を入れていた。現在は
 * 可視プロースに移行したのでこの defense は厳密には不要だが、user 入力中の
 * `--` が prompt 上で見栄えを乱す可能性 (markdown 等) を防ぐ意味で残している。
 */
function sanitizeForHtmlComment(text: string): string {
  return text.replace(/--/g, "- -");
}

/**
 * BFS-expand Codex relations from seed entries (mentioned/pinned/always).
 * Returns lightweight CodexContext blocks tagged with relationVia for L4 pri 1.
 *
 * The `relationVia` text encodes traversal direction so the LLM can tell who
 * is the source of the edge: forward (seed→target) uses `from {seedName} via {label}`
 * and backward (seed→source) uses `to {seedName} via {label}`. We avoid the
 * old `${label} of ${name}` wording because it implied the discovered entry
 * filled the {label} role of {name}, which is wrong for directional relations.
 */
export function expandCodexRelationsBFS(
  seedEntryIds: string[],
  relations: CodexRelationRow[],
  allEntries: CodexEntry[],
  excludeIds: Set<string>,
  options: ExpandRelationsOptions = {},
): CodexContext[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_RELATION_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_RELATION_ENTRIES;
  if (seedEntryIds.length === 0 || relations.length === 0) return [];

  const entryById = new Map(allEntries.map((e) => [e.id, e]));
  const adjacency = new Map<string, RelationNeighbor[]>();

  for (const rel of relations) {
    const label = sanitizeForHtmlComment(rel.label?.trim() || rel.relationType);
    const fromName = sanitizeForHtmlComment(
      entryById.get(rel.fromCodexId)?.name ?? rel.fromCodexId,
    );
    const toName = sanitizeForHtmlComment(
      entryById.get(rel.toCodexId)?.name ?? rel.toCodexId,
    );

    adjacency.set(rel.fromCodexId, [
      ...(adjacency.get(rel.fromCodexId) ?? []),
      {
        entryId: rel.toCodexId,
        viaLabel: `from ${fromName} via ${label}`,
        depth: 0,
      },
    ]);
    adjacency.set(rel.toCodexId, [
      ...(adjacency.get(rel.toCodexId) ?? []),
      {
        entryId: rel.fromCodexId,
        viaLabel: `to ${toName} via ${label}`,
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
  while (qi < queue.length && results.length < maxEntries) {
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

    if (cur.depth >= maxDepth) continue;
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
