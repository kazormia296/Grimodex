import { useState, useEffect } from "react";
import type { CodexEntry } from "@/features/codex/api";
import { EntryIcon } from "./EntryIcon";
import { TagPill } from "./TagPill";

export type TagCacheItem = { name: string; color: string | null };

export function parseTags(
  tagsCache: string | null | undefined,
): TagCacheItem[] {
  if (!tagsCache) return [];
  try {
    const parsed = JSON.parse(tagsCache) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    if (typeof parsed[0] === "object" && parsed[0] !== null) {
      return parsed as TagCacheItem[];
    }
    return (parsed as string[]).map((name) => ({ name, color: null }));
  } catch {
    return [];
  }
}

export function HighlightedName({
  name,
  query,
}: {
  name: string;
  query: string;
}): React.ReactElement {
  if (!query) return <>{name}</>;
  const lower = name.toLowerCase();
  const lowerQ = query.toLowerCase();
  const idx = lower.indexOf(lowerQ);
  if (idx === -1) return <>{name}</>;
  return (
    <>
      {name.slice(0, idx)}
      <mark className="bg-yellow-200/60 dark:bg-yellow-500/30 rounded px-0.5">
        {name.slice(idx, idx + query.length)}
      </mark>
      {name.slice(idx + query.length)}
    </>
  );
}

export function EntryCardBody({
  entry,
  searchQuery = "",
}: {
  entry: CodexEntry;
  searchQuery?: string;
}) {
  const cachedTags = parseTags(entry.tagsCache);
  return (
    <>
      <div className="flex items-center gap-2 overflow-hidden">
        <EntryIcon
          icon={entry.icon as string | null}
          entryType={entry.type}
          size={28}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          <HighlightedName name={entry.name} query={searchQuery} />
        </span>
        {cachedTags.length > 0 && (
          <div className="flex shrink-0 items-center gap-0.5">
            {cachedTags.slice(0, 2).map((tag) => (
              <TagPill
                key={tag.name}
                name={tag.name}
                color={tag.color}
                size="sm"
              />
            ))}
            {cachedTags.length > 2 && (
              <span className="rounded-full bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                +{cachedTags.length - 2}
              </span>
            )}
          </div>
        )}
      </div>
      {entry.summary && (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {entry.summary}
        </p>
      )}
    </>
  );
}

export function EntryCard({
  entry,
  isSelected,
  onSelect,
  onContextMenu,
  searchQuery = "",
  isRenaming = false,
  onRenameCommit,
  onRenameCancel,
}: {
  entry: CodexEntry;
  isSelected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  searchQuery?: string;
  isRenaming?: boolean;
  onRenameCommit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
}) {
  const [renameValue, setRenameValue] = useState(entry.name);

  useEffect(() => {
    if (isRenaming) setRenameValue(entry.name);
  }, [isRenaming, entry.name]);

  if (isRenaming) {
    return (
      <div className="border-b border-border px-3 py-2">
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRenameCommit?.(entry.id, renameValue.trim() || entry.name);
            } else if (e.key === "Escape") {
              onRenameCancel?.();
            }
          }}
          onBlur={() =>
            onRenameCommit?.(entry.id, renameValue.trim() || entry.name)
          }
          className="w-full rounded border border-input bg-background px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
    );
  }

  return (
    <div className="border-b border-border">
      <button
        type="button"
        data-testid={`codex-entry-${entry.id}`}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        className={`w-full px-3 py-2 text-left hover:bg-accent ${isSelected ? "bg-accent" : ""}`}
      >
        <EntryCardBody entry={entry} searchQuery={searchQuery} />
      </button>
    </div>
  );
}
