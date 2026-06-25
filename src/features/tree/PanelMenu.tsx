import { useTranslation } from "react-i18next";
import { useTreeStore } from "./treeStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { resolveLabelColor } from "@/lib/labelPalette";
import {
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";

const SORT_LABEL_KEYS: Record<string, string> = {
  manual: "scenes.sortManual",
  title: "scenes.sortTitle",
  wordcount: "scenes.sortWordcount",
  status: "scenes.sortStatus",
};

const STATUS_FILTER_VALUES = [
  "all",
  "outline",
  "draft",
  "complete",
  "revision",
  "final",
] as const;
type StatusFilterValue = (typeof STATUS_FILTER_VALUES)[number];

type SortMode = "manual" | "title" | "wordcount" | "status";
type ViewMode = "tree" | "outline";
type SceneStatus = "outline" | "draft" | "complete" | "revision" | "final";

/**
 * Panel menu content — must be placed inside a <DropdownMenu>.
 * Reads/writes Scenes panel display state via stores directly.
 */
export function PanelMenu() {
  const { t } = useTranslation();
  const viewMode = useTreeStore((s) => s.viewMode);
  const setViewMode = useTreeStore((s) => s.setViewMode);
  const sortMode = useTreeStore((s) => s.sortMode);
  const setSortMode = useTreeStore((s) => s.setSortMode);
  const statusFilter = useTreeStore((s) => s.statusFilter);
  const setStatusFilter = useTreeStore((s) => s.setStatusFilter);
  const labelFilter = useTreeStore((s) => s.labelFilter);
  const toggleLabelFilter = useTreeStore((s) => s.toggleLabelFilter);
  const clearLabelFilter = useTreeStore((s) => s.clearLabelFilter);
  const threadFilter = useTreeStore((s) => s.threadFilter);
  const toggleThreadFilter = useTreeStore((s) => s.toggleThreadFilter);
  const clearThreadFilter = useTreeStore((s) => s.clearThreadFilter);
  const showWordCounts = useTreeStore((s) => s.showWordCounts);
  const setShowWordCounts = useTreeStore((s) => s.setShowWordCounts);
  const showStatusDots = useTreeStore((s) => s.showStatusDots);
  const setShowStatusDots = useTreeStore((s) => s.setShowStatusDots);
  const showLabelDots = useTreeStore((s) => s.showLabelDots);
  const setShowLabelDots = useTreeStore((s) => s.setShowLabelDots);
  const showPlotThreadTrack = useTreeStore((s) => s.showPlotThreadTrack);
  const setShowPlotThreadTrack = useTreeStore((s) => s.setShowPlotThreadTrack);
  const showAiAttribution = useTreeStore((s) => s.showAiAttribution);
  const setShowAiAttribution = useTreeStore((s) => s.setShowAiAttribution);
  const autoRevealActiveScene = useTreeStore((s) => s.autoRevealActiveScene);
  const setAutoRevealActiveScene = useTreeStore(
    (s) => s.setAutoRevealActiveScene,
  );
  const allLabels = useLabelStore((s) => s.labels);
  const allThreads = usePlotThreadStore((s) => s.threads);

  return (
    <DropdownMenuContent align="end" className="min-w-[180px]">
      <DropdownMenuLabel>{t("scenes.viewLabel")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={viewMode}
        onValueChange={(v) => setViewMode(v as ViewMode)}
      >
        <DropdownMenuRadioItem value="tree">Tree</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="outline">Outline</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>

      <DropdownMenuSeparator />

      <DropdownMenuSub>
        <DropdownMenuSubTrigger inset>
          {t("scenes.sortByLabel")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={sortMode}
            onValueChange={(v) => setSortMode(v as SortMode)}
          >
            {(["manual", "title", "wordcount", "status"] as const).map((m) => (
              <DropdownMenuRadioItem key={m} value={m}>
                {t(SORT_LABEL_KEYS[m])}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger inset>
          {t("scenes.filterByStatusLabel")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={statusFilter ?? "all"}
            onValueChange={(v) => {
              const value = v as StatusFilterValue;
              setStatusFilter(value === "all" ? null : (value as SceneStatus));
            }}
          >
            {STATUS_FILTER_VALUES.map((value) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {value === "all"
                  ? t("scenes.filterAll")
                  : value.charAt(0).toUpperCase() + value.slice(1)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger inset>
          {t("scenes.filterByLabelLabel")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[200px]">
          {allLabels.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-muted-foreground">
              {t("scenes.noLabels")}
            </div>
          ) : (
            <>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  clearLabelFilter();
                }}
                className={
                  labelFilter.length === 0 ? "bg-accent font-medium" : undefined
                }
              >
                {t("scenes.filterAllLabels")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {allLabels.map((label) => {
                const checked = labelFilter.includes(label.id);
                const color = resolveLabelColor(label.color);
                return (
                  <DropdownMenuCheckboxItem
                    key={label.id}
                    checked={checked}
                    onCheckedChange={() => toggleLabelFilter(label.id)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span
                      className="mr-2 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="truncate">{label.name}</span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger inset>
          {t("scenes.filterByThreadLabel")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[200px]">
          {allThreads.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-muted-foreground">
              {t("scenes.noThreads")}
            </div>
          ) : (
            <>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  clearThreadFilter();
                }}
                className={
                  threadFilter.length === 0
                    ? "bg-accent font-medium"
                    : undefined
                }
              >
                {t("scenes.filterAllThreads")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {allThreads.map((thread) => {
                const checked = threadFilter.includes(thread.id);
                const color = thread.color ?? "var(--primary)";
                return (
                  <DropdownMenuCheckboxItem
                    key={thread.id}
                    checked={checked}
                    onCheckedChange={() => toggleThreadFilter(thread.id)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span
                      className="mr-2 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="truncate">{thread.name}</span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger inset>
          {t("scenes.showLabel")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuCheckboxItem
            checked={showWordCounts}
            onCheckedChange={(v) => setShowWordCounts(v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {t("scenes.showWordCount")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showStatusDots}
            onCheckedChange={(v) => setShowStatusDots(v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {t("scenes.showStatusDots")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showLabelDots}
            onCheckedChange={(v) => setShowLabelDots(v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {t("scenes.showLabelDots")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showPlotThreadTrack}
            onCheckedChange={(v) => setShowPlotThreadTrack(v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {t("scenes.showPlotThreadTrack")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showAiAttribution}
            onCheckedChange={(v) => setShowAiAttribution(v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {t("scenes.showAiBadge")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={autoRevealActiveScene}
            onCheckedChange={(v) => setAutoRevealActiveScene(v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {t("scenes.autoRevealActive")}
          </DropdownMenuCheckboxItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuContent>
  );
}
