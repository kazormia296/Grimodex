/**
 * ドラッグ操作のグリッド吸着（純関数・決定性）。
 * 「見えている目盛り(tickDays)」の最も近い 1 本へ吸着し、閾値外なら整数日へ丸める。
 */

/**
 * rawDay を tickDays の最近傍へ吸着する。最近傍との距離が maxDistDays 以下なら
 * その目盛り日を、超えるなら Math.round(rawDay)（整数日グリッド）を返す。
 * tickDays が空なら整数日へ丸める。
 */
export function snapDayToTicks(
  rawDay: number,
  tickDays: number[],
  maxDistDays: number,
): number {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const td of tickDays) {
    const dist = Math.abs(td - rawDay);
    if (dist < bestDist) {
      bestDist = dist;
      best = td;
    }
  }
  if (best != null && bestDist <= maxDistDays) return best;
  return Math.round(rawDay);
}
