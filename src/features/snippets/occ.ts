/**
 * Snippet の楽観的並行制御 (OCC) 用エラー。codex/occ.ts の
 * CodexVersionConflictError と対称。
 *
 * `version` 列 (src-tauri/src/database/migrate.rs が追加・AI/agent 書き込み経路で
 * 既に使用) を人間保存経路にも通すために使う。別窓 / 別プロセスが同じ snippet を
 * 先に更新していて base_version が一致しなかった場合に投げる。呼び出し側は本文を
 * 黙って上書きせず、非破壊で再読み込みを促す。
 */
export class SnippetVersionConflictError extends Error {
  readonly snippetId: string;
  constructor(snippetId: string) {
    super(`Snippet '${snippetId}' version conflict`);
    this.name = "SnippetVersionConflictError";
    this.snippetId = snippetId;
  }
}
