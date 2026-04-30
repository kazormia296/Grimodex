import { db } from "@/db/client";
import { sceneCodexMentions } from "@/db/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import type { BeatMention } from "./extractBeatMentions";

/**
 * Upsert beat-sourced codex mentions for a scene.
 *
 * sqlite-proxy does not expose transactions (see chatApi.ts:769), so we
 * order ops to fail safely:
 *   1. Insert/upsert the desired set first — this is idempotent and never
 *      destroys data.
 *   2. Prune stale rows (source='beat' rows whose codex_entry_id is not in
 *      the desired set).
 *
 * Failure modes:
 *   - Step 1 fails → no destructive change happened.
 *   - Step 2 fails → a few stale rows linger; the next save corrects them.
 * The previous delete-then-insert order risked losing all rows when the
 * insert step failed.
 */
export async function upsertSceneBeatMentions(
  sceneId: string,
  mentions: BeatMention[],
): Promise<void> {
  if (mentions.length > 0) {
    await db
      .insert(sceneCodexMentions)
      .values(
        mentions.map((m) => ({
          sceneId,
          codexEntryId: m.codexId,
          source: "beat",
          role: m.role,
        })),
      )
      .onConflictDoUpdate({
        target: [
          sceneCodexMentions.sceneId,
          sceneCodexMentions.codexEntryId,
          sceneCodexMentions.source,
        ],
        set: { role: sql`excluded.role` },
      });
  }

  const wantedCodexIds = mentions.map((m) => m.codexId);
  const baseCondition = and(
    eq(sceneCodexMentions.sceneId, sceneId),
    eq(sceneCodexMentions.source, "beat"),
  );
  const condition =
    wantedCodexIds.length === 0
      ? baseCondition
      : and(
          baseCondition,
          notInArray(sceneCodexMentions.codexEntryId, wantedCodexIds),
        );

  await db.delete(sceneCodexMentions).where(condition);
}
