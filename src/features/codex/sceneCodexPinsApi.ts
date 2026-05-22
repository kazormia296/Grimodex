/**
 * Scene-level Codex pin operations.
 *
 * IMPORTANT: Always call upsertScenePin / deleteScenePin — never write directly
 * to sceneCodexPins. These functions keep scene_codex_mentions(source='relation')
 * in sync using insert-then-prune ordering (no transaction API available).
 */
import { db } from "@/db/client";
import { sceneCodexPins, sceneCodexMentions, treeNodes } from "@/db/schema";
import { eq, and, asc, sql } from "drizzle-orm";

export interface SceneCodexPin {
  sceneId: string;
  entryId: string;
  createdAt: string;
}

export async function listPinsForScene(
  sceneId: string,
): Promise<SceneCodexPin[]> {
  return db
    .select()
    .from(sceneCodexPins)
    .where(eq(sceneCodexPins.sceneId, sceneId))
    .orderBy(asc(sceneCodexPins.createdAt));
}

/** Project 内の全 scene pin を 1 クエリで取得（Grid 一括表示用）。 */
export async function listAllPinsForProject(
  projectId: string,
): Promise<SceneCodexPin[]> {
  return db
    .select({
      sceneId: sceneCodexPins.sceneId,
      entryId: sceneCodexPins.entryId,
      createdAt: sceneCodexPins.createdAt,
    })
    .from(sceneCodexPins)
    .innerJoin(treeNodes, eq(sceneCodexPins.sceneId, treeNodes.id))
    .where(eq(treeNodes.projectId, projectId))
    .orderBy(asc(sceneCodexPins.createdAt));
}

/**
 * Add a pin and sync the corresponding source='relation' row in
 * scene_codex_mentions. Uses insert-first ordering so a failure on the
 * second write leaves data intact (no phantom deletes).
 */
export async function upsertScenePin(
  sceneId: string,
  entryId: string,
): Promise<void> {
  await db
    .insert(sceneCodexPins)
    .values({ sceneId, entryId, createdAt: new Date().toISOString() })
    .onConflictDoNothing();

  await db
    .insert(sceneCodexMentions)
    .values([
      { sceneId, codexEntryId: entryId, source: "relation", role: "mentioned" },
    ])
    .onConflictDoUpdate({
      target: [
        sceneCodexMentions.sceneId,
        sceneCodexMentions.codexEntryId,
        sceneCodexMentions.source,
      ],
      set: { role: sql`excluded.role` },
    });
}

/**
 * Remove a pin and delete the corresponding source='relation' row in
 * scene_codex_mentions.
 */
export async function deleteScenePin(
  sceneId: string,
  entryId: string,
): Promise<void> {
  await db
    .delete(sceneCodexPins)
    .where(
      and(
        eq(sceneCodexPins.sceneId, sceneId),
        eq(sceneCodexPins.entryId, entryId),
      ),
    );

  await db
    .delete(sceneCodexMentions)
    .where(
      and(
        eq(sceneCodexMentions.sceneId, sceneId),
        eq(sceneCodexMentions.codexEntryId, entryId),
        eq(sceneCodexMentions.source, "relation"),
      ),
    );
}

/** @deprecated Use upsertScenePin */
export const addPin = upsertScenePin;
/** @deprecated Use deleteScenePin */
export const removePin = deleteScenePin;
