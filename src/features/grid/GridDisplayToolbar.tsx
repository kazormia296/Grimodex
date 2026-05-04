import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useCodexStore } from "@/features/codex/codexStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { resolveLabelColor } from "@/lib/labelPalette";
import { cn } from "@/lib/utils";
import { useGridStore, type CardTabMode } from "./gridStore";

export function GridDisplayToolbar() {
  const { t } = useTranslation();
  const display = useGridStore((s) => s.display);
  const setDisplay = useGridStore((s) => s.setDisplay);
  const filter = useGridStore((s) => s.filter);
  const setFilter = useGridStore((s) => s.setFilter);
  const clearFilter = useGridStore((s) => s.clearFilter);
  const codexEntries = useCodexStore((s) => s.entries);
  const loadEntries = useCodexStore((s) => s.loadEntries);
  const labels = useLabelStore((s) => s.labels);
  const cardTabMode = useGridStore((s) => s.cardTabMode);
  const setCardTabMode = useGridStore((s) => s.setCardTabMode);

  const tabModes: Array<{ id: CardTabMode; label: string }> = [
    { id: "auto", label: t("grid.cardTab.auto", "Auto") },
    { id: "beat", label: t("grid.cardTab.beat", "Beat") },
    { id: "synopsis", label: t("grid.cardTab.synopsis", "Synopsis") },
  ];

  useEffect(() => {
    if (codexEntries.length === 0) loadEntries();
  }, [codexEntries.length, loadEntries]);

  // Remove dangling label IDs when labels change (e.g. project switch or label deletion)
  useEffect(() => {
    const validIds = new Set(labels.map((l) => l.id));
    const filtered = filter.labelFilter.filter((id) => validIds.has(id));
    if (filtered.length !== filter.labelFilter.length) {
      setFilter({ labelFilter: filtered });
    }
  }, [labels, filter.labelFilter, setFilter]);

  const hasActiveFilter =
    filter.emptyOnly ||
    filter.hideCompleted ||
    filter.codexFilter !== null ||
    filter.labelFilter.length > 0;

  function toggleLabelFilter(id: string) {
    const next = filter.labelFilter.includes(id)
      ? filter.labelFilter.filter((x) => x !== id)
      : [...filter.labelFilter, id];
    setFilter({ labelFilter: next });
  }

  const displayToggles: Array<{
    key: keyof typeof display;
    label: string;
  }> = [
    { key: "showSynopsis", label: t("grid.display.synopsis", "Synopsis") },
    { key: "showBeats", label: t("grid.display.beats", "Beat") },
    { key: "showCodex", label: t("grid.display.codex", "Codex") },
    { key: "showStatusLabel", label: t("grid.display.statusLabel", "Status") },
    { key: "showLabelBar", label: t("grid.display.labelBar", "Label") },
    { key: "showForeshadow", label: t("grid.display.foreshadow", "伏線") },
    { key: "compactCards", label: t("grid.display.compact", "Compact") },
  ];

  return (
    <div className="border-b bg-popover px-4 py-2 flex flex-col gap-2">
      {/* Display row */}
      <div className="flex items-center gap-3 flex-wrap">
        <RowLabel>{t("grid.display.title", "表示")}</RowLabel>
        {displayToggles.map(({ key, label }) => (
          <Checkbox
            key={key}
            checked={display[key]}
            onChange={(v) => setDisplay({ [key]: v })}
            label={label}
          />
        ))}

        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono text-[9.5px] uppercase tracking-wider">
            {t("grid.cardTab.label", "カードタブ")}
          </span>
          <div
            className="inline-flex overflow-hidden rounded border border-border"
            role="radiogroup"
            aria-label={t("grid.cardTab.label", "カードタブ")}
          >
            {tabModes.map((mode, i) => {
              const active = cardTabMode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setCardTabMode(mode.id)}
                  className={cn(
                    "px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                    i > 0 && "border-l border-border",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                  )}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
        </span>
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-2 flex-wrap">
        <RowLabel>{t("grid.filter.title", "フィルタ")}</RowLabel>

        {labels.length > 0 &&
          labels.map((label) => {
            const active = filter.labelFilter.includes(label.id);
            const color = resolveLabelColor(label.color);
            return (
              <button
                key={label.id}
                type="button"
                onClick={() => toggleLabelFilter(label.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] transition-colors",
                  active
                    ? "border-current"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                style={
                  active
                    ? {
                        color,
                        backgroundColor: `${color}1f`,
                        borderColor: color,
                      }
                    : undefined
                }
                title={label.name}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                {label.name}
              </button>
            );
          })}

        {codexEntries.length > 0 && (
          <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{t("grid.filter.codex", "Codex:")}</span>
            <select
              value={filter.codexFilter ?? ""}
              onChange={(e) =>
                setFilter({ codexFilter: e.target.value || null })
              }
              className="rounded border border-input bg-background px-1.5 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">{t("grid.filter.codexAll", "すべて")}</option>
              {codexEntries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="ml-auto flex items-center gap-3">
          <Checkbox
            checked={filter.emptyOnly}
            onChange={(v) => setFilter({ emptyOnly: v })}
            label={t("grid.filter.emptyOnly", "空のみ")}
          />
          <Checkbox
            checked={filter.hideCompleted}
            onChange={(v) => setFilter({ hideCompleted: v })}
            label={t("grid.filter.hideCompleted", "完成を非表示")}
          />
          {hasActiveFilter && (
            <button
              type="button"
              className="text-[10px] text-primary hover:underline"
              onClick={clearFilter}
            >
              {t("grid.filter.clear", "クリア")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RowLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground min-w-[3.5rem]">
      {children}
    </span>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-1.5 cursor-pointer text-[11.5px] select-none",
        checked ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3"
      />
      {label}
    </label>
  );
}
