import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { ensureSemanticIndexesOnOpen } from "./autoIndex";
import { useModelDownloadStore } from "./modelDownloadStore";

/**
 * オンデマンド埋め込みモデル DL の進行状況を画面右下にトースト風で表示する。
 * `ReindexProgressToast` の 1 段上 (bottom を上げる) に置き、DL→再インデックスが
 * 続けて走っても重ならないようにする。done を受けたら数秒後に自動で消える。
 */
const MIB = 1024 * 1024;

export function ModelDownloadToast() {
  const { t } = useTranslation();
  const active = useModelDownloadStore((s) => s.active);
  const current = useModelDownloadStore((s) => s.current);
  const clear = useModelDownloadStore((s) => s.clear);
  if (!active || !current) return null;

  const { downloaded, total, done, error } = current;
  const pct =
    total > 0
      ? Math.min(100, Math.round((downloaded / total) * 100))
      : done
        ? 100
        : 0;
  const isError = done && !!error;

  const title = isError
    ? t("semanticSearch.modelDownloadFailed", {
        defaultValue: "埋め込みモデルのダウンロードに失敗しました",
      })
    : done
      ? t("semanticSearch.modelDownloadComplete", {
          defaultValue: "埋め込みモデルの準備が整いました",
        })
      : t("semanticSearch.modelDownloading", {
          defaultValue: "埋め込みモデルをダウンロード中…",
        });
  const detail = isError
    ? t("semanticSearch.modelDownloadFallback", {
        defaultValue: "全文検索(FTS)で続行します",
      })
    : `${(downloaded / MIB).toFixed(1)} / ${(total / MIB).toFixed(1)} MiB`;

  const retry = () => {
    const workspaceKey = useWorkspaceStore.getState().activeWorkspacePath;
    const projectId = useProjectStore.getState().currentProjectId;
    if (!workspaceKey || !projectId) return;
    clear();
    void ensureSemanticIndexesOnOpen(projectId, workspaceKey);
  };

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        bottom: 84,
        zIndex: 9998,
        width: 280,
        background: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.20)",
        padding: "10px 12px",
        fontSize: 12,
        color: "var(--foreground)",
        pointerEvents: isError ? "auto" : "none",
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
        {!isError && (
          <span
            style={{ fontSize: 10, color: "var(--muted-foreground)" }}
            aria-hidden
          >
            {pct}%
          </span>
        )}
      </div>
      {!isError && <ProgressBar pct={pct} finished={done} />}
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          color: isError
            ? "rgba(220, 38, 38, 0.95)"
            : "var(--muted-foreground)",
        }}
      >
        {detail}
      </div>
      {isError && (
        <button
          type="button"
          onClick={retry}
          style={{
            marginTop: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--background)",
            color: "var(--foreground)",
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {t("semanticSearch.retryModelDownload", {
            defaultValue: "再試行",
          })}
        </button>
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
