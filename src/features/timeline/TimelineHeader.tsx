import {
  MapPin,
  Plus,
  EllipsisVertical,
  PanelRight,
  CalendarClock,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTimelineStore } from "./timelineStore";
import type { AxisMode, SpacingMode } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { activeCodexPaletteSlots } from "@/lib/resolveCodexColors";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

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
  const plotSubwaySort = useTimelineStore((s) => s.plotSubwaySort);
  const togglePlotSubwaySort = useTimelineStore((s) => s.togglePlotSubwaySort);
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);

  return (
    <div
      data-panel-header
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5 text-xs"
    >
      <CalendarClock className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="shrink-0 whitespace-nowrap font-medium text-foreground">
        {t("layout.panel.timeline", "Timeline")}
      </span>

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
        {/* Add plot thread（スレッドは常時表示） */}
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

        {/* 表示オプション（ケバブ）: 自動整列・タイトル・フェーズピン */}
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="timeline-display-menu"
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 focus:outline-none data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
            title={t("timeline.displayMenu", "表示オプション")}
          >
            <EllipsisVertical className="h-3.5 w-3.5" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44 text-xs">
            <DropdownMenuLabel>
              {t("timeline.displayMenu", "表示オプション")}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={plotSubwaySort}
              onCheckedChange={() => togglePlotSubwaySort()}
            >
              {t("plotThread.autoArrange", "重要度順に整列")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={display.showTitles}
              onCheckedChange={() => toggleDisplay("showTitles")}
            >
              {t("timeline.toggleTitles", "タイトル表示")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={display.showPhasePins}
              onCheckedChange={() => toggleDisplay("showPhasePins")}
            >
              {t("timeline.togglePhasePins", "フェーズピン表示")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={display.showThreadGaps}
              onCheckedChange={() => toggleDisplay("showThreadGaps")}
            >
              {t("timeline.toggleThreadGaps", "スレッドの抜けシーンを表示")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={display.showStructureAnalysis}
              onCheckedChange={() => toggleDisplay("showStructureAnalysis")}
            >
              {t("timeline.toggleStructureAnalysis", "構造分析パネル")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* インスペクタ開閉（サイドペイン） */}
        <button
          onClick={onToggleInspector}
          aria-pressed={inspectorOpen}
          className={`rounded px-1.5 py-0.5 text-xs ${inspectorOpen ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
          title={t("timeline.toggleInspector", "インスペクター")}
        >
          <PanelRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
