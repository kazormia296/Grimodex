import { db } from "@/db/client";
import {
  authorshipSpans,
  treeNodes,
  codexEntries,
  snippets,
} from "@/db/schema";
import { inArray, eq, and, isNotNull } from "drizzle-orm";
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
interface KnowledgeSpanRow {
  entityId: string | null;
  fromPos: number;
  toPos: number;
  source: string;
  model: string | null;
}

export async function loadKnowledgeAttributionStats(
  projectId: string,
): Promise<Record<string, KnowledgeAttributionStats>> {
  // codex / snippet を個別クエリに分け、各々 isNotNull 単独述語で対象インデックス
  // (idx_authorship_codex / idx_authorship_snippet) に乗せつつ、所有側テーブルとの
  // JOIN で現プロジェクトのみへスコープする。旧実装は OR 述語の全表スキャンに加え、
  // snippet レーンを一切スコープしておらず、マルチプロジェクト DB で他プロジェクト
  // 由来の AI 文字数が混入していた（データ漏洩）。
  const [codexSpans, snippetSpans] = await Promise.all([
    db
      .select({
        entityId: authorshipSpans.codexEntryId,
        fromPos: authorshipSpans.fromPos,
        toPos: authorshipSpans.toPos,
        source: authorshipSpans.source,
        model: authorshipSpans.model,
      })
      .from(authorshipSpans)
      .innerJoin(
        codexEntries,
        eq(authorshipSpans.codexEntryId, codexEntries.id),
      )
      .where(
        and(
          isNotNull(authorshipSpans.codexEntryId),
          eq(codexEntries.projectId, projectId),
        ),
      ),
    db
      .select({
        entityId: authorshipSpans.snippetId,
        fromPos: authorshipSpans.fromPos,
        toPos: authorshipSpans.toPos,
        source: authorshipSpans.source,
        model: authorshipSpans.model,
      })
      .from(authorshipSpans)
      .innerJoin(snippets, eq(authorshipSpans.snippetId, snippets.id))
      .where(
        and(
          isNotNull(authorshipSpans.snippetId),
          eq(snippets.projectId, projectId),
        ),
      ),
  ]);

  const result: Record<string, KnowledgeAttributionStats> = {};

  const accumulate = (lane: KnowledgeLane, rows: KnowledgeSpanRow[]) => {
    for (const span of rows) {
      const entityId = span.entityId;
      if (!entityId) continue;

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
  };

  accumulate("codex", codexSpans);
  accumulate("snippet", snippetSpans);

  return result;
}
