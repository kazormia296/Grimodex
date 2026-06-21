import { useLintStore } from "./lintStore";
import { useLintIgnoreStore } from "./lintIgnoreStore";
import { useLintProjectStore } from "./lintProjectStore";

/**
 * Project モードで Fix を適用すると、本文編集＋再 Lint（runLintNow）の結果は
 * 現在シーンのライブ Lint である `lintStore` にだけ書き込まれる。一方
 * Project パネルは `lintProjectStore.scenes[]`（プロジェクトスキャン時の
 * スナップショット）を描画しているため、同期しないと直したはずの診断
 * （ja/dash-single 等）が出続ける。current シーンモードは `lintStore` を
 * 直接読むため、この乖離は起きない。
 *
 * このヘルパは settle した（再 Lint 完了済みの）ライブ Lint の最新結果を
 * Project ストアへ反映する（subscribeProjectSnapshotToLiveLint から呼ぶ）。
 * onIgnore と同じ
 * 「raw → filterDiagnostics → replaceSceneDiagnostics」パターンを踏襲する:
 *   - `scanProject` は永続無視フィルタ未適用の raw 診断を格納するので、
 *     ここでも `rawDiagnostics` を起点に `filterDiagnostics` を通す
 *     （無視済みの診断は出さない）。
 *   - Fix で本文が変わって `sceneText` がずれるため、`sceneText` も最新へ
 *     更新する（後続 onIgnore のオフセット照合が壊れないように）。
 */
export function syncProjectSceneFromLiveLint(sceneId: string): void {
  const live = useLintStore.getState();
  // 別シーンの再 Lint が割り込んで lintStore を上書きしていたら、その診断は
  // sceneId のものではない。別シーンのデータで Project ストアを汚染しない
  // よう、その場合は何もしない。
  if (live.currentSceneId !== sceneId) return;
  const filtered = useLintIgnoreStore
    .getState()
    .filterDiagnostics(sceneId, live.rawDiagnostics, live.lastSceneText);
  useLintProjectStore
    .getState()
    .replaceSceneDiagnostics(sceneId, filtered, live.lastSceneText);
}

/**
 * Project パネル表示中、ライブ Lint（lintStore）が settle するたびに、その
 * 結果を Project スナップショットの該当シーンへ反映し続ける購読を張る。
 *
 * 一発同期（runLintNow 直後に読む）では競合に弱い: `runLintNow` は
 * Codex/用語辞書フェッチを await してから runLint を呼ぶため、フェッチが
 * debounce 再 Lint(500ms) を跨ぐと即時 run がデバウンス run に超越され、
 * early-return（set なし）→ 直後の読みが pre-fix のままになりうる。
 *
 * 代わりに「どの run であれ完了（isLinting true→false）した時点の最新結果」
 * を反映すれば、勝った run の結果が必ず載る。これは current シーンモードが
 * lintStore を直読みして常に最新を映すのと同じ鮮度を Project 側へもたらす。
 *
 * 反映対象は「スキャン済み（スナップショットに存在する）シーン」だけ。
 * 未スキャンのシーンへ勝手に追加はしない。返り値は購読解除関数。
 */
export function subscribeProjectSnapshotToLiveLint(): () => void {
  return useLintStore.subscribe((state, prev) => {
    // Lint が完了した瞬間（true→false）だけに反応する。カーソル移動など
    // isLinting を跨がない set は無視。
    if (state.isLinting || !prev.isLinting) return;
    const sceneId = state.currentSceneId;
    if (!sceneId) return;
    // スキャン済みのシーンのみ更新（snapshot に無いシーンは触らない）。
    const inSnapshot = useLintProjectStore
      .getState()
      .scenes.some((s) => s.sceneId === sceneId);
    if (!inSnapshot) return;
    syncProjectSceneFromLiveLint(sceneId);
  });
}
