import { db } from "@/db/client";
import { authorshipSpans } from "@/db/schema";
import { inArray } from "drizzle-orm";
import type { AttributionStats } from "./attributionStats";

export interface SceneAttributionStats extends AttributionStats {
  sceneId: string;
}

/**
 * Load attribution stats for multiple scenes from the DB.
 * Returns a map of sceneId → AttributionStats.
 */
export async function loadProjectAttributionStats(
  sceneIds: string[],
): Promise<Record<string, AttributionStats>> {
  if (sceneIds.length === 0) return {};

  const spans = await db
    .select()
    .from(authorshipSpans)
    .where(inArray(authorshipSpans.nodeId, sceneIds));

  const result: Record<string, AttributionStats> = {};

  for (const span of spans) {
    const id = span.nodeId;
    if (!id) continue;
    const len = span.toPos - span.fromPos;

    if (!result[id]) {
      result[id] = {
        human: 0,
        ai: 0,
        unknown: 0,
        unmarked: 0,
        total: 0,
        modelBreakdown: {},
      };
    }

    result[id].total += len;
    switch (span.source) {
      case "human":
        result[id].human += len;
        break;
      case "ai":
        result[id].ai += len;
        {
          const model = span.model || "__unknown_model__";
          result[id].modelBreakdown[model] =
            (result[id].modelBreakdown[model] ?? 0) + len;
        }
        break;
      case "unknown":
        result[id].unknown += len;
        break;
    }
  }

  return result;
}
