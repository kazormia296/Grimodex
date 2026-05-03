import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useCodexStore } from "@/features/codex/codexStore";
import { useGridStore } from "./gridStore";

export function GridDisplayToolbar() {
  const { t } = useTranslation();
  const display = useGridStore((s) => s.display);
  const setDisplay = useGridStore((s) => s.setDisplay);
  const filter = useGridStore((s) => s.filter);
  const setFilter = useGridStore((s) => s.setFilter);
  const clearFilter = useGridStore((s) => s.clearFilter);
  const codexEntries = useCodexStore((s) => s.entries);
  const loadEntries = useCodexStore((s) => s.loadEntries);

  useEffect(() => {
    if (codexEntries.length === 0) loadEntries();
  }, [codexEntries.length, loadEntries]);

  const hasActiveFilter =
    filter.emptyOnly || filter.hideCompleted || filter.codexFilter !== null;

  const displayToggles: Array<{
    key: keyof typeof display;
    label: string;
  }> = [
    {
      key: "showSynopsis",
      label: t("grid.display.synopsis", "シノプシス表示"),
    },
    { key: "showBeats", label: t("grid.display.beats", "Beat プレビュー表示") },
    { key: "showCodex", label: t("grid.display.codex", "Codex チップ表示") },
    {
      key: "showStatusLabel",
      label: t("grid.display.statusLabel", "ステータスラベル表示"),
    },
    {
      key: "showLabelBar",
      label: t("grid.display.labelBar", "Label カラーバー表示"),
    },
    {
      key: "showForeshadow",
      label: t("grid.display.foreshadow", "Foreshadow indicator 表示"),
    },
    {
      key: "compactCards",
      label: t("grid.display.compact", "コンパクト表示"),
    },
  ];

  return (
    <div className="border-b bg-popover px-4 py-3 space-y-3">
      {/* Display */}
      <div>
        <div className="mb-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {t("grid.display.title", "表示設定")}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {displayToggles.map(({ key, label }) => (
            <label
              key={key}
              className="flex items-center gap-1.5 text-[12px] cursor-pointer"
            >
              <input
                type="checkbox"
                checked={display[key]}
                onChange={(e) => setDisplay({ [key]: e.target.checked })}
                className="h-3 w-3"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Filter */}
      <div>
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {t("grid.filter.title", "フィルタ")}
          {hasActiveFilter && (
            <button
              className="text-[10px] normal-case text-primary hover:underline"
              onClick={clearFilter}
            >
              {t("grid.filter.clear", "クリア")}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
            <input
              type="checkbox"
              checked={filter.emptyOnly}
              onChange={(e) => setFilter({ emptyOnly: e.target.checked })}
              className="h-3 w-3"
            />
            {t("grid.filter.emptyOnly", "空のシーンのみ")}
          </label>
          <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
            <input
              type="checkbox"
              checked={filter.hideCompleted}
              onChange={(e) => setFilter({ hideCompleted: e.target.checked })}
              className="h-3 w-3"
            />
            {t("grid.filter.hideCompleted", "完成済みを非表示")}
          </label>
        </div>
        {codexEntries.length > 0 && (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {t("grid.filter.codex", "Codex:")}
            </span>
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
          </div>
        )}
      </div>
    </div>
  );
}
