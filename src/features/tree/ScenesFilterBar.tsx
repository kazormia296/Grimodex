import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { StatusDot } from "./StatusDot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resolveLabelColor } from "@/lib/labelPalette";
import type { Label } from "@/db/schema";
import type { PlotThreadRow } from "@/features/plot-threads/api";
import type { SceneStatus } from "./treeStore";

interface ScenesFilterBarProps {
  filterRef: RefObject<HTMLInputElement | null>;
  filterQuery: string;
  setFilterQuery: (q: string) => void;
  statusFilter: SceneStatus | null;
  setStatusFilter: (s: SceneStatus | null) => void;
  labelFilter: string[];
  toggleLabelFilter: (id: string) => void;
  clearLabelFilter: () => void;
  allLabels: Label[];
  threadFilter: string[];
  toggleThreadFilter: (id: string) => void;
  clearThreadFilter: () => void;
  allThreads: PlotThreadRow[];
}

export function ScenesFilterBar({
  filterRef,
  filterQuery,
  setFilterQuery,
  statusFilter,
  setStatusFilter,
  labelFilter,
  toggleLabelFilter,
  clearLabelFilter,
  allLabels,
  threadFilter,
  toggleThreadFilter,
  clearThreadFilter,
  allThreads,
}: ScenesFilterBarProps) {
  const { t } = useTranslation();
  const hasActiveFilters =
    !!statusFilter || labelFilter.length > 0 || threadFilter.length > 0;

  return (
    <>
      <div className="flex-shrink-0 border-b border-border px-2 py-1">
        <Input
          data-testid="scenes-filter-input"
          ref={filterRef}
          type="text"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilterQuery("");
          }}
          placeholder={t("scenes.filterPlaceholder")}
          className="h-6 px-2 py-0.5 text-xs"
        />
      </div>
      {hasActiveFilters && (
        <div className="flex-shrink-0 flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
          {statusFilter && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setStatusFilter(null)}
              title={t("scenes.removeFilter")}
              className="h-auto gap-1 rounded-full bg-accent/50 px-1.5 py-0.5 text-[10px] font-normal"
            >
              <StatusDot status={statusFilter} />
              <span>
                {statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)}
              </span>
              <X className="h-2.5 w-2.5" />
            </Button>
          )}
          {labelFilter.map((id) => {
            const label = allLabels.find((l) => l.id === id);
            if (!label) return null;
            const color = resolveLabelColor(label.color);
            return (
              <Button
                key={id}
                type="button"
                variant="outline"
                size="xs"
                onClick={() => toggleLabelFilter(id)}
                title={t("scenes.removeFilter")}
                className="h-auto gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-normal"
                style={{
                  borderColor: color,
                  backgroundColor: `${color}22`,
                  color,
                }}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="truncate max-w-[100px]">{label.name}</span>
                <X className="h-2.5 w-2.5" />
              </Button>
            );
          })}
          {threadFilter.map((id) => {
            const thread = allThreads.find((th) => th.id === id);
            if (!thread) return null;
            const color = thread.color ?? "var(--primary)";
            return (
              <Button
                key={id}
                type="button"
                variant="outline"
                size="xs"
                onClick={() => toggleThreadFilter(id)}
                title={t("scenes.removeFilter")}
                className="h-auto gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-normal"
                style={{
                  borderColor: color,
                  backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`,
                  color,
                }}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="max-w-[100px] truncate">{thread.name}</span>
                <X className="h-2.5 w-2.5" />
              </Button>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setStatusFilter(null);
              clearLabelFilter();
              clearThreadFilter();
            }}
            className="ml-auto h-auto px-1 py-0 text-[10px] text-primary hover:bg-transparent hover:underline"
          >
            {t("scenes.clearFilters")}
          </Button>
        </div>
      )}
    </>
  );
}
