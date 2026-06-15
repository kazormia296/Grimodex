import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Search, X, MoreVertical } from "lucide-react";
import i18next from "@/lib/i18n";
import { useMatrixStore } from "./matrixStore";
import type { ShowMode } from "./lib/deriveColumns";
import type { DisplayMode, SortMode } from "./matrixStore";

const getShowModes = (): {
  value: ShowMode;
  label: string;
  disabled?: boolean;
}[] => [
  { value: "codex-all", label: i18next.t("matrix.showMode.codexAll") },
  {
    value: "codex-characters",
    label: i18next.t("matrix.showMode.codexCharacters"),
  },
  {
    value: "codex-locations",
    label: i18next.t("matrix.showMode.codexLocations"),
  },
  { value: "codex-items", label: i18next.t("matrix.showMode.codexItems") },
  { value: "codex-lore", label: i18next.t("matrix.showMode.codexLore") },
  { value: "pov", label: i18next.t("matrix.showMode.pov") },
  { value: "location", label: i18next.t("matrix.showMode.location") },
  { value: "subplot", label: i18next.t("matrix.showMode.subplot") },
  { value: "custom", label: i18next.t("matrix.showMode.custom") },
];

const getSortModes = (): { value: SortMode; label: string }[] => [
  { value: "reading", label: i18next.t("matrix.sortMode.readingOrder") },
  { value: "story-time", label: i18next.t("matrix.sortMode.storyTimeOrder") },
  { value: "word-count", label: i18next.t("matrix.sortMode.characterCount") },
  { value: "last-edited", label: i18next.t("matrix.sortMode.lastEdited") },
];

const getDisplayModes = (): { value: DisplayMode; label: string }[] => [
  { value: "dot", label: i18next.t("matrix.displayMode.dot") },
  { value: "count", label: i18next.t("matrix.displayMode.count") },
  { value: "heatmap", label: i18next.t("matrix.displayMode.heatmap") },
  { value: "pov-color", label: i18next.t("matrix.displayMode.povColor") },
  { value: "role-aware", label: i18next.t("matrix.displayMode.roleAware") },
];

/** Show modes where the tag-filter row is hidden */
const NO_TAG_FILTER_MODES = new Set<ShowMode>(["pov", "location", "custom"]);

interface Props {
  availableTags: string[];
  onExportCsv: () => void;
}

