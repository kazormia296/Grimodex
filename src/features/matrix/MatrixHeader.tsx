import { useState, useRef, useEffect } from "react";
import { Search, X, MoreVertical } from "lucide-react";
import { useMatrixStore } from "./matrixStore";
import type { ShowMode } from "./lib/deriveColumns";
import type { DisplayMode, SortMode } from "./matrixStore";

const SHOW_MODES: { value: ShowMode; label: string; disabled?: boolean }[] = [
  { value: "codex-all", label: "Codex (all)" },
  { value: "codex-characters", label: "Codex (characters)" },
  { value: "codex-locations", label: "Codex (locations)" },
  { value: "codex-items", label: "Codex (items)" },
  { value: "codex-lore", label: "Codex (lore)" },
  { value: "pov", label: "POV" },
  { value: "location", label: "Location" },
  { value: "subplot", label: "Subplot" },
  { value: "custom", label: "Custom" },
];

const SORT_MODES: { value: SortMode; label: string }[] = [
  { value: "reading", label: "Reading order" },
  { value: "story-time", label: "Story-time order" },
  { value: "word-count", label: "Word count" },
  { value: "last-edited", label: "Last edited" },
];

const DISPLAY_MODES: { value: DisplayMode; label: string }[] = [
  { value: "dot", label: "Dot (●/◯)" },
  { value: "count", label: "Count" },
  { value: "heatmap", label: "Heatmap" },
  { value: "pov-color", label: "POV color" },
  { value: "role-aware", label: "Role-aware (★●◯)" },
];

/** Show modes where the tag-filter row is hidden */
const NO_TAG_FILTER_MODES = new Set<ShowMode>(["pov", "location", "custom"]);

interface Props {
  availableTags: string[];
  onExportCsv: () => void;
}

export function MatrixHeader({ availableTags, onExportCsv }: Props) {
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
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-semibold">Matrix</span>
        <div className="flex-1" />

        {/* Show mode */}
        <select
          value={showMode}
          onChange={(e) => setShowMode(e.target.value as ShowMode)}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          {SHOW_MODES.map((m) => (
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
          {SORT_MODES.map((m) => (
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
          title="Search scenes / codex"
        >
          <Search className="h-3.5 w-3.5" />
        </button>

        {/* Panel menu */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className={`rounded p-1 hover:bg-accent ${menuOpen ? "bg-accent" : ""}`}
            title="Panel menu"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-md border border-border bg-popover shadow-md">
              <div className="px-3 py-2 text-[10px] font-semibold uppercase text-muted-foreground">
                Display mode
              </div>
              {DISPLAY_MODES.map((m) => (
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
                    <span className="text-primary">✓</span>
                  )}
                  {displayMode !== m.value && <span className="w-3" />}
                  {m.label}
                </button>
              ))}
              <div className="my-1 border-t border-border/50" />
              <div className="px-3 py-2 text-[10px] font-semibold uppercase text-muted-foreground">
                Row filters
              </div>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => setHideEmptyRows(!hideEmptyRows)}
              >
                <span>
                  {hideEmptyRows ? "✓" : <span className="w-3 inline-block" />}
                </span>
                空セルを非表示
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => setOnlyUneditedRows(!onlyUneditedRows)}
              >
                <span>
                  {onlyUneditedRows ? (
                    "✓"
                  ) : (
                    <span className="w-3 inline-block" />
                  )}
                </span>
                未編集シーンのみ
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
                CSV をエクスポート
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Subplot tag name input (subplot mode only) */}
      {showMode === "subplot" && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">
            Subplot tag:
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
              セットなし — 「+」で作成
            </span>
          ) : (
            <select
              value={activeCustomSetId ?? ""}
              onChange={(e) => setActiveCustomSetId(e.target.value || null)}
              className="flex-1 rounded border border-border bg-background px-2 py-0.5 text-xs"
            >
              <option value="">— セットを選択 —</option>
              {customSets.map((cs) => (
                <option key={cs.id} value={cs.id}>
                  {cs.name} ({cs.codexEntryIds.length})
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            title="新規セット"
            className="rounded px-1.5 py-0.5 text-xs hover:bg-accent"
            onClick={() => {
              const name = window.prompt("セット名:");
              if (name?.trim()) createCustomSet(name.trim());
            }}
          >
            +
          </button>
          {activeCustomSetId && (
            <>
              <button
                type="button"
                title="リネーム"
                className="rounded px-1.5 py-0.5 text-xs hover:bg-accent"
                onClick={() => {
                  const current =
                    customSets.find((cs) => cs.id === activeCustomSetId)
                      ?.name ?? "";
                  const name = window.prompt("新しいセット名:", current);
                  if (name?.trim())
                    renameCustomSet(activeCustomSetId, name.trim());
                }}
              >
                ✎
              </button>
              <button
                type="button"
                title="削除"
                className="rounded px-1.5 py-0.5 text-xs text-destructive hover:bg-accent"
                onClick={() => {
                  if (window.confirm("このセットを削除しますか?"))
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
            placeholder="Search scenes or codex…"
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
            placeholder={currentTags.length === 0 ? "Filter by tag…" : ""}
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
