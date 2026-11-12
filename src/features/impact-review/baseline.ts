/**
 * impact-review: 差分基準スナップショットの永続化（impact_review_baselines）。
 * レビュー実行後に現在状態へ更新し、「前回チェック以降の変更」を求められるようにする。
 */

import { db } from "@/db/client";
import { impactReviewBaselines } from "@/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { stableStringify } from "@/features/post-effect/canonicalize";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import type { SqliteSourceRevisionGuard } from "@/features/post-effect/types";
import type { CodexSnapshot } from "./diff";

const BASELINE_CONTENT_HASH_SYMBOL = Symbol.for(
  "grimodex.impactReviewBaseline.contentHash",
);

function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** エントリの前回レビュー基準スナップショットを返す（無ければ null=初回扱い）。 */
export async function getBaseline(
  entryId: string,
): Promise<CodexSnapshot | null> {
  const rows = await db
    .select({
      snapshotJson: impactReviewBaselines.snapshotJson,
      contentHash: impactReviewBaselines.contentHash,
    })
    .from(impactReviewBaselines)
    .where(eq(impactReviewBaselines.entryId, entryId));
  if (!rows[0]) return null;
  try {
    const snapshot = JSON.parse(rows[0].snapshotJson) as CodexSnapshot;
    Object.defineProperty(snapshot, BASELINE_CONTENT_HASH_SYMBOL, {
      value: rows[0].contentHash,
      enumerable: false,
    });
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * レビュー基準を保存する。expectedContentHash 指定時は visibility metadata
 * writer と競合しないよう CAS し、古い snapshot による上書きを拒否する。
 * null は「行が存在しないこと」を期待する初回 insert。
 */
export async function saveBaseline(
  projectId: string,
  entryId: string,
  snapshot: CodexSnapshot,
  expectedContentHash?: string | null,
  sourceGuard?: SqliteSourceRevisionGuard,
): Promise<string> {
  const snapshotJson = stableStringify(snapshot);
  const contentHash = stableHash(snapshotJson);
  const reviewedAt = new Date().toISOString();
  let saved: Array<{ entryId: string }>;
  // grimodex_clock_read is the connection-local TEMP view over the in-database
  // write clock (lineage and the global sequence). Native opens it to renderer
  // SQL as the only read path of the clock (DR-DBC-5).
  const sourceRevisionPredicate: SQL | undefined = sourceGuard
    ? sql`(SELECT lineage FROM grimodex_clock_read) = ${sourceGuard.expected_lineage}
        AND (SELECT CAST(seq AS TEXT) FROM grimodex_clock_read) = ${sourceGuard.expected_seq}`
    : undefined;
  const guardedValues = sourceGuard
    ? db
        .select({
          entryId: sql<string>`${entryId}`.as("entry_id"),
          projectId: sql<string>`${projectId}`.as("project_id"),
          snapshotJson: sql<string>`${snapshotJson}`.as("snapshot_json"),
          contentHash: sql<string>`${contentHash}`.as("content_hash"),
          reviewedAt: sql<string>`${reviewedAt}`.as("reviewed_at"),
        })
        .from(sql`grimodex_clock_read`)
        .where(sourceRevisionPredicate)
    : null;

  if (expectedContentHash === undefined && guardedValues) {
    saved = await db
      .insert(impactReviewBaselines)
      .select(guardedValues)
      .onConflictDoUpdate({
        target: impactReviewBaselines.entryId,
        set: { projectId, snapshotJson, contentHash, reviewedAt },
      })
      .returning({ entryId: impactReviewBaselines.entryId });
  } else if (expectedContentHash === undefined) {
    saved = await db
      .insert(impactReviewBaselines)
      .values({ entryId, projectId, snapshotJson, contentHash, reviewedAt })
      .onConflictDoUpdate({
        target: impactReviewBaselines.entryId,
        set: { projectId, snapshotJson, contentHash, reviewedAt },
      })
      .returning({ entryId: impactReviewBaselines.entryId });
  } else if (expectedContentHash === null && guardedValues) {
    saved = await db
      .insert(impactReviewBaselines)
      .select(guardedValues)
      .onConflictDoNothing()
      .returning({ entryId: impactReviewBaselines.entryId });
  } else if (expectedContentHash === null) {
    saved = await db
      .insert(impactReviewBaselines)
      .values({ entryId, projectId, snapshotJson, contentHash, reviewedAt })
      .onConflictDoNothing()
      .returning({ entryId: impactReviewBaselines.entryId });
  } else {
    saved = await db
      .update(impactReviewBaselines)
      .set({ projectId, snapshotJson, contentHash, reviewedAt })
      .where(
        and(
          eq(impactReviewBaselines.entryId, entryId),
          eq(impactReviewBaselines.contentHash, expectedContentHash),
          sourceRevisionPredicate,
        ),
      )
      .returning({ entryId: impactReviewBaselines.entryId });
  }
  if (saved.length === 0) {
    if (sourceGuard) {
      throw new Error(
        "IMPACT_SOURCE_CHANGED: baseline or source revision changed concurrently",
      );
    }
    throw new Error("Impact baseline changed concurrently");
  }
  recordChangeEvent({
    domain: "review",
    opType: "baseline.save",
    entityType: "impact_review_baseline",
    entityId: entryId,
    payload: { entryId, contentHash },
  });
  return contentHash;
}
