/**
 * スレッドの「run（連続生存区間）」モデル。Timeline のレーン描画（plotThreadLaneModel）と
 * Scenes 左ガターの縦版ミニ・タイムライン（sceneThreadTracks）が同一の分岐/合流挙動を
 * 共有するための単一正本。座標 `c` は描画系ごとの列インデックス（Timeline=sceneX 軸列 /
 * Scenes=可視行 index）。
 */
export interface ThreadRun {
  start: number;
  end: number;
  /** この run の終端列が branch/merge の「離脱（ramp out）」列か。 */
  rampOutEnd: boolean;
}

/**
 * lo で誕生し、離脱列(leaveCols)で band が切れて不在になり、流入列(enterCols)や
 * マーカー列(markerCols)で再び現れる。離脱→次の流入の間（別レーンを走っている区間）は
 * run に含めない＝線を連続させない。
 */
export function computeThreadRuns(
  lo: number,
  hi: number,
  leaveCols: ReadonlySet<number>,
  enterCols: ReadonlySet<number>,
  markerCols: ReadonlySet<number>,
): ThreadRun[] {
  const runs: ThreadRun[] = [];
  let active = true; // lo で誕生
  let start = lo;
  for (let c = lo; c <= hi; c++) {
    if (active && leaveCols.has(c)) {
      // 離脱: band はこの列で終わり、ランプの始端へ渡す。
      runs.push({ start, end: c, rampOutEnd: true });
      active = false;
    } else if (!active && (enterCols.has(c) || markerCols.has(c))) {
      // 流入 / マーカー再出現: この列から新しい run。
      start = c;
      active = true;
      // 同一列で流入かつ即離脱（その場で別レーンへ渡る）なら 1 列 run。
      if (leaveCols.has(c)) {
        runs.push({ start, end: c, rampOutEnd: true });
        active = false;
      }
    }
  }
  if (active) runs.push({ start, end: hi, rampOutEnd: false });
  return runs;
}
