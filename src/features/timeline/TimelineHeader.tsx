import { Clock, MapPin, Plus, TrainFront, Rows3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTimelineStore } from "./timelineStore";
import type { AxisMode, SpacingMode, PlotLayout } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { activeCodexPaletteSlots } from "@/lib/resolveCodexColors";

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
  const showThreads = useTimelineStore((s) => s.showThreads);
  const toggleShowThreads = useTimelineStore((s) => s.toggleShowThreads);
  const plotLayout = useTimelineStore((s) => s.plotLayout);
  const setPlotLayout = useTimelineStore((s) => s.setPlotLayout);
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);

  return (
    <div
      data-panel-header
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5 text-xs"
    >
      <span className="shrink-0 whitespace-nowrap font-semibold text-foreground">
        {t("layout.panel.timeline", "Timeline")}
      </span>

      {/* スレッドのオーバーレイ表示トグル（シーン年表の上にレーンを重ねる） */}
      <button
        onClick={toggleShowThreads}
        aria-pressed={showThreads}
        className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${showThreads ? "border-accent bg-accent text-accent-foreground" : "border-border text-muted-foreground hover:bg-accent/50"}`}
        title={t("timeline.toggleThreads", "プロットスレッドを表示")}
      >
        {t("plotThread.viewThreads", "スレッド")}
      </button>

      {/* レイアウト切替（subway = 路線図 / separated = 独立行）。スレッド表示時のみ。 */}
      {showThreads && (
        <div
          className="flex shrink-0 items-center overflow-hidden rounded border border-border"
          role="group"
          aria-label={t("plotThread.layout.label", "スレッド レイアウト")}
        >
          {(
            [
              ["subway", TrainFront, t("plotThread.layout.subway", "Subway")],
              [
                "separated",
                Rows3,
                t("plotThread.layout.separated", "Separated"),
              ],
            ] as [PlotLayout, typeof TrainFront, string][]
          ).map(([mode, Icon, label]) => (
            <button
              key={mode}
              onClick={() => setPlotLayout(mode)}
              aria-pressed={plotLayout === mode}
              title={label}
              className={`inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-xs ${
                plotLayout === mode
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              }`}
            >
              <Icon className="h-3 w-3" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Axis mode selector */}
      <select
        value={axisMode}
        onChange={(e) => setAxisMode(e.target.value as AxisMode)}
        className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none"
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
        className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
          <MapPin className="h-3 w-3 shrink-0" aria-hidden />
          {t("timeline.coverage", "{{scheduled}}/{{total}}", {
            scheduled: scheduledCount,
            total: sceneCount,
          })}
        </span>
      ) : (
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          {t("timeline.sceneCount", "{{count}} scenes", { count: sceneCount })}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* Add plot thread (スレッド表示時のみ) */}
        {showThreads && (
          <button
            onClick={() => {
              // Codex パレットから順番に色を自動割り当て（既存本数で round-robin）。
              const palette = activeCodexPaletteSlots(
                colorTheme,
                typeof document !== "undefined" &&
                  document.documentElement.classList.contains("dark"),
              );
              const count = usePlotThreadStore.getState().threads.length;
              const color = palette[count % palette.length]?.fg ?? null;
              void usePlotThreadStore
                .getState()
                .addThread(
                  getCurrentProjectId(),
                  t("plotThread.newThreadName", "新しいスレッド"),
                  color,
                );
            }}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/50"
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
