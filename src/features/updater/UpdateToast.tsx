import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useUpdaterStore } from "./updaterStore";
import { startUpdateDownload, restartApp } from "./api";

/**
 * アプリ更新の進行状況を画面右下にトースト風で表示する。`ModelDownloadToast`
 * の 1 段上 (bottom を上げる) に置き、モデル DL トーストと重ならないようにする。
 * available では「今すぐ更新 / 後で」、downloading では MiB 進捗バー、ready では
 * 「再起動」。upToDate / error は数秒後に自動で消える (updaterStore 側)。
 */
const MIB = 1024 * 1024;

export function UpdateToast() {
  const { t } = useTranslation();
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const notes = useUpdaterStore((s) => s.notes);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const total = useUpdaterStore((s) => s.total);
  const error = useUpdaterStore((s) => s.error);
  const reset = useUpdaterStore((s) => s.reset);

  // idle / checking は無表示 (自動チェックは静かに走る)。
  if (phase === "idle" || phase === "checking") return null;

  const isError = phase === "error";
  const pct =
    total > 0
      ? Math.min(100, Math.round((downloaded / total) * 100))
      : phase === "ready"
        ? 100
        : 0;

  const title = isError
    ? t("updater.checkFailed", { defaultValue: "更新の確認に失敗しました" })
    : phase === "upToDate"
      ? t("updater.upToDate", { defaultValue: "最新版です" })
      : phase === "downloading"
        ? t("updater.downloading", { defaultValue: "更新をダウンロード中…" })
        : phase === "ready"
          ? t("updater.readyToRestart", {
              defaultValue: "更新の準備ができました",
            })
          : t("updater.updateAvailable", {
              defaultValue: "新しいバージョンがあります",
            });

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        bottom: 152,
        zIndex: 9998,
        width: 300,
        background: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.20)",
        padding: "10px 12px",
        fontSize: 12,
        color: "var(--foreground)",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 600 }}>{title}</span>
        {phase === "downloading" && (
          <span
            style={{ fontSize: 10, color: "var(--muted-foreground)" }}
            aria-hidden
          >
            {pct}%
          </span>
        )}
      </div>

      {phase === "downloading" && <ProgressBar pct={pct} finished={false} />}

      {phase === "available" && version != null && (
        <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
          v{version}
        </div>
      )}
      {phase === "available" && notes != null && notes.trim() !== "" && (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: "var(--muted-foreground)",
            maxHeight: 60,
            overflow: "hidden",
            whiteSpace: "pre-wrap",
          }}
        >
          {notes}
        </div>
      )}
      {phase === "downloading" && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--muted-foreground)",
          }}
        >
          {`${(downloaded / MIB).toFixed(1)} / ${(total / MIB).toFixed(1)} MiB`}
        </div>
      )}
      {isError && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "rgba(220, 38, 38, 0.95)",
          }}
        >
          {error}
        </div>
      )}

      {phase === "available" && (
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 10,
          }}
        >
          <ToastButton onClick={() => reset()} variant="ghost">
            {t("updater.later", { defaultValue: "後で" })}
          </ToastButton>
          <ToastButton
            onClick={() => void startUpdateDownload()}
            variant="primary"
          >
            {t("updater.updateNow", { defaultValue: "今すぐ更新" })}
          </ToastButton>
        </div>
      )}
      {phase === "ready" && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: 10,
          }}
        >
          <ToastButton onClick={() => void restartApp()} variant="primary">
            {t("updater.restartNow", { defaultValue: "再起動" })}
          </ToastButton>
        </div>
      )}
    </div>,
    document.body,
  );
}

function ProgressBar({ pct, finished }: { pct: number; finished: boolean }) {
  return (
    <div
      style={{
        height: 4,
        borderRadius: 2,
        background: "var(--muted)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: finished
            ? "rgba(5, 150, 105, 0.85)"
            : "rgba(83, 74, 183, 0.85)",
          transition: "width 200ms ease-out",
        }}
      />
    </div>
  );
}

function ToastButton({
  children,
  onClick,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant: "primary" | "ghost";
}) {
  const primary = variant === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 10px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        border: primary ? "none" : "1px solid var(--border)",
        background: primary ? "rgba(83, 74, 183, 0.95)" : "transparent",
        color: primary ? "#fff" : "var(--muted-foreground)",
      }}
    >
      {children}
    </button>
  );
}
