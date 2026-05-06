import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLabelStore } from "@/features/labels/labelStore";
import { resolveLabelColor } from "@/lib/labelPalette";

export interface PanelMenuProps {
  viewMode: string;
  setViewMode: (m: "tree" | "outline") => void;
  sortMode: string;
  setSortMode: (m: "manual" | "title" | "wordcount" | "status") => void;
  statusFilter: string | null;
  setStatusFilter: (
    s: "outline" | "draft" | "complete" | "revision" | "final" | null,
  ) => void;
  labelFilter: string[];
  toggleLabelFilter: (id: string) => void;
  clearLabelFilter: () => void;
  showWordCounts: boolean;
  setShowWordCounts: (v: boolean) => void;
  showStatusDots: boolean;
  setShowStatusDots: (v: boolean) => void;
  showLabelDots: boolean;
  setShowLabelDots: (v: boolean) => void;
  showAiAttribution: boolean;
  setShowAiAttribution: (v: boolean) => void;
  autoRevealActiveScene: boolean;
  setAutoRevealActiveScene: (v: boolean) => void;
  onClose: () => void;
  excludedRef?: React.RefObject<HTMLButtonElement | null>;
}

const SORT_LABEL_KEYS: Record<string, string> = {
  manual: "scenes.sortManual",
  title: "scenes.sortTitle",
  wordcount: "scenes.sortWordcount",
  status: "scenes.sortStatus",
};

const STATUS_FILTER_VALUES: Array<
  "outline" | "draft" | "complete" | "revision" | "final" | null
> = [null, "outline", "draft", "complete", "revision", "final"];

export function PanelMenu({
  viewMode,
  setViewMode,
  sortMode,
  setSortMode,
  statusFilter,
  setStatusFilter,
  labelFilter,
  toggleLabelFilter,
  clearLabelFilter,
  showWordCounts,
  setShowWordCounts,
  showStatusDots,
  setShowStatusDots,
  showLabelDots,
  setShowLabelDots,
  showAiAttribution,
  setShowAiAttribution,
  autoRevealActiveScene,
  setAutoRevealActiveScene,
  onClose,
  excludedRef,
}: PanelMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const allLabels = useLabelStore((s) => s.labels);
  useEffect(() => {
    function close(e: MouseEvent) {
      if (
        !ref.current?.contains(e.target as Node) &&
        !excludedRef?.current?.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose, excludedRef]);

  function radioItem<T extends string | null>(
    value: T,
    current: string | null,
    label: string,
    onSelect: (v: T) => void,
  ) {
    const selected = current === value;
    return (
      <button
        key={String(value)}
        type="button"
        onClick={() => {
          onSelect(value);
        }}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent",
          selected && "bg-accent font-medium",
        )}
      >
        {selected ? <Check className="h-3 w-3" /> : <span className="w-3" />}
        {label}
      </button>
    );
  }

  function checkItem(
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void,
  ) {
    return (
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent",
          checked && "font-medium",
        )}
      >
        {checked ? <Check className="h-3 w-3" /> : <span className="w-3" />}
        {label}
      </button>
    );
  }

  return (
    <div
      ref={ref}
      className="min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md"
    >
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("scenes.viewLabel")}
      </div>
      {radioItem("tree", viewMode, "Tree", setViewMode as (v: string) => void)}
      {radioItem(
        "outline",
        viewMode,
        "Outline",
        setViewMode as (v: string) => void,
      )}
      <div className="my-1 border-t border-border" />
      <SubMenuGroup label={t("scenes.sortByLabel")}>
        {(["manual", "title", "wordcount", "status"] as const).map((m) =>
          radioItem(m, sortMode, t(SORT_LABEL_KEYS[m]), setSortMode),
        )}
      </SubMenuGroup>
      <SubMenuGroup label={t("scenes.filterByStatusLabel")}>
        {STATUS_FILTER_VALUES.map((value) =>
          radioItem(
            value,
            statusFilter,
            value === null
              ? t("scenes.filterAll")
              : value.charAt(0).toUpperCase() + value.slice(1),
            setStatusFilter,
          ),
        )}
      </SubMenuGroup>
      <SubMenuGroup label={t("scenes.filterByLabelLabel")}>
        {allLabels.length === 0 ? (
          <div className="px-3 py-1.5 text-xs text-muted-foreground">
            {t("scenes.noLabels")}
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={clearLabelFilter}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent",
                labelFilter.length === 0 && "bg-accent font-medium",
              )}
            >
              {labelFilter.length === 0 ? (
                <Check className="h-3 w-3" />
              ) : (
                <span className="w-3" />
              )}
              {t("scenes.filterAllLabels")}
            </button>
            {allLabels.map((label) => {
              const checked = labelFilter.includes(label.id);
              const color = resolveLabelColor(label.color);
              return (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => toggleLabelFilter(label.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent",
                    checked && "font-medium",
                  )}
                >
                  {checked ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <span className="w-3" />
                  )}
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="truncate">{label.name}</span>
                </button>
              );
            })}
          </>
        )}
      </SubMenuGroup>
      <SubMenuGroup label={t("scenes.showLabel")}>
        {checkItem(
          t("scenes.showWordCount"),
          showWordCounts,
          setShowWordCounts,
        )}
        {checkItem(
          t("scenes.showStatusDots"),
          showStatusDots,
          setShowStatusDots,
        )}
        {checkItem(t("scenes.showLabelDots"), showLabelDots, setShowLabelDots)}
        {checkItem(
          t("scenes.showAiBadge"),
          showAiAttribution,
          setShowAiAttribution,
        )}
        {checkItem(
          t("scenes.autoRevealActive"),
          autoRevealActiveScene,
          setAutoRevealActiveScene,
        )}
      </SubMenuGroup>
    </div>
  );
}

function SubMenuGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent",
          open && "bg-accent",
        )}
      >
        <span className="w-3" />
        {label}
        <ChevronRight className="ml-auto h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-full top-0 mr-1 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md">
          {children}
        </div>
      )}
    </div>
  );
}
