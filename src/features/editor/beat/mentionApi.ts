import { db } from "@/db/client";
import { sceneCodexMentions } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { BeatMention } from "./extractBeatMentions";

/**
 * Upsert beat-sourced codex mentions for a scene.
 * Replaces all existing rows with source='beat' for this scene with the
 * current set derived from extractBeatMentions().
 */
export async function upsertSceneBeatMentions(
  sceneId: string,
  mentions: BeatMention[],
): Promise<void> {
  await db
    .delete(sceneCodexMentions)
    .where(
      and(
        eq(sceneCodexMentions.sceneId, sceneId),
        eq(sceneCodexMentions.source, "beat"),
      ),
    );

  if (mentions.length === 0) return;

  await db.insert(sceneCodexMentions).values(
    mentions.map((m) => ({
      sceneId,
      codexEntryId: m.codexId,
      source: "beat",
      role: m.role,
    })),
  );
}
