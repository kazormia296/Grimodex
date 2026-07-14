import { db } from "@/db/client";
import { sceneCodexMentions } from "@/db/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import { bumpMatrixDataVersion } from "@/features/matrix/matrixDataVersion";
import { markStart, markEnd } from "@/lib/perfLog";
import { getCodexSemanticLinkEntryIds } from "@/features/codex/semanticLinks";

/**
 * Scan the scene body for automatic mentions and explicit semantic links.
 * ProseMirror is the semantic-link source of truth; scene_codex_mentions is a
 * derived cache for Matrix/Galaxy and can always be rebuilt.
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

  markStart("bodyMention.extractPlainText");
  const text = extractPlainText(docJsonStr);
  markEnd("bodyMention.extractPlainText");

  markStart("bodyMention.findMentionedEntriesAsync");
  const matched = await findMentionedEntriesAsync(text, allEntries);
  markEnd("bodyMention.findMentionedEntriesAsync");

  const validEntryIds = new Set(allEntries.map((entry) => entry.id));
  const semanticIds = getCodexSemanticLinkEntryIds(docJsonStr).filter((id) =>
    validEntryIds.has(id),
  );
  const rows = [
    ...matched.map((entry) => ({
      sceneId,
      codexEntryId: entry.id,
      source: "body",
      role: "mentioned",
    })),
    ...semanticIds.map((entryId) => ({
      sceneId,
      codexEntryId: entryId,
      source: "semantic",
      role: "mentioned",
    })),
  ];

  if (rows.length > 0) {
    markStart("bodyMention.dbInsert");
    await db
      .insert(sceneCodexMentions)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          sceneCodexMentions.sceneId,
          sceneCodexMentions.codexEntryId,
          sceneCodexMentions.source,
        ],
        set: { role: "mentioned" },
      });
    markEnd("bodyMention.dbInsert");
  }

  const pruneSource = async (source: "body" | "semantic", ids: string[]) => {
    const baseCondition = and(
      eq(sceneCodexMentions.sceneId, sceneId),
      eq(sceneCodexMentions.source, source),
    );
    const condition =
      ids.length === 0
        ? baseCondition
        : and(baseCondition, notInArray(sceneCodexMentions.codexEntryId, ids));
    await db.delete(sceneCodexMentions).where(condition);
  };

  markStart("bodyMention.dbDelete");
  await pruneSource(
    "body",
    matched.map((entry) => entry.id),
  );
  await pruneSource("semantic", semanticIds);
  markEnd("bodyMention.dbDelete");

  bumpMatrixDataVersion();
}
