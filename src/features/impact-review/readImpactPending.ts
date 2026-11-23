/**
 * impact-review: 影響チェックが要りそうかのローカルの読み（DR-INN-1）。
 * DB 読み 2 回（`buildCodexSnapshot`＋`getBaseline`）＋純関数だけ。AI・候補絞り
 * （`narrowCandidateScenes`）・書込みは呼ばない。失敗は呼び出し側が表示なしに畳む。
 */

import { buildCodexSnapshot } from "./snapshot";
import { getBaseline } from "./baseline";
import {
  deriveImpactPending,
  IMPACT_PENDING_NONE,
  type ImpactPending,
} from "./impactPending";

export async function readImpactPending(
  entryId: string,
): Promise<ImpactPending> {
  const [built, baseline] = await Promise.all([
    buildCodexSnapshot(entryId),
    getBaseline(entryId),
  ]);
  if (!built) return IMPACT_PENDING_NONE;
  return deriveImpactPending({ baseline, built });
}
