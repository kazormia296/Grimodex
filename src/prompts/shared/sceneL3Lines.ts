/**
 * L3「現在のシーン」の、題の次に並ぶ 2 行（時期、この場面の視点）。
 *
 * 視点（`povName`）は、場面の文脈のソース（`collectSceneContext`）だけが、Codex の
 * 開示の判定（hidden と、読めない mode と、索引に無い id を渡さない。suppress は渡す）を通した後に置く
 * （CPL/1 V1・V2）。空・空白だけなら行を出さないので、視点の無い場面の出力は変わらない。
 * L1 の作品全体の視点（`labels.pov`）とは別の label（`scenePov`）を使う。
 * 名前の予約タグの escape は、L3 全体を包む `wrapDataLayer` に任せる（題・あらすじと同じ）。
 */
/**
 * 視点の名前の上限（コードポイント数）。L3 の「題の行から ### シーン本文 まで」は
 * trim できない先頭なので、名前に長さの上限が無いと、とても長い名前（取り込みや
 * 貼り付けで作れる）がヘッダを予算の外へ押し出し、場面の本文ごと L3 が落ちる。
 * 人物の名前として十分に長い値（200）で切る（CPL/1 の判断記録 DR-CPL-3）。
 */
export const SCENE_POV_NAME_MAX_CODE_POINTS = 200;

function normalizePovName(raw: string | null | undefined): string {
  // 改行・連続空白を 1 つの空白に畳む。名前の途中の改行が L3 の新しい行になり、
  // `### シーン本文` のような偽の見出しが trim の境界を狂わせるのを防ぐ
  // （作者指定の Codex リンクの entryName と同じ畳み方）。
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= SCENE_POV_NAME_MAX_CODE_POINTS) return collapsed;
  return chars.slice(0, SCENE_POV_NAME_MAX_CODE_POINTS).join("").trimEnd();
}

export function renderSceneTimeAndPovLines(
  labels: { storyTimeLabel: string; scenePov: string },
  scene: { storyTimeLabel?: string | null; povName?: string | null },
): string {
  let lines = "";
  const time = scene.storyTimeLabel?.trim();
  if (time) lines += `\n${labels.storyTimeLabel}: ${time}`;
  const pov = normalizePovName(scene.povName);
  if (pov) lines += `\n${labels.scenePov}: ${pov}`;
  return lines;
}
