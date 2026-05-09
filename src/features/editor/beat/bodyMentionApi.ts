import { db } from "@/db/client";
import { sceneCodexMentions } from "@/db/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import { bumpMatrixDataVersion } from "@/features/matrix/matrixDataVersion";

/**
 * Scan the scene's body doc for Codex mentions and upsert source='body' rows.
 *
 * Uses the same insert-then-prune ordering as upsertSceneBeatMentions to
 * avoid data loss when the prune step fails.
 *
 * No-op when allEntries is empty (matcher would have no patterns to match).
 */
export async function upsertSceneBodyMentions(
  sceneId: string,
  docJsonStr: string,
  allEntries: CodexMatchTarget[],
): Promise<void> {
  if (allEntries.length === 0) return;

  const text = extractPlainText(docJsonStr);
  const matched = await findMentionedEntriesAsync(text, allEntries);

  if (matched.length > 0) {
    await db
      .insert(sceneCodexMentions)
      .values(
        matched.map((e) => ({
          sceneId,
          codexEntryId: e.id,
          source: "body",
          role: "mentioned",
        })),
      )
      .onConflictDoUpdate({
        target: [
          sceneCodexMentions.sceneId,
          sceneCodexMentions.codexEntryId,
          sceneCodexMentions.source,
        ],
        set: { role: "mentioned" },
      });
  }

  const wantedIds = matched.map((e) => e.id);
  const baseCondition = and(
    eq(sceneCodexMentions.sceneId, sceneId),
    eq(sceneCodexMentions.source, "body"),
  );
  const condition =
    wantedIds.length === 0
      ? baseCondition
      : and(
          baseCondition,
          notInArray(sceneCodexMentions.codexEntryId, wantedIds),
        );

  await db.delete(sceneCodexMentions).where(condition);

  bumpMatrixDataVersion();
}
