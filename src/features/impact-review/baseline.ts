/**
 * impact-review: 差分基準スナップショットの永続化（impact_review_baselines）。
 * レビュー実行後に現在状態へ更新し、「前回チェック以降の変更」を求められるようにする。
 */

import { db } from "@/db/client";
import { impactReviewBaselines } from "@/db/schema";
import { eq } from "drizzle-orm";
import { stableStringify } from "@/features/post-effect/canonicalize";
import type { CodexSnapshot } from "./diff";

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
    .select({ snapshotJson: impactReviewBaselines.snapshotJson })
    .from(impactReviewBaselines)
    .where(eq(impactReviewBaselines.entryId, entryId));
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].snapshotJson) as CodexSnapshot;
  } catch {
    return null;
  }
}

/** レビュー基準を現在のスナップショットへ upsert する。 */
export async function saveBaseline(
  projectId: string,
  entryId: string,
  snapshot: CodexSnapshot,
): Promise<void> {
  const snapshotJson = stableStringify(snapshot);
  const contentHash = stableHash(snapshotJson);
  const reviewedAt = new Date().toISOString();
  await db
    .insert(impactReviewBaselines)
    .values({ entryId, projectId, snapshotJson, contentHash, reviewedAt })
    .onConflictDoUpdate({
      target: impactReviewBaselines.entryId,
      set: { projectId, snapshotJson, contentHash, reviewedAt },
    });
}
