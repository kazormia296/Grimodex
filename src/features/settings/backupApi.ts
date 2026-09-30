import { invoke } from "@/lib/tauri";
import type { WorkspaceRestoreOutcome } from "@/../electron/shared/workspaceRestoreOutcome";

/**
 * `<ws>/backups/` に置かれた 1 バックアップのメタ情報。Rust の
 * `commands::workspace::BackupInfo` と対（backup restore Phase 1）。
 */
export interface BackupInfo {
  /** `<ws>/backups/` 内のファイル名（basename）。restoreBackup にそのまま渡す。 */
  fileName: string;
  sizeBytes: number;
  /** mtime（epoch ms）。 */
  modifiedMs: number;
  /** "db"（無圧縮）| "db.gz"（Phase 2）。Phase 1 は "db" のみ復元可。 */
  format: string;
}

/** アクティブ workspace の backups/ を新しい順で列挙する。 */
export function listBackups(): Promise<BackupInfo[]> {
  return invoke<BackupInfo[]>("list_backups");
}

/**
 * 選択したバックアップでアクティブ workspace の grimodex.db を置き換える。
 * Rust 側で復元前の安全退避 → 接続クローズ → ファイル置換 → 再オープンまで行う。
 * 呼び出し側は成功後に `window.location.reload()` して全状態を作り直すこと。
 */
export function restoreBackup(
  fileName: string,
): Promise<WorkspaceRestoreOutcome> {
  return invoke<WorkspaceRestoreOutcome>("restore_backup", { fileName });
}
