import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  codexEntries,
  sceneCodexMentions,
  sceneCodexPins,
  treeNodes,
} from "@/db/schema";

/**
 * 起点（Graph の seed）の候補と、起点の名前の読み取り（DR-SEEDSUG-2）。
 *
 * 読むだけで、何も書かず、何も保存しない（候補の表・列・キャッシュを作らない）。
 * 起点そのものの規則は `selectNir1GraphSeed`（`nir1GraphSeed.ts`）だけが決め、
 * ここは pin が無いときに作者へ見せる候補を並べる。Graph 節の lazy chunk だけが
 * import する（`NIR1_GRAPH_UI_ENABLED` が false の間は起動時の graph に入らない）。
 */

export type Nir1GraphSeedCandidateReason = "pov" | "beat-actor" | "body";

export interface Nir1GraphSeedCandidate {
  readonly entryId: string;
  readonly name: string;
  readonly reason: Nir1GraphSeedCandidateReason;
}

export const NIR1_GRAPH_SEED_CANDIDATE_LIMIT = 3;

/** `selectNir1GraphSeed` の境界と同じ（Main の begin の 200 UTF-16、空白だけの ID は無効）。 */
const SEED_UTF16_MAX = 200;

const RANK: Record<Nir1GraphSeedCandidateReason, number> = {
  pov: 0,
  "beat-actor": 1,
  body: 2,
};

function seedable(entryId: string): boolean {
  return entryId.trim().length > 0 && entryId.length <= SEED_UTF16_MAX;
}

/**
 * Scene の起点の候補を最大 `limit` 件、決まった順で返す。
 *
 * 順位：(1) Scene の POV 人物、(2) beat の言及で role が actor、(3) 本文の言及
 * （source が body か semantic）。同順位は `entry_id` の昇順。1 つの項目は最も高い
 * 順位で 1 回だけ。結合は `selectNir1GraphSeed` と同じ（同じ project の archived で
 * ない Scene、同じ project の Codex 項目）。この Scene に pin 済みの項目と、起点に
 * なりえない ID（空白だけ、200 UTF-16 超）は出さない。
 */
export async function selectNir1GraphSeedCandidates(
  projectId: string,
  sceneId: string,
  limit = NIR1_GRAPH_SEED_CANDIDATE_LIMIT,
): Promise<Nir1GraphSeedCandidate[]> {
  const scene = await db
    .select({ pov: codexEntries.id, povName: codexEntries.name })
    .from(treeNodes)
    .leftJoin(
      codexEntries,
      and(
        eq(codexEntries.id, treeNodes.povCharacterId),
        eq(codexEntries.projectId, projectId),
      ),
    )
    .where(
      and(
        eq(treeNodes.id, sceneId),
        eq(treeNodes.projectId, projectId),
        eq(treeNodes.nodeType, "scene"),
        isNull(treeNodes.archivedAt),
      ),
    )
    .limit(1);
  if (scene.length === 0) return [];

  const mentions = await db
    .select({
      entryId: sceneCodexMentions.codexEntryId,
      name: codexEntries.name,
      source: sceneCodexMentions.source,
    })
    .from(sceneCodexMentions)
    .innerJoin(
      codexEntries,
      and(
        eq(codexEntries.id, sceneCodexMentions.codexEntryId),
        eq(codexEntries.projectId, projectId),
      ),
    )
    .where(
      and(
        eq(sceneCodexMentions.sceneId, sceneId),
        or(
          and(
            eq(sceneCodexMentions.source, "beat"),
            eq(sceneCodexMentions.role, "actor"),
          ),
          inArray(sceneCodexMentions.source, ["body", "semantic"]),
        ),
      ),
    );
  const pinned = new Set(
    (
      await db
        .select({ entryId: sceneCodexPins.entryId })
        .from(sceneCodexPins)
        .where(eq(sceneCodexPins.sceneId, sceneId))
    ).map((row) => row.entryId),
  );

  const best = new Map<string, Nir1GraphSeedCandidate>();
  const offer = (
    entryId: string,
    name: string,
    reason: Nir1GraphSeedCandidateReason,
  ) => {
    if (pinned.has(entryId) || !seedable(entryId)) return;
    const kept = best.get(entryId);
    if (!kept || RANK[reason] < RANK[kept.reason])
      best.set(entryId, { entryId, name, reason });
  };
  const { pov, povName } = scene[0]!;
  if (pov !== null && povName !== null) offer(pov, povName, "pov");
  for (const row of mentions)
    offer(row.entryId, row.name, row.source === "beat" ? "beat-actor" : "body");

  return [...best.values()]
    .sort(
      (a, b) =>
        RANK[a.reason] - RANK[b.reason] ||
        (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0),
    )
    .slice(0, limit);
}

/** 起点の項目の名前（同じ project の Codex 項目だけ）。無ければ null。 */
export async function readNir1GraphSeedEntryName(
  projectId: string,
  entryId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: codexEntries.name })
    .from(codexEntries)
    .where(
      and(eq(codexEntries.id, entryId), eq(codexEntries.projectId, projectId)),
    )
    .limit(1);
  return rows[0]?.name ?? null;
}
