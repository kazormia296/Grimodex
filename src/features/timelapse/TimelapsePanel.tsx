import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Film } from "lucide-react";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { pickSupportedWebmMime } from "./videoExport";
import { produceSceneTimelapseWebm, saveWebmBlob } from "./exportTimelapse";

/**
 * 執筆タイムラプス エクスポートパネル (P7.4/P7.5)。
 *
 * v1 は save-only (アプリ内プレビュー無し) のため大きな動画面が不要 →
 * AnimatedOverlay は使わず、パネルが直接エクスポート UI を持つ。現在開いている
 * シーンを 30s WebM 動画として書き出す。WebM 非対応の webview ではボタンを無効化。
 */
export function TimelapsePanel() {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const activeSceneId = useTabStore((s) => {
    const tab = s.tabs.find((x) => x.nodeId === s.activeTabId);
    return tab && tab.contentType === "scene" ? tab.nodeId : null;
  });
  const sceneTitle = useTreeStore((s) =>
    activeSceneId
      ? (s.nodes.find((n) => n.id === activeSceneId)?.title ?? null)
      : null,
  );
  const supportedMime = useMemo(() => pickSupportedWebmMime(), []);
  const [busy, setBusy] = useState(false);

  const canExport = !!activeSceneId && !!supportedMime && !busy;

  async function handleExport() {
    if (!activeSceneId || !supportedMime || busy) return;
    setBusy(true);
    try {
      const { blob } = await produceSceneTimelapseWebm({
        projectId,
        sceneId: activeSceneId,
        mimeType: supportedMime,
      });
      const base = (sceneTitle || "timelapse").replace(/[\\/:*?"<>|]/g, "_");
      const saved = await saveWebmBlob(blob, `${base}.webm`);
      if (saved) toast.success(t("timelapse.exportDone"));
    } catch (err) {
      console.error("[timelapse] export failed", err);
      const noSteps =
        err instanceof Error && /no recorded editor steps/.test(err.message);
      toast.error(
        noSteps ? t("timelapse.exportNoSteps") : t("timelapse.exportFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="timelapse-panel"
      className="flex h-full flex-col gap-3 p-4 text-sm"
    >
      <div className="flex items-center gap-2 text-foreground">
        <Film className="h-4 w-4" />
        <span className="font-medium">{t("timelapse.exportTitle")}</span>
      </div>

      {!supportedMime ? (
        <p className="text-xs text-destructive">
          {t("timelapse.videoUnsupported")}
        </p>
      ) : !activeSceneId ? (
        <p className="text-xs text-muted-foreground">
          {t("timelapse.noScene")}
        </p>
      ) : (
        <>
          <p className="text-xs text-foreground">
            {t("timelapse.exportScene", { title: sceneTitle || activeSceneId })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("timelapse.exportHint")}
          </p>
        </>
      )}

      <button
        type="button"
        data-testid="timelapse-export-video"
        disabled={!canExport}
        onClick={() => void handleExport()}
        className="self-start rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {busy ? t("timelapse.exporting") : t("timelapse.exportButton")}
      </button>
    </div>
  );
}
