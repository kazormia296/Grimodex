import { useTranslation } from "react-i18next";
import { useTimelineStore } from "./timelineStore";
import type { AxisMode, SpacingMode } from "./timelineStore";

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

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
      <span className="font-semibold text-foreground">
        {t("layout.panel.timeline", "Timeline")}
      </span>

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
        <span className="text-muted-foreground">
          {t("timeline.coverage", "📍{{scheduled}}/{{total}}", {
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
          ⏱
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
