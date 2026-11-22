import { eq, inArray } from "drizzle-orm";

import type { CoreBodyReader, CoreReadDb } from "../../mastraRead/ports.js";
import { treeNodes } from "../db/schema.js";

/** `loadSceneContents` reads this many ids per statement (the SQLite variable limit). */
const BODY_CHUNK = 500;

/**
 * A scene body reader over a Drizzle db, with no barrier: it reads what the
 * database holds now and cannot wait for a write that has not reached it
 * (`barrier: "none"`, DR-MP4-9). Main uses this one; the renderer keeps its own
 * reader, which waits for its pending writes first.
 *
 * The statements and the result shape are those of the renderer's
 * `loadSceneContent` and `loadSceneContents`: an id with no row gives `""` (one)
 * or is absent from the map (many).
 */
export function createDbSceneBodyReader(
  getDb: () => CoreReadDb,
): CoreBodyReader {
  return {
    barrier: "none",
    async readSceneBody(sceneId) {
      const rows = await getDb()
        .select({ content: treeNodes.content })
        .from(treeNodes)
        .where(eq(treeNodes.id, sceneId));
      return rows[0]?.content ?? "";
    },
    async readSceneBodies(sceneIds) {
      const out = new Map<string, string>();
      for (let i = 0; i < sceneIds.length; i += BODY_CHUNK) {
        const slice = sceneIds.slice(i, i + BODY_CHUNK);
        if (slice.length === 0) continue;
        const rows = await getDb()
          .select({ id: treeNodes.id, content: treeNodes.content })
          .from(treeNodes)
          .where(inArray(treeNodes.id, slice));
        for (const r of rows) out.set(r.id, r.content ?? "");
      }
      return out;
    },
  };
}
