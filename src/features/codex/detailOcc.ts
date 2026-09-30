/**
 * Codex Detail Definition / Detail Value の楽観的並行制御 (OCC) 用エラー。
 *
 * 読み込み時点の `version` と DB の現行値が一致しない場合、古い編集内容で
 * 黙って上書きせず、呼び出し側へ明示的に失敗を返す。
 */
export class DetailDefinitionVersionConflictError extends Error {
  readonly definitionId: string;

  constructor(definitionId: string) {
    super(`Detail definition '${definitionId}' version conflict`);
    this.name = "DetailDefinitionVersionConflictError";
    this.definitionId = definitionId;
  }
}

export class DetailValueVersionConflictError extends Error {
  readonly entryId: string;
  readonly definitionId: string;

  constructor(entryId: string, definitionId: string) {
    super(
      `Detail value for entry '${entryId}' definition '${definitionId}' version conflict`,
    );
    this.name = "DetailValueVersionConflictError";
    this.entryId = entryId;
    this.definitionId = definitionId;
  }
}
