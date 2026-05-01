import { useState } from "react";
import { Search, X, MoreVertical } from "lucide-react";
import { useMatrixStore } from "./matrixStore";
import type { ShowMode } from "./lib/deriveColumns";

const SHOW_MODES: { value: ShowMode; label: string }[] = [
  { value: "codex-all", label: "Codex (all)" },
  { value: "codex-characters", label: "Codex (characters)" },
  { value: "codex-locations", label: "Codex (locations)" },
  { value: "codex-items", label: "Codex (items)" },
  { value: "codex-lore", label: "Codex (lore)" },
];

const SORT_MODES = [
  { value: "reading" as const, label: "Reading order" },
  { value: "story-time" as const, label: "Story-time order" },
];

interface Props {
  availableTags: string[];
}

export function MatrixHeader({ availableTags }: Props) {
  const showMode = useMatrixStore((s) => s.showMode);
  const sortMode = useMatrixStore((s) => s.sortMode);
  const tagFilter = useMatrixStore((s) => s.tagFilter);
  const setShowMode = useMatrixStore((s) => s.setShowMode);
  const setSortMode = useMatrixStore((s) => s.setSortMode);
  const setTagFilter = useMatrixStore((s) => s.setTagFilter);
  const searchQuery = useMatrixStore((s) => s.searchQuery);
  const setSearchQuery = useMatrixStore((s) => s.setSearchQuery);

  const [searchOpen, setSearchOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);

  const currentTags = tagFilter[showMode] ?? [];

  const suggestions = availableTags.filter(
    (t) =>
      t.toLowerCase().includes(tagInput.toLowerCase()) &&
      !currentTags.includes(t),
  );

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
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        {/* Sort mode */}
        <select
          value={sortMode}
          onChange={(e) =>
            setSortMode(e.target.value as "reading" | "story-time")
          }
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

        {/* Panel menu placeholder */}
        <button
          type="button"
          className="rounded p-1 hover:bg-accent"
          title="Panel menu"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </div>

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

      {/* Tag filter row */}
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
    </div>
  );
}
