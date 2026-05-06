import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { StatusDot } from "./StatusDot";
import { resolveLabelColor } from "@/lib/labelPalette";
import type { Label } from "@/db/schema";
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
}: ScenesFilterBarProps) {
  const { t } = useTranslation();
  const hasActiveFilters = !!statusFilter || labelFilter.length > 0;

  return (
    <>
      <div className="flex-shrink-0 border-b border-border px-2 py-1">
        <input
          ref={filterRef}
          type="text"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilterQuery("");
          }}
          placeholder={t("scenes.filterPlaceholder")}
          className="w-full rounded border border-border bg-background px-2 py-0.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      {hasActiveFilters && (
        <div className="flex-shrink-0 flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
          {statusFilter && (
            <button
              type="button"
              onClick={() => setStatusFilter(null)}
              title={t("scenes.removeFilter")}
              className="flex items-center gap-1 rounded-full border border-border bg-accent/50 px-1.5 py-0.5 text-[10px] text-foreground hover:bg-accent"
            >
              <StatusDot status={statusFilter} />
              <span>
                {statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)}
              </span>
              <X className="h-2.5 w-2.5" />
            </button>
          )}
          {labelFilter.map((id) => {
            const label = allLabels.find((l) => l.id === id);
            if (!label) return null;
            const color = resolveLabelColor(label.color);
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleLabelFilter(id)}
                title={t("scenes.removeFilter")}
                className="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]"
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
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setStatusFilter(null);
              clearLabelFilter();
            }}
            className="ml-auto text-[10px] text-primary hover:underline"
          >
            {t("scenes.clearFilters")}
          </button>
        </div>
      )}
    </>
  );
}
