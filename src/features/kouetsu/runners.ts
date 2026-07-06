/**
 * runners.ts — 校閲チェックの起動ロジック集約（公開エントリ）。
 *
 * 各ビュー（Project 系 / MetaStructure / CurrentScene 系）と Task 14 の全体
 * チェックオーケストレータが共有する
 *   ガード(policy/license) → flush → payload build → runPostEffect(Multi) →
 *   outcome 正規化
 * までを担う。**トースト表示・一覧再取得・エディタ反映は呼び出し側に残す。**
 *
 * scope はビュー側で `useResolvedKouetsuScope()` により解決済みの結果を受ける
 * （runner 内で再解決はしない）。実体は `runners/` 配下（1 effect 1 ファイル）。
 */

export type {
  KouetsuRunScope,
  KouetsuRunOutcome,
  KouetsuRunHooks,
} from "./runners/shared";

export { runTypoCheck } from "./runners/typo";
export { runReviewCheck } from "./runners/review";
export { runConsistencyCheck } from "./runners/consistency";
export { runMetaStructureCheck } from "./runners/metaStructure";
export { runTimelineCheck } from "./runners/timeline";
export { runIntentDriftCheck } from "./runners/intentDrift";
export type { IntentDriftRunOptions } from "./runners/intentDrift";
