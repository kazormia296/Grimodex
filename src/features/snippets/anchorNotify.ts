/**
 * Snippet 削除を chat スコープへ通知する DI フック。
 *
 * snippetStore から chatStore を直接 import すると、snippetStore を import する
 * 全コンポーネント (PinEntryDialog 等) のテスト module graph に chatStore が
 * 連鎖して入る (codexStore→chatStore で前例のある汚染、f2d2f00b 参照)。
 * globalHistoryStore の setUndoConflictHandler と同じ leaf-module DI で切り離す。
 * ハンドラ登録は chatStore モジュール初期化時に行われる。
 */
type SnippetDeletedHandler = (snippetId: string) => void;

let handler: SnippetDeletedHandler | null = null;

export function setSnippetDeletedHandler(h: SnippetDeletedHandler): void {
  handler = h;
}

export function notifySnippetDeleted(snippetId: string): void {
  handler?.(snippetId);
}
