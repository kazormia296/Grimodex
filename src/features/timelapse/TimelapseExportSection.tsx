import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Film } from "lucide-react";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { pickSupportedWebmMime } from "./videoExport";
import {
  produceSceneTimelapseWebm,
  produceProjectTimelapseWebm,
  saveWebmBlob,
} from "./exportTimelapse";

type Scope = "scene" | "project";

/**
 * 執筆タイムラプス動画の書き出し UI。ExportDialog の「タイムラプス動画」タブから
 * 使う (#8)。現在のシーン / プロジェクト全体 (#9) のどちらかを 1 本の WebM に
 * 書き出す。save-only (アプリ内プレビューは P5)。
 */
export function TimelapseExportSection({
  projectTitle,
}: {
  projectTitle?: string;
}) {
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
  const [scope, setScope] = useState<Scope>("scene");
  const [durationSec, setDurationSec] = useState(30);
  const [pace, setPace] = useState<"fast" | "standard" | "slow">("standard");
  const [busy, setBusy] = useState(false);

  // pace → maxIdleMs (長休止のクランプ強度)。standard は buildFrameSchedule 既定(2000ms)。
  const maxIdleMs = pace === "fast" ? 800 : pace === "slow" ? 15000 : undefined;

  const sceneReady = scope === "project" || !!activeSceneId;
  const canExport = !!supportedMime && sceneReady && !busy;

  async function handleExport() {
    if (!supportedMime || busy) return;
    if (scope === "scene" && !activeSceneId) return;
    setBusy(true);
    try {
      let blob: Blob;
      let base: string;
      if (scope === "project") {
        ({ blob } = await produceProjectTimelapseWebm({
          projectId,
          mimeType: supportedMime,
          targetDurationSec: durationSec,
          ...(maxIdleMs !== undefined ? { maxIdleMs } : {}),
        }));
        base = projectTitle || "project-timelapse";
      } else {
        ({ blob } = await produceSceneTimelapseWebm({
          projectId,
          sceneId: activeSceneId as string,
          mimeType: supportedMime,
          targetDurationSec: durationSec,
          ...(maxIdleMs !== undefined ? { maxIdleMs } : {}),
        }));
        base = sceneTitle || "timelapse";
      }
      const safe = base.replace(/[\\/:*?"<>|]/g, "_");
      const saved = await saveWebmBlob(blob, `${safe}.webm`);
      if (saved) toast.success(t("timelapse.exportDone"));
    } catch (err) {
      console.error("[timelapse] export failed", err);
      const noSteps =
        err instanceof Error && /no recorded editor steps/.test(err.message);
      toast.error(
        noSteps
          ? t(
              scope === "project"
                ? "timelapse.exportProjectNoSteps"
                : "timelapse.exportNoSteps",
            )
          : t("timelapse.exportFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="timelapse-export-section"
      className="flex h-full flex-col gap-4 p-6 text-sm"
    >
      <div className="flex items-center gap-2 text-foreground">
        <Film className="h-4 w-4" />
        <span className="font-medium">{t("timelapse.exportTitle")}</span>
      </div>

      {!supportedMime ? (
        <p className="text-xs text-destructive">
          {t("timelapse.videoUnsupported")}
        </p>
      ) : (
        <>
          {/* 範囲: 現在のシーン / プロジェクト全体 */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("timelapse.scope")}
            </span>
            <div
              role="radiogroup"
              className="inline-flex w-fit rounded-md border border-border p-0.5"
            >
              {(["scene", "project"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={scope === s}
                  onClick={() => setScope(s)}
                  className={`rounded px-3 py-1 text-xs transition-colors ${
                    scope === s
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {t(
                    s === "scene"
                      ? "timelapse.scopeScene"
                      : "timelapse.scopeProject",
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* 文脈/ヒント */}
          {scope === "scene" ? (
            activeSceneId ? (
              <p className="text-xs text-foreground">
                {t("timelapse.exportScene", {
                  title: sceneTitle || activeSceneId,
                })}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("timelapse.noScene")}
              </p>
            )
          ) : null}
          <p className="text-xs text-muted-foreground">
            {scope === "project"
              ? t("timelapse.exportProjectHint")
              : t("timelapse.exportHint")}
          </p>

          {/* 尺 / テンポ (P3) */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("timelapse.duration")}
              <select
                aria-label={t("timelapse.duration")}
                value={durationSec}
                onChange={(e) => setDurationSec(Number(e.target.value))}
                className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
              >
                {[15, 30, 60].map((d) => (
                  <option key={d} value={d}>{`${d}s`}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("timelapse.pace")}
              <select
                aria-label={t("timelapse.pace")}
                value={pace}
                onChange={(e) =>
                  setPace(e.target.value as "fast" | "standard" | "slow")
                }
                className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
              >
                <option value="fast">{t("timelapse.paceFast")}</option>
                <option value="standard">{t("timelapse.paceStandard")}</option>
                <option value="slow">{t("timelapse.paceSlow")}</option>
              </select>
            </label>
          </div>
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
