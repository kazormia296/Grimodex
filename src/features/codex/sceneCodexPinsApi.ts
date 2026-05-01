import { db } from "@/db/client";
import { sceneCodexPins } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";

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

export async function addPin(sceneId: string, entryId: string): Promise<void> {
  await db
    .insert(sceneCodexPins)
    .values({ sceneId, entryId, createdAt: new Date().toISOString() })
    .onConflictDoNothing();
}

export async function removePin(
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
}
