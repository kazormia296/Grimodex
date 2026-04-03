import { useEffect, useState, useCallback, useMemo } from "react";
import { Plus, X } from "lucide-react";
import { useCodexStore } from "../codexStore";
import type { CodexEntry } from "../api";
import {
  listDismissedRelationIds,
  dismissRelation,
  setParentRelation,
} from "../relationApi";
import { extractPlainText } from "../prosemirrorTextExtractor";
import { findMentionedEntries } from "../codexMatcher";
import { getChildrenFromArray } from "../childrenBudget";

const TYPE_LABELS: Record<string, string> = {
  character: "キャラクター",
  location: "場所",
  item: "アイテム",
  lore: "設定・世界観",
};

interface RelationSectionProps {
  entry: CodexEntry;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium">
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h4>
  );
}

function AddChildInput({
  allEntries,
  currentChildIds,
  onAdd,
}: {
  allEntries: CodexEntry[];
  currentChildIds: Set<string>;
  onAdd: (entry: CodexEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return allEntries
      .filter(
        (e) => !currentChildIds.has(e.id) && e.name.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [query, allEntries, currentChildIds]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Plus className="h-3 w-3" />
        子を追加
      </button>
    );
  }

  return (
    <div className="mt-1">
      <input
        autoFocus
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="名前で検索..."
        className="w-full rounded border border-input bg-background px-2 py-1 text-xs outline-none"
      />
      {results.length > 0 && (
        <ul className="mt-0.5 max-h-40 overflow-y-auto rounded border border-border bg-background shadow-sm">
          {results.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => {
                  onAdd(e);
                  setOpen(false);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                <TypeBadge type={e.type} />
                <span className="truncate">{e.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-0.5 text-[10px] text-muted-foreground hover:underline"
      >
        キャンセル
      </button>
    </div>
  );
}

export function RelationSection({ entry }: RelationSectionProps) {
  const allEntries = useCodexStore((s) => s.entries);
  const loadEntries = useCodexStore((s) => s.loadEntries);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    listDismissedRelationIds(entry.id).then((ids) =>
      setDismissedIds(new Set(ids)),
    );
  }, [entry.id]);

  const children = useMemo(
    () => getChildrenFromArray(entry.id, allEntries),
    [entry.id, allEntries],
  );

  const parent = useMemo(
    () => allEntries.find((e) => e.id === entry.parentId),
    [allEntries, entry.parentId],
  );

  const suggestions = useMemo(() => {
    const text = extractPlainText(entry.content ?? "{}");
    const existingIds = new Set<string>(
      [
        entry.id,
        entry.parentId,
        ...children.map((c) => c.id),
        ...dismissedIds,
      ].filter(Boolean) as string[],
    );
    return findMentionedEntries(text, allEntries).filter(
      (e) => !existingIds.has(e.id),
    );
  }, [entry, allEntries, children, dismissedIds]);

  const handleRemoveParent = useCallback(async () => {
    await setParentRelation(entry.id, null);
    await loadEntries();
  }, [entry.id, loadEntries]);

  const handleAddChild = useCallback(
    async (childEntry: CodexEntry) => {
      await setParentRelation(childEntry.id, entry.id);
      await loadEntries();
    },
    [entry.id, loadEntries],
  );

  const handleDismiss = useCallback(
    async (dismissedId: string) => {
      await dismissRelation(entry.id, dismissedId);
      setDismissedIds((prev) => new Set([...prev, dismissedId]));
    },
    [entry.id],
  );

  const handleAddSuggestion = useCallback(
    async (suggestionId: string) => {
      await setParentRelation(suggestionId, entry.id);
      await loadEntries();
    },
    [entry.id, loadEntries],
  );

  const childIds = useMemo(
    () => new Set([entry.id, ...children.map((c) => c.id)]),
    [entry.id, children],
  );

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <h3 className="text-xs font-semibold">リレーション</h3>

      {/* Parent */}
      <div>
        <SectionLabel>親エントリ</SectionLabel>
        {parent ? (
          <div className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5">
            <TypeBadge type={parent.type} />
            <span className="flex-1 truncate text-xs font-medium">
              {parent.name}
            </span>
            <button
              type="button"
              onClick={handleRemoveParent}
              title="親を解除"
              className="text-muted-foreground hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">(なし)</p>
        )}
      </div>

      {/* Children */}
      <div>
        <SectionLabel>子エントリ</SectionLabel>
        {children.length > 0 ? (
          <ul className="space-y-1">
            {children.map((child) => (
              <li
                key={child.id}
                className="flex items-center gap-2 rounded bg-muted/30 px-2 py-1.5"
              >
                <TypeBadge type={child.type} />
                <span className="flex-1 truncate text-xs">{child.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">(なし)</p>
        )}
        <AddChildInput
          allEntries={allEntries}
          currentChildIds={childIds}
          onAdd={handleAddChild}
        />
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div>
          <SectionLabel>提案</SectionLabel>
          <ul className="space-y-1">
            {suggestions.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-1.5 rounded px-2 py-1"
              >
                <span className="mr-0.5 text-[11px] text-muted-foreground">
                  ○
                </span>
                <TypeBadge type={s.type} />
                <span className="flex-1 truncate text-xs">{s.name}</span>
                <button
                  type="button"
                  title="子として追加"
                  onClick={() => void handleAddSuggestion(s.id)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <Plus className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  title="却下"
                  onClick={() => void handleDismiss(s.id)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
