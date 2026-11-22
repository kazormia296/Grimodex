/**
 * L3「現在のシーン」の、題の次に並ぶ 2 行（時期、この場面の視点）。
 *
 * 視点（`povName`）は、場面の文脈のソース（`collectSceneContext`）だけが、Codex の
 * 開示の判定（hidden・suppress・自動の除外・索引に無い id を渡さない）を通した後に置く
 * （CPL/1 V1・V2）。空・空白だけなら行を出さないので、視点の無い場面の出力は変わらない。
 * L1 の作品全体の視点（`labels.pov`）とは別の label（`scenePov`）を使う。
 * 名前の予約タグの escape は、L3 全体を包む `wrapDataLayer` に任せる（題・あらすじと同じ）。
 */
export function renderSceneTimeAndPovLines(
  labels: { storyTimeLabel: string; scenePov: string },
  scene: { storyTimeLabel?: string | null; povName?: string | null },
): string {
  let lines = "";
  const time = scene.storyTimeLabel?.trim();
  if (time) lines += `\n${labels.storyTimeLabel}: ${time}`;
  const pov = scene.povName?.trim();
  if (pov) lines += `\n${labels.scenePov}: ${pov}`;
  return lines;
}
