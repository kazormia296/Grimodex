import { db } from "@/db/client";
import { authorshipSpans, treeNodes } from "@/db/schema";
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

  const [spans, nodes] = await Promise.all([
    db
      .select()
      .from(authorshipSpans)
      .where(inArray(authorshipSpans.nodeId, sceneIds)),
    db
      .select({ id: treeNodes.id, charCount: treeNodes.charCount })
      .from(treeNodes)
      .where(inArray(treeNodes.id, sceneIds)),
  ]);

  const result: Record<string, AttributionStats> = {};
  for (const n of nodes) {
    result[n.id] = {
      human: 0,
      ai: 0,
      unknown: 0,
      unmarked: 0,
      total: n.charCount,
      modelBreakdown: {},
    };
  }

  for (const span of spans) {
    const id = span.nodeId;
    if (!id || !result[id]) continue;
    const len = span.toPos - span.fromPos;
    switch (span.source) {
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

  for (const id of Object.keys(result)) {
    const r = result[id];
    // treeNodes.charCount excludes sceneBeat-internal text, but
    // authorshipSpans can still cover it. When ai+unknown exceed the
    // body-only total, bump total so percentages stay <=100% across all
    // consumers (UI rows, disclosure report, JSON/HTML/MD export).
    if (r.ai + r.unknown > r.total) r.total = r.ai + r.unknown;
    r.human = Math.max(0, r.total - r.ai - r.unknown);
  }

  return result;
}
