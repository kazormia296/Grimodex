/**
 * Codex Phase の楽観的並行制御 (OCC) 用エラー。
 *
 * 読み込み時点の `version` と DB の現行値が一致しない場合、古い編集内容で
 * 新しい Phase を黙って上書きせず、呼び出し側へ明示的に失敗を返す。
 */
export class PhaseVersionConflictError extends Error {
  readonly phaseId: string;

  constructor(phaseId: string) {
    super(`Phase '${phaseId}' version conflict`);
    this.name = "PhaseVersionConflictError";
    this.phaseId = phaseId;
  }
}
