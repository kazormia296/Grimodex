import { db } from "@/db/client";
import { sceneBeatPovCache } from "@/db/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { bumpMatrixDataVersion } from "@/features/matrix/matrixDataVersion";

export async function listSceneBeatPovOverrides(
  sceneId: string,
): Promise<string[]> {
  const rows = await db
    .select({ povCharacterId: sceneBeatPovCache.povCharacterId })
    .from(sceneBeatPovCache)
    .where(eq(sceneBeatPovCache.sceneId, sceneId));
  return rows.map((r) => r.povCharacterId);
}

export async function upsertSceneBeatPovOverrides(
  sceneId: string,
  povCharIds: string[],
): Promise<void> {
  if (povCharIds.length > 0) {
    await db
      .insert(sceneBeatPovCache)
      .values(povCharIds.map((id) => ({ sceneId, povCharacterId: id })))
      .onConflictDoNothing();
  }
  const baseCondition = eq(sceneBeatPovCache.sceneId, sceneId);
  const condition =
    povCharIds.length === 0
      ? baseCondition
      : and(
          baseCondition,
          notInArray(sceneBeatPovCache.povCharacterId, povCharIds),
        );
  await db.delete(sceneBeatPovCache).where(condition);

  bumpMatrixDataVersion();
}
