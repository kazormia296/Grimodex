/**
 * Trash Bin restorers の集約エクスポート (設計書 §14)。
 *
 * 各 restorer は pure (UI を触らない) で、新 ID で entity を再生成する。
 * UI 統合 (D&D / Popover からの呼び出し) は Phase 6 の `pickup` API で行う。
 */
export type { RestoreOutcome, RestoreResult, RestoreFailure } from "./types";
export { restoreScene } from "./scene";
export type { SceneRestoreOptions } from "./scene";
export { restoreCodexEntry } from "./codex";
export type { CodexRestoreOptions } from "./codex";
export { restoreSnippet } from "./snippet";
export type { SnippetRestoreOptions } from "./snippet";
export { restoreMapSticky } from "./mapSticky";
export type { MapStickyRestoreOptions } from "./mapSticky";
export { restoreForeshadow } from "./foreshadow";
export type { ForeshadowRestoreOptions } from "./foreshadow";
export { restorePin } from "./pin";
export { restoreGridChapter } from "./gridChapter";
export type { GridChapterRestoreOptions } from "./gridChapter";
