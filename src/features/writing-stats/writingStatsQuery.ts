import { and, eq, gte } from "drizzle-orm";
import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { loadProjectAttributionStats } from "@/features/attribution/projectStats";
import type { AttributionStats } from "@/features/attribution/attributionStats";
import {
  getProjectUsageSummary,
  type ProjectUsageSummary,
} from "@/features/ai-usage/usageQuery";
import type { WritingEvent } from "./deriveStats";

export interface AttributionTotals {
  human: number;
  ai: number;
  unknown: number;
  total: number;
}

export interface WritingStatsData {
  events: WritingEvent[];
  attribution: AttributionTotals;
  usage: ProjectUsageSummary | null;
}

/**
 * ヒートマップの幅にあわせて ~53 週ぶんに絞る。古い payload を全件 JSON.parse する
 * のを避け、クエリも index (idx_change_events_project_ts) に素直に乗る。全期間の
 * 正確な字数が要るなら別途 Rust 集計 / 日次スナップショットへ（Phase 2）。
 */
const WINDOW_DAYS = 371;
const MS_PER_DAY = 86_400_000;

/**
 * change_events は追記専用のジャーナル（hash chain 付き）で、id は AUTOINCREMENT
 * のため再利用されない。payload は id に対して不変なので、字数をイベント id キーの
 * モジュールキャッシュに載せ、シーン追加/削除のたびに窓内全行を JSON.parse し直す
 * のを避ける（MessageBadge の messageId キャッシュと同じ FIFO 上限方式）。
 */
const insertedCharsCache = new Map<number, number>();
export const INSERTED_CHARS_CACHE_MAX = 50_000;

/** Test-only: reset the module cache between tests. */
export function _clearInsertedCharsCache(): void {
  insertedCharsCache.clear();
}

export function insertedCharsForEvent(
  eventId: number,
  payloadJson: string,
): number {
  const cached = insertedCharsCache.get(eventId);
  if (cached !== undefined) return cached;
  const chars = insertedCharsFromPayload(payloadJson);
  if (insertedCharsCache.size >= INSERTED_CHARS_CACHE_MAX) {
    const oldest = insertedCharsCache.keys().next().value;
    if (oldest !== undefined) insertedCharsCache.delete(oldest);
  }
  insertedCharsCache.set(eventId, chars);
  return chars;
}

/**
 * `change_events.payload`（`{ steps: ProseMirrorStepJSON[] }`）から挿入文字数を
 * best-effort で復元する。正味の増減は保存されていないため「挿入された文字数」の
 * 概算（削除は差し引かない）。形が想定外なら 0（フォールバックで件数表示になる）。
 */
export function insertedCharsFromPayload(payloadJson: string): number {
  try {
    const parsed = JSON.parse(payloadJson) as { steps?: unknown };
    if (!Array.isArray(parsed?.steps)) return 0;
    let total = 0;
    for (const step of parsed.steps) total += insertedCharsFromStep(step);
    return total;
  } catch {
    return 0;
  }
}

/** ReplaceStep / ReplaceAroundStep は挿入ノードを `slice.content` に持つ。 */
function insertedCharsFromStep(step: unknown): number {
  if (!step || typeof step !== "object") return 0;
  const slice = (step as { slice?: { content?: unknown } }).slice;
  return textLenInContent(slice?.content);
}

function textLenInContent(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const node of content) {
    if (!node || typeof node !== "object") continue;
    const n = node as { type?: string; text?: string; content?: unknown };
    if (n.type === "text" && typeof n.text === "string") total += n.text.length;
    else if (n.content) total += textLenInContent(n.content);
  }
  return total;
}

/**
 * 現プロジェクトの執筆統計データを読む。編集イベントの時系列・帰属合計・AI使用量を
 * 並列取得する。すべて Drizzle 経由（生 SQL 禁止）。
 */
export async function loadWritingStatsData(
  projectId: string,
  sceneIds: string[],
  now: number,
): Promise<WritingStatsData> {
  if (!projectId) {
    return {
      events: [],
      attribution: { human: 0, ai: 0, unknown: 0, total: 0 },
      usage: null,
    };
  }

  const cutoff = now - WINDOW_DAYS * MS_PER_DAY;

  const [rows, perScene, usage] = await Promise.all([
    db
      .select({
        id: changeEvents.id,
        timestamp: changeEvents.timestamp,
        payload: changeEvents.payload,
      })
      .from(changeEvents)
      .where(
        and(
          eq(changeEvents.projectId, projectId),
          eq(changeEvents.domain, "editor"),
          gte(changeEvents.timestamp, cutoff),
        ),
      ),
    sceneIds.length > 0
      ? loadProjectAttributionStats(sceneIds)
      : Promise.resolve({} as Record<string, AttributionStats>),
    getProjectUsageSummary(projectId).catch(() => null),
  ]);

  const events: WritingEvent[] = rows.map((r) => ({
    timestamp: r.timestamp,
    chars: insertedCharsForEvent(r.id, r.payload),
  }));

  const attribution: AttributionTotals = {
    human: 0,
    ai: 0,
    unknown: 0,
    total: 0,
  };
  for (const s of Object.values(perScene)) {
    attribution.human += s.human;
    attribution.ai += s.ai;
    attribution.unknown += s.unknown;
    attribution.total += s.total;
  }

  return { events, attribution, usage };
}
