import { db } from "@/db/client";
import { authorshipSpans, treeNodes, codexEntries } from "@/db/schema";
import { inArray, eq, and, isNotNull, or } from "drizzle-orm";
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

export type KnowledgeLane = "codex" | "snippet";

export interface KnowledgeAttributionStats extends AttributionStats {
  lane: KnowledgeLane;
  entityId: string;
}

/**
 * Load attribution stats for Codex/Snippet owner lanes (non-scene content).
 * Returns per-entity stats keyed by `${lane}:${entityId}`.
 */
export async function loadKnowledgeAttributionStats(
  projectId: string,
): Promise<Record<string, KnowledgeAttributionStats>> {
  const spans = await db
    .select()
    .from(authorshipSpans)
    .where(
      or(
        isNotNull(authorshipSpans.codexEntryId),
        isNotNull(authorshipSpans.snippetId),
      ),
    );

  const result: Record<string, KnowledgeAttributionStats> = {};

  for (const span of spans) {
    const lane: KnowledgeLane | null = span.codexEntryId
      ? "codex"
      : span.snippetId
        ? "snippet"
        : null;
    const entityId = span.codexEntryId ?? span.snippetId;
    if (!lane || !entityId) continue;

    const key = `${lane}:${entityId}`;
    if (!result[key]) {
      result[key] = {
        lane,
        entityId,
        human: 0,
        ai: 0,
        unknown: 0,
        unmarked: 0,
        total: 0,
        modelBreakdown: {},
      };
    }
    const len = span.toPos - span.fromPos;
    result[key].total += len;
    switch (span.source) {
      case "ai":
        result[key].ai += len;
        {
          const model = span.model || "__unknown_model__";
          result[key].modelBreakdown[model] =
            (result[key].modelBreakdown[model] ?? 0) + len;
        }
        break;
      case "human":
        result[key].human += len;
        break;
      case "unknown":
        result[key].unknown += len;
        break;
    }
  }

  // Filter to project scope via a lightweight join check
  const codexIds = [
    ...new Set(
      Object.values(result)
        .filter((r) => r.lane === "codex")
        .map((r) => r.entityId),
    ),
  ];
  if (codexIds.length > 0) {
    const rows = await db
      .select({ id: codexEntries.id })
      .from(codexEntries)
      .where(
        and(
          eq(codexEntries.projectId, projectId),
          inArray(codexEntries.id, codexIds),
        ),
      );
    const allowed = new Set(rows.map((r) => r.id));
    for (const key of Object.keys(result)) {
      const r = result[key];
      if (r.lane === "codex" && !allowed.has(r.entityId)) delete result[key];
    }
  }

  return result;
}