export function MatrixHeader({ availableTags, onExportCsv }: Props) {
  const { t } = useTranslation();
  const showMode = useMatrixStore((s) => s.showMode);
  const sortMode = useMatrixStore((s) => s.sortMode);
  const displayMode = useMatrixStore((s) => s.displayMode);
  const tagFilter = useMatrixStore((s) => s.tagFilter);
  const subplotTagName = useMatrixStore((s) => s.subplotTagName);
  const setShowMode = useMatrixStore((s) => s.setShowMode);
  const setSortMode = useMatrixStore((s) => s.setSortMode);
  const setDisplayMode = useMatrixStore((s) => s.setDisplayMode);
  const setTagFilter = useMatrixStore((s) => s.setTagFilter);
  const searchQuery = useMatrixStore((s) => s.searchQuery);
  const setSearchQuery = useMatrixStore((s) => s.setSearchQuery);
  const hideEmptyRows = useMatrixStore((s) => s.hideEmptyRows);
  const onlyUneditedRows = useMatrixStore((s) => s.onlyUneditedRows);
  const setHideEmptyRows = useMatrixStore((s) => s.setHideEmptyRows);
  const setOnlyUneditedRows = useMatrixStore((s) => s.setOnlyUneditedRows);
  const customSets = useMatrixStore((s) => s.customSets);
  const activeCustomSetId = useMatrixStore((s) => s.activeCustomSetId);
  const createCustomSet = useMatrixStore((s) => s.createCustomSet);
  const renameCustomSet = useMatrixStore((s) => s.renameCustomSet);
  const deleteCustomSet = useMatrixStore((s) => s.deleteCustomSet);
  const setActiveCustomSetId = useMatrixStore((s) => s.setActiveCustomSetId);

  const [searchOpen, setSearchOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const showModes = getShowModes();
  const sortModes = getSortModes();
  const displayModes = getDisplayModes();

  const currentTags = tagFilter[showMode] ?? [];
  const showTagFilter = !NO_TAG_FILTER_MODES.has(showMode);

  const suggestions = availableTags.filter(
    (t) =>
      t.toLowerCase().includes(tagInput.toLowerCase()) &&
      !currentTags.includes(t),
  );

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  function addTag(tag: string) {
    setTagFilter(showMode, [...currentTags, tag]);
    setTagInput("");
    setShowTagSuggestions(false);
  }

  function removeTag(tag: string) {
    setTagFilter(
      showMode,
      currentTags.filter((t) => t !== tag),
    );
  }

  function toggleSearch() {
    if (searchOpen) setSearchQuery("");
    setSearchOpen((v) => !v);
  }

  return (
    <div className="shrink-0 border-b">
      {/* Main row */}
      <div data-panel-header className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-semibold">
          {t("layout.panel.matrix")}
        </span>
        <div className="flex-1" />

        {/* Show mode */}
        <select
          value={showMode}
          onChange={(e) => setShowMode(e.target.value as ShowMode)}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          {showModes.map((m) => (
            <option key={m.value} value={m.value} disabled={m.disabled}>
              {m.label}
            </option>
          ))}
        </select>

        {/* Sort mode */}
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          {sortModes.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        {/* Search toggle */}
        <button
          type="button"
          onClick={toggleSearch}
          className={`rounded p-1 hover:bg-accent ${searchOpen ? "bg-accent" : ""}`}
          title={t("matrix.searchTooltip")}
        >
          <Search className="h-3.5 w-3.5" />
        </button>

        {/* Panel menu */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className={`rounded p-1 hover:bg-accent ${menuOpen ? "bg-accent" : ""}`}
            title={t("matrix.menuTooltip")}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-md border border-border bg-popover shadow-md">
              <div className="px-3 py-2 text-[10px] font-semibold uppercase text-muted-foreground">
                {t("matrix.menu.displayMode")}
              </div>
              {displayModes.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent ${displayMode === m.value ? "font-semibold text-primary" : ""}`}
                  onClick={() => {
                    setDisplayMode(m.value);
                    setMenuOpen(false);
                  }}
                >
                  {displayMode === m.value && (
                    <Check
                      className="h-3 w-3 shrink-0 text-primary"
                      strokeWidth={3}
                      aria-hidden
                    />
                  )}
                  {displayMode !== m.value && <span className="w-3" />}
                  {m.label}
                </button>
              ))}
              <div className="my-1 border-t border-border/50" />
              <div className="px-3 py-2 text-[10px] font-semibold uppercase text-muted-foreground">
                {t("matrix.menu.rowFilters")}
              </div>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => setHideEmptyRows(!hideEmptyRows)}
              >
                <span>
                  {hideEmptyRows ? (
                    <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                  ) : (
                    <span className="w-3 inline-block" />
                  )}
                </span>
                {t("matrix.filters.hideEmpty", "空セルを非表示")}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => setOnlyUneditedRows(!onlyUneditedRows)}
              >
                <span>
                  {onlyUneditedRows ? (
                    <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                  ) : (
                    <span className="w-3 inline-block" />
                  )}
                </span>
                {t("matrix.filters.onlyUnedited", "未編集シーンのみ")}
              </button>
              <div className="my-1 border-t border-border/50" />
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => {
                  setMenuOpen(false);
                  onExportCsv();
                }}
              >
                <span className="w-3 inline-block" />
                {t("matrix.menu.exportCsv", "CSV をエクスポート")}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Subplot tag name input (subplot mode only) */}
      {showMode === "subplot" && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">
            {t("matrix.subplot.tagLabel")}
          </span>
          <input
            type="text"
            defaultValue={subplotTagName}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v)
                useMatrixStore.setState({
                  subplotTagName: v,
                  settingsSaved: false,
                });
            }}
            className="flex-1 rounded border border-border bg-background px-2 py-0.5 text-xs outline-none"
          />
        </div>
      )}

      {/* Custom set toolbar (custom mode only) */}
      {showMode === "custom" && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5">
          {customSets.length === 0 ? (
            <span className="flex-1 text-[11px] text-muted-foreground">
              {t("matrix.custom.noSets", "セットなし — 「+」で作成")}
            </span>
          ) : (
            <select
              value={activeCustomSetId ?? ""}
              onChange={(e) => setActiveCustomSetId(e.target.value || null)}
              className="flex-1 rounded border border-border bg-background px-2 py-0.5 text-xs"
            >
              <option value="">
                {t("matrix.custom.selectSet", "— セットを選択 —")}
              </option>
              {customSets.map((cs) => (
                <option key={cs.id} value={cs.id}>
                  {cs.name} ({cs.codexEntryIds.length})
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            title={t("matrix.custom.newSet", "新規セット")}
            className="rounded px-1.5 py-0.5 text-xs hover:bg-accent"
            onClick={() => {
              const name = window.prompt(
                t("matrix.custom.setNamePrompt", "セット名:"),
              );
              if (name?.trim()) createCustomSet(name.trim());
            }}
          >
            +
          </button>
          {activeCustomSetId && (
            <>
              <button
                type="button"
                title={t("matrix.custom.rename", "リネーム")}
                className="rounded px-1.5 py-0.5 text-xs hover:bg-accent"
                onClick={() => {
                  const current =
                    customSets.find((cs) => cs.id === activeCustomSetId)
                      ?.name ?? "";
                  const name = window.prompt(
                    t("matrix.custom.renamePrompt", "新しいセット名:"),
                    current,
                  );
                  if (name?.trim())
                    renameCustomSet(activeCustomSetId, name.trim());
                }}
              >
                <Pencil className="h-3 w-3" aria-hidden />
              </button>
              <button
                type="button"
                title={t("matrix.custom.delete", "削除")}
                className="rounded px-1.5 py-0.5 text-xs text-destructive hover:bg-accent"
                onClick={() => {
                  if (
                    window.confirm(
                      t(
                        "matrix.custom.deleteConfirm",
                        "このセットを削除しますか?",
                      ),
                    )
                  )
                    deleteCustomSet(activeCustomSetId);
                }}
              >
                ×
              </button>
            </>
          )}
        </div>
      )}

      {/* Search row */}
      {searchOpen && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchQuery("");
                setSearchOpen(false);
              }
            }}
            placeholder={t("matrix.header.searchPlaceholder")}
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Tag filter row (hidden for pov/location/custom modes) */}
      {showTagFilter && (
        <div className="relative flex flex-wrap items-center gap-1 border-t px-3 py-1">
          {currentTags.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px]"
            >
              #{tag}
              <button type="button" onClick={() => removeTag(tag)}>
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <input
            type="text"
            value={tagInput}
            onChange={(e) => {
              setTagInput(e.target.value);
              setShowTagSuggestions(true);
            }}
            onFocus={() => setShowTagSuggestions(true)}
            onBlur={() => setTimeout(() => setShowTagSuggestions(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && tagInput.trim()) {
                addTag(tagInput.trim().replace(/^#/, ""));
              }
              if (e.key === "Escape") setShowTagSuggestions(false);
            }}
            placeholder={
              currentTags.length === 0
                ? t("matrix.header.filterPlaceholder")
                : ""
            }
            className="min-w-[80px] flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
          />
          {showTagSuggestions && suggestions.length > 0 && (
            <div className="absolute left-2 top-full z-50 mt-0.5 max-h-36 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
              {suggestions.map((t) => (
                <button
                  key={t}
                  type="button"
                  onMouseDown={() => addTag(t)}
                  className="block w-full px-3 py-1 text-left text-xs hover:bg-accent"
                >
                  #{t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
