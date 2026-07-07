import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { flushAllAutoSaves } from "@/hooks/useAutoSave";
import { awaitAllPendingSceneWrites } from "@/features/tree/pendingSceneWrites";
import { flushNow as flushTimelapseRecorder } from "@/features/timelapse/recorder";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import { listBackups, restoreBackup, type BackupInfo } from "../backupApi";

/** Rust の restore_backup が「復元は適用したがセッション再オープンに失敗」を伝える安定マーカー。 */
const RESTORE_SESSION_LOST = "RESTORE_SESSION_LOST";

/** 復元に対応する形式（無圧縮 .db / gzip .db.gz）。 */
function isSupportedFormat(format: string): boolean {
  return format === "db" || format === "db.gz";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * バックアップ一覧＋復元 UI（backup restore Phase 1）。設定 > データ >
 * バックアップ セクションに埋め込む。復元は破壊的（ワークスペース全体を置換）
 * なので 2 クリック確認とし、成功後は ProjectSnapshotModal と同様に
 * `window.location.reload()` で全状態を作り直す。
 */
export function BackupRestoreSection() {
  const { t } = useTranslation();
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  // 2 クリック確認中のファイル名、および復元実行中のファイル名。
  const [confirmFile, setConfirmFile] = useState<string | null>(null);
  const [restoringFile, setRestoringFile] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setBackups(null);
      return;
    }
    setLoading(true);
    try {
      setBackups(await listBackups());
    } catch (err) {
      debugLog.error("backup-restore", "list failed", errorDetail(err));
      toast.error(t("settings.data.restoreListFail"));
      setBackups([]);
    } finally {
      setLoading(false);
    }
  }, [workspacePath, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRestore(b: BackupInfo) {
    if (restoringFile) return;
    // 復元対応: 無圧縮 .db / gzip .db.gz（Phase 2）。
    if (!isSupportedFormat(b.format)) {
      toast.error(t("settings.data.restoreUnsupported"));
      return;
    }
    // 1 クリック目: 確認モードへ（5 秒で自動解除）。
    if (confirmFile !== b.fileName) {
      setConfirmFile(b.fileName);
      setTimeout(
        () => setConfirmFile((c) => (c === b.fileName ? null : c)),
        5000,
      );
      return;
    }
    // 未確定の inline-AI diff があるうちは破壊しない（確定/破棄を促す）。
    // ProjectSnapshotModal の復元と同じ安全網。
    if (guardInlineAiPending()) {
      setConfirmFile(null);
      return;
    }
    setRestoringFile(b.fileName);
    // 復元前に保留中の保存を flush → 直前の状態が安全退避（Rust 側 backup_to）に
    // 確実に含まれるようにする（openWorkspace と同じ静止化）。flush 失敗は復元を
    // ブロックしない（安全退避が数秒古くなるだけ）。
    try {
      await flushAllAutoSaves();
      await awaitAllPendingSceneWrites();
      await flushTimelapseRecorder();
    } catch (e) {
      debugLog.warn(
        "backup-restore",
        "quiesce before restore failed",
        errorDetail(e),
      );
    }
    try {
      await restoreBackup(b.fileName);
      toast.success(t("settings.data.restoreSuccess"));
      // DB を丸ごと差し替えたので全フロント状態を捨てて作り直す。
      window.location.reload();
    } catch (err) {
      debugLog.error("backup-restore", "restore failed", errorDetail(err));
      toast.error(t("settings.data.restoreFail"));
      setRestoringFile(null);
      setConfirmFile(null);
      // Rust が「復元は適用したが再オープンに失敗（=セッション喪失）」を通知した場合は
      // reload して bootstrap open_workspace に開き直させる（inner=None のまま固まらせ
      // ない）。それ以外の失敗はセッション継続なので reload しない。
      if (String(err).includes(RESTORE_SESSION_LOST)) {
        window.location.reload();
      }
    }
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <span className="text-sm">{t("settings.data.restoreTitle")}</span>
          <p className="text-xs text-muted-foreground">
            {t("settings.data.restoreDesc")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || !workspacePath || !!restoringFile}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" />
          {t("settings.data.restoreRefresh")}
        </button>
      </div>

      {!workspacePath ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.data.restoreNoWorkspace")}
        </p>
      ) : loading && backups === null ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.data.scanning")}
        </p>
      ) : !backups || backups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.data.restoreNone")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {backups.map((b) => {
            const isConfirming = confirmFile === b.fileName;
            const isRestoring = restoringFile === b.fileName;
            const supported = isSupportedFormat(b.format);
            const disabled = !!restoringFile && !isRestoring;
            return (
              <li
                key={b.fileName}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-2 py-1.5"
              >
                <div className="min-w-0">
                  <span className="block truncate text-xs">
                    {new Date(b.modifiedMs).toLocaleString()}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatBytes(b.sizeBytes)}
                    {b.format !== "db" ? ` · ${b.format}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRestore(b)}
                  disabled={disabled || !supported}
                  title={
                    supported
                      ? undefined
                      : t("settings.data.restoreUnsupported")
                  }
                  className={`shrink-0 rounded-md border px-3 py-1 text-xs disabled:opacity-50 ${
                    isConfirming
                      ? "border-destructive bg-destructive/10 text-destructive"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {isRestoring
                    ? t("settings.data.restoreRunning")
                    : isConfirming
                      ? t("settings.data.restoreConfirm")
                      : t("settings.data.restoreAction")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
