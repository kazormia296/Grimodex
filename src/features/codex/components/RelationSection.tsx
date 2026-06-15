import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { useCodexStore } from "../codexStore";
import type { CodexEntry } from "../api";
import {
  listDismissedRelationIds,
  dismissRelation,
  undismissRelation,
  setParentRelation,
} from "../relationApi";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { extractPlainText } from "../prosemirrorTextExtractor";
import { findMentionedEntriesAsync } from "../rustMatcher";
import { getChildrenFromArray } from "../childrenBudget";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";

interface RelationSectionProps {
  entry: CodexEntry;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium">
      {getTypeLabel(type)}
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
  const { t } = useTranslation();
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
        {t("codex.relation.addChild")}
      </button>
    );
  }

  return (
    <div className="mt-1">
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={t("codex.relation.searchPlaceholder")}
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
        {t("common.cancel")}
      </button>
    </div>
  );
}

export function RelationSection({ entry }: RelationSectionProps) {
  const { t } = useTranslation();
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

  const [suggestions, setSuggestions] = useState<CodexEntry[]>([]);
  useEffect(() => {
    const text = extractPlainText(entry.content ?? "{}");
    const existingIds = new Set<string>(
      [
        entry.id,
        entry.parentId,
        ...children.map((c) => c.id),
        ...dismissedIds,
      ].filter(Boolean) as string[],
    );
    void findMentionedEntriesAsync(text, allEntries).then((mentioned) => {
      setSuggestions(
        mentioned.filter((e) => !existingIds.has(e.id)) as CodexEntry[],
      );
    });
  }, [entry, allEntries, children, dismissedIds]);

  const pushParentChange = useCallback(
    (
      childId: string,
      beforeParentId: string | null,
      afterParentId: string | null,
    ) => {
      if (beforeParentId === afterParentId) return;
      if (useGlobalHistoryStore.getState().isReplaying) return;
      useGlobalHistoryStore.getState().push({
        kind: "codex",
        label: t("codex.relation.historyParentChange"),
        async undo() {
          await setParentRelation(childId, beforeParentId);
          await loadEntries();
        },
        async redo() {
          await setParentRelation(childId, afterParentId);
          await loadEntries();
        },
      });
    },
    [loadEntries, t],
  );

  const handleRemoveParent = useCallback(async () => {
    const beforeParentId = entry.parentId ?? null;
    try {
      await setParentRelation(entry.id, null);
    } catch (err) {
      toast.error(t("codex.relation.removeParentFailed"), {
        description: String(err),
      });
      return;
    }
    await loadEntries();
    pushParentChange(entry.id, beforeParentId, null);
  }, [entry.id, entry.parentId, loadEntries, pushParentChange, t]);

  const handleAddChild = useCallback(
    async (childEntry: CodexEntry) => {
      const beforeParentId = childEntry.parentId ?? null;
      try {
        await setParentRelation(childEntry.id, entry.id);
      } catch (err) {
        toast.error(t("codex.relation.addChildFailed"), {
          description: String(err),
        });
        return;
      }
      await loadEntries();
      pushParentChange(childEntry.id, beforeParentId, entry.id);
    },
    [entry.id, loadEntries, pushParentChange, t],
  );

  const handleDismiss = useCallback(
    async (dismissedId: string) => {
      try {
        await dismissRelation(entry.id, dismissedId);
      } catch (err) {
        toast.error(t("codex.relation.dismissFailed"), {
          description: String(err),
        });
        return;
      }
      setDismissedIds((prev) => new Set([...prev, dismissedId]));

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const cap = { entryId: entry.id, dismissedId };
        useGlobalHistoryStore.getState().push({
          kind: "codex",
          label: t("codex.relation.historyDismiss"),
          async undo() {
            await undismissRelation(cap.entryId, cap.dismissedId);
            setDismissedIds((prev) => {
              const next = new Set(prev);
              next.delete(cap.dismissedId);
              return next;
            });
          },
          async redo() {
            await dismissRelation(cap.entryId, cap.dismissedId);
            setDismissedIds((prev) => new Set([...prev, cap.dismissedId]));
          },
        });
      }
    },
    [entry.id, t],
  );

  const handleAddSuggestion = useCallback(
    async (suggestionId: string) => {
      const suggestion = allEntries.find((e) => e.id === suggestionId);
      const beforeParentId = suggestion?.parentId ?? null;
      try {
        await setParentRelation(suggestionId, entry.id);
      } catch (err) {
        toast.error(t("codex.relation.addChildFailed"), {
          description: String(err),
        });
        return;
      }
      await loadEntries();
      pushParentChange(suggestionId, beforeParentId, entry.id);
    },
    [entry.id, allEntries, loadEntries, pushParentChange, t],
  );

  const childIds = useMemo(
    () => new Set([entry.id, ...children.map((c) => c.id)]),
    [entry.id, children],
  );

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div>
        <h3 className="text-xs font-semibold">{t("codex.relation.title")}</h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {t("codex.relation.hierarchyDesc")}
        </p>
      </div>

      {/* Parent */}
      <div>
        <SectionLabel>{t("codex.relation.parent")}</SectionLabel>
        {parent ? (
          <div className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5">
            <TypeBadge type={parent.type} />
            <span className="flex-1 truncate text-xs font-medium">
              {parent.name}
            </span>
            <button
              type="button"
              onClick={handleRemoveParent}
              title={t("codex.relation.removeParent")}
              className="text-muted-foreground hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {t("codex.relation.none")}
          </p>
        )}
      </div>

      {/* Children */}
      <div>
        <SectionLabel>{t("codex.relation.children")}</SectionLabel>
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
          <p className="text-[11px] text-muted-foreground">
            {t("codex.relation.none")}
          </p>
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
          <SectionLabel>{t("codex.relation.suggestions")}</SectionLabel>
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
                  title={t("codex.relation.addAsChild")}
                  onClick={() => void handleAddSuggestion(s.id)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <Plus className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  title={t("codex.relation.dismiss")}
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
