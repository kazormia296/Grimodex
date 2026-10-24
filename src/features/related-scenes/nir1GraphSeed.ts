import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { codexEntries, sceneCodexPins, treeNodes } from "@/db/schema";

/** Main's bound for begin's `graphSeedEntityId` (DR-CP3A-34). */
const SEED_UTF16_MAX = 200;

/**
 * The Graph seed of a query Scene: Native's `read_nir1_graph_seed_in_tx`
 * (`nir1_packing/graph_candidates.rs`) join and order, with a narrower bound
 * (Main's 200 UTF-16, no blank id), so that Native's re-read at §3.3 agrees
 * whenever a seed is sent (DR-DI1A-6, DR-CP3B-3).
 *
 * The pins of the Scene, joined to a live Scene and a Codex entry of the same
 * project, ordered by `created_at` then `entry_id`; only the first one decides.
 * An empty, blank or over-200-UTF-16 id is no seed (Main would refuse the whole
 * begin, Raw included); the next pin is not tried, as in Native.
 */
export async function selectNir1GraphSeed(
  projectId: string,
  sceneId: string,
): Promise<string | null> {
  const rows = await db
    .select({ entryId: sceneCodexPins.entryId })
    .from(sceneCodexPins)
    .innerJoin(
      treeNodes,
      and(
        eq(treeNodes.id, sceneCodexPins.sceneId),
        eq(treeNodes.projectId, projectId),
        eq(treeNodes.nodeType, "scene"),
        isNull(treeNodes.archivedAt),
      ),
    )
    .innerJoin(
      codexEntries,
      and(
        eq(codexEntries.id, sceneCodexPins.entryId),
        eq(codexEntries.projectId, projectId),
      ),
    )
    .where(eq(sceneCodexPins.sceneId, sceneId))
    .orderBy(asc(sceneCodexPins.createdAt), asc(sceneCodexPins.entryId))
    .limit(1);
  const entryId = rows[0]?.entryId;
  if (
    typeof entryId !== "string" ||
    entryId.trim().length === 0 ||
    entryId.length > SEED_UTF16_MAX
  )
    return null;
  return entryId;
}
