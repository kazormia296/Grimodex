import { Clock, MapPin, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTimelineStore } from "./timelineStore";
import type { AxisMode, SpacingMode } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { getCurrentProjectId } from "@/features/project/projectStore";

const SPACING_LABELS: Record<SpacingMode, string> = {
  proportional: "Proportional",
  uniform: "Uniform",
};

const AXIS_LABELS: Record<AxisMode, string> = {
  reading: "Reading-order",
  story: "Story-time",
  write: "Write-order",
};

interface Props {
  sceneCount: number;
  scheduledCount: number | null;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}

export function TimelineHeader({
  sceneCount,
  scheduledCount,
  inspectorOpen,
  onToggleInspector,
}: Props) {
  const { t } = useTranslation();
  const axisMode = useTimelineStore((s) => s.axisMode);
  const setAxisMode = useTimelineStore((s) => s.setAxisMode);
  const spacingMode = useTimelineStore((s) => s.spacingMode);
  const setSpacingMode = useTimelineStore((s) => s.setSpacingMode);
  const display = useTimelineStore((s) => s.display);
  const toggleDisplay = useTimelineStore((s) => s.toggleDisplay);
  const viewMode = useTimelineStore((s) => s.viewMode);
  const setViewMode = useTimelineStore((s) => s.setViewMode);

  return (
    <div
      data-panel-header
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs"
    >
      <span className="font-semibold text-foreground">
        {t("layout.panel.timeline", "Timeline")}
      </span>

      {/* View mode toggle: シーン年表 / プロットスレッド */}
      <div
        className="flex items-center overflow-hidden rounded border border-border"
        role="group"
        aria-label={t("timeline.viewMode", "表示モード")}
      >
        <button
          onClick={() => setViewMode("scenes")}
          className={`px-1.5 py-0.5 text-xs ${viewMode === "scenes" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
        >
          {t("plotThread.viewScenes", "シーン")}
        </button>
        <button
          onClick={() => setViewMode("threads")}
          className={`px-1.5 py-0.5 text-xs ${viewMode === "threads" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
        >
          {t("plotThread.viewThreads", "スレッド")}
        </button>
      </div>

      {/* Axis mode selector */}
      <select
        value={axisMode}
        onChange={(e) => setAxisMode(e.target.value as AxisMode)}
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none"
        aria-label={t("timeline.axisMode", "時間軸モード")}
      >
        {(Object.entries(AXIS_LABELS) as [AxisMode, string][]).map(
          ([mode, label]) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ),
        )}
      </select>

      {/* Spacing mode selector */}
      <select
        data-testid="spacing-mode-select"
        value={spacingMode}
        disabled={axisMode === "reading"}
        onChange={(e) => setSpacingMode(e.target.value as SpacingMode)}
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={t("timeline.spacingMode", "スペーシング")}
      >
        {(Object.entries(SPACING_LABELS) as [SpacingMode, string][]).map(
          ([mode, label]) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ),
        )}
      </select>

      {/* Coverage indicator: scheduled/total for story-time mode */}
      {scheduledCount !== null ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <MapPin className="h-3 w-3 shrink-0" aria-hidden />
          {t("timeline.coverage", "{{scheduled}}/{{total}}", {
            scheduled: scheduledCount,
            total: sceneCount,
          })}
        </span>
      ) : (
        <span className="text-muted-foreground">
          {t("timeline.sceneCount", "{{count}} scenes", { count: sceneCount })}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        {/* Add plot thread (threads モードのみ) */}
        {viewMode === "threads" && (
          <button
            onClick={() =>
              void usePlotThreadStore
                .getState()
                .addThread(
                  getCurrentProjectId(),
                  t("plotThread.newThreadName", "新しいスレッド"),
                )
            }
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/50"
            title={t("plotThread.addThread", "スレッドを追加")}
          >
            <Plus className="h-3 w-3" aria-hidden />
            {t("plotThread.addThread", "スレッドを追加")}
          </button>
        )}
        {/* Display toggles */}
        <button
          onClick={() => toggleDisplay("showTitles")}
          className={`rounded px-1.5 py-0.5 text-xs ${display.showTitles ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
          title={t("timeline.toggleTitles", "タイトル表示")}
        >
          T
        </button>
        <button
          onClick={() => toggleDisplay("showPhasePins")}
          className={`rounded px-1.5 py-0.5 text-xs ${display.showPhasePins ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
          title={t("timeline.togglePhasePins", "フェーズピン表示")}
        >
          <Clock className="h-3 w-3" aria-hidden />
        </button>
        <button
          onClick={onToggleInspector}
          className={`rounded px-1.5 py-0.5 text-xs ${inspectorOpen ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
          title={t("timeline.toggleInspector", "インスペクター")}
        >
          ⋮
        </button>
      </div>
    </div>
  );
}
