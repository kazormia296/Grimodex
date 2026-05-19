import { createPortal } from "react-dom";
import { useReindexProgressStore } from "./reindexProgressStore";

/**
 * `semantic_reindex_all` の進行状況を画面右下にトースト風で表示する。
 * Active 中は固定位置で居座り、完了 (done=true) を受けたら数秒後に
 * 自動で消える (store 側で AUTO_CLEAR_MS タイマー管理)。
 */
export function ReindexProgressToast() {
  const active = useReindexProgressStore((s) => s.active);
  const current = useReindexProgressStore((s) => s.current);
  const finished = useReindexProgressStore((s) => s.finished);
  if (!active || !current) return null;

  const { sceneIndex, totalScenes, chunksIndexed } = current;
  const pct =
    totalScenes > 0
      ? Math.min(100, Math.round((sceneIndex / totalScenes) * 100))
      : finished
        ? 100
        : 0;

  const title = finished
    ? "再インデックス完了"
    : "セマンティック再インデックス中";
  const detail =
    totalScenes === 0
      ? "対象シーンなし"
      : `${sceneIndex} / ${totalScenes} シーン · ${chunksIndexed} チャンク`;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 9998,
        width: 280,
        background: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.20)",
        padding: "10px 12px",
        fontSize: 12,
        color: "var(--foreground)",
        pointerEvents: "none",
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
        <span
          style={{ fontSize: 10, color: "var(--muted-foreground)" }}
          aria-hidden
        >
          {pct}%
        </span>
      </div>
      <ProgressBar pct={pct} finished={finished} />
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          color: "var(--muted-foreground)",
        }}
      >
        {detail}
      </div>
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
