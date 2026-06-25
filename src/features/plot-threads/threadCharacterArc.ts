import {
  deriveCellMap,
  SOURCE_PRIORITY,
  ROLE_PRIORITY,
  type CellSource,
} from "@/features/matrix/lib/deriveCells";
import type { PlotThreadLinkRow } from "./api";

/** POV ブースト: 強い中心性シグナル。mention 最大(source2+role2=4)に対し 3。 */
const POV_BOOST = 3;

export interface ArcMentionRow {
  sceneId: string;
  codexEntryId: string;
  source: CellSource;
  role?: string | null;
}

export interface RankedCharacter {
  codexEntryId: string;
  /** この糸で登場するシーン数（同一シーンの複数 source/phase は 1 と数える）。 */
  sceneCount: number;
  /** source/role 重み + POV ブーストの合計。 */
  score: number;
  /** この糸のいずれかのシーンで POV だったか。 */
  isPov: boolean;
}

/**
 * Phase 4b: スレッド境界でキャラクター（codex）を集計しランキングする純関数。
 * matrix（scene×codex グリッド）の transpose で、糸の所属シーン集合に絞って
 * codexEntryId 別に再集約する。matrix の `deriveCellMap` を再利用して
 * PK 3 重行（body/beat/relation）を 1 シーン分に collapse する。POV は mention
 * 軸ではなく scene の povCharacterId から取る（role='pov' は存在しない）。
 */
export function computeThreadCharacterArc(
  links: PlotThreadLinkRow[],
  threadId: string,
  mentions: ArcMentionRow[],
  povByScene: Map<string, string | null>,
): RankedCharacter[] {
  // 糸の所属シーン（nodeId dedup＝複数 phase マーカーでも 1 シーン）。
  const threadScenes = new Set<string>();
  for (const l of links) {
    if (l.threadId === threadId) threadScenes.add(l.nodeId);
  }
  if (threadScenes.size === 0) return [];

  // 糸のシーンに絞った mention を per-(scene,char) に collapse（3 重計上回避）。
  const inThread = mentions.filter((m) => threadScenes.has(m.sceneId));
  const cellMap = deriveCellMap(inThread);

  interface Agg {
    scenes: Set<string>;
    score: number;
    isPov: boolean;
  }
  const agg = new Map<string, Agg>();
  const get = (id: string): Agg => {
    let a = agg.get(id);
    if (!a) {
      a = { scenes: new Set(), score: 0, isPov: false };
      agg.set(id, a);
    }
    return a;
  };

  for (const [key, info] of cellMap) {
    const sep = key.indexOf("::");
    const sceneId = key.slice(0, sep);
    const codexEntryId = key.slice(sep + 2);
    const a = get(codexEntryId);
    a.scenes.add(sceneId);
    a.score += SOURCE_PRIORITY[info.topSource] + ROLE_PRIORITY[info.role];
  }

  // POV ブースト（糸の各シーンの povCharacterId）。mention 無し POV も登場させる。
  for (const sceneId of threadScenes) {
    const pov = povByScene.get(sceneId);
    if (!pov) continue;
    const a = get(pov);
    a.scenes.add(sceneId);
    a.isPov = true;
    a.score += POV_BOOST;
  }

  return [...agg.entries()]
    .map(([codexEntryId, a]) => ({
      codexEntryId,
      sceneCount: a.scenes.size,
      score: a.score,
      isPov: a.isPov,
    }))
    .sort(
      (x, y) =>
        y.score - x.score ||
        y.sceneCount - x.sceneCount ||
        (x.codexEntryId < y.codexEntryId
          ? -1
          : x.codexEntryId > y.codexEntryId
            ? 1
            : 0),
    );
}
