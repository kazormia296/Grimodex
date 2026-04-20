import { useEffect, useState } from "react";
import { AnimatedPopover } from "@/components/ui/animated-popover";
import { useTranslation } from "react-i18next";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { getChildrenFromArray } from "@/features/codex/childrenBudget";
import type { CodexEntry } from "@/features/codex/api";
import type { Snippet } from "@/features/snippets/api";
import { EntryCardBody } from "@/features/codex/components/EntryCard";
import { SnippetCardBody } from "@/features/snippets/components/SnippetCardBody";

function PinCodexList({
  entries,
  pinnedIds,
  withChildrenIds,
  onPin,
  onUnpin,
  onToggleChildren,
}: {
  entries: CodexEntry[];
  pinnedIds: Set<string>;
  withChildrenIds: Set<string>;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onToggleChildren: (id: string, withChildren: boolean) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="max-h-72 overflow-y-auto">
      {entries.map((entry) => {
        const isPinned = pinnedIds.has(entry.id);
        const hasChildren = getChildrenFromArray(entry.id, entries).length > 0;
        const isWithChildren = withChildrenIds.has(entry.id);

        return (
          <div key={entry.id} className="border-b border-border last:border-0">
            <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-accent">
              <input
                type="checkbox"
                checked={isPinned}
                onChange={() =>
                  isPinned ? onUnpin(entry.id) : onPin(entry.id)
                }
                className="mt-1 shrink-0 rounded"
              />
              <div className="min-w-0 flex-1">
                <EntryCardBody entry={entry} />
              </div>
            </label>
            {isPinned && hasChildren && (
              <label className="ml-8 flex cursor-pointer items-center gap-1.5 px-2 pb-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={isWithChildren}
                  onChange={(e) => onToggleChildren(entry.id, e.target.checked)}
                  className="rounded"
                />
                {t("chat.context.includeChildren")}
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PinSnippetList({
  snippets,
  pinnedSnippetIds,
  onPin,
  onUnpin,
}: {
  snippets: Snippet[];
  pinnedSnippetIds: Set<string>;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
}) {
  return (
    <div className="max-h-72 overflow-y-auto">
      {snippets.map((snippet) => {
        const isPinned = pinnedSnippetIds.has(snippet.id);

        return (
          <label
            key={snippet.id}
            className="flex cursor-pointer items-start gap-2 rounded border-b border-border px-2 py-1.5 last:border-0 hover:bg-accent"
          >
            <input
              type="checkbox"
              checked={isPinned}
              onChange={() =>
                isPinned ? onUnpin(snippet.id) : onPin(snippet.id)
              }
              className="mt-0.5 shrink-0 rounded"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">
                {snippet.title}
              </p>
              <SnippetCardBody snippet={snippet} />
            </div>
          </label>
        );
      })}
    </div>
  );
}

interface PinCodexDialogProps {
  open: boolean;
  pinnedIds: Set<string>;
  withChildrenIds: Set<string>;
  pinnedSnippetIds: Set<string>;
  onPin: (entryId: string, type?: "codex" | "snippet") => void;
  onUnpin: (entryId: string) => void;
  onToggleChildren: (entryId: string, withChildren: boolean) => void;
  onClose: () => void;
  containerRef?: React.RefObject<HTMLElement | null>;
}

export function PinCodexDialog({
  open,
  pinnedIds,
  withChildrenIds,
  pinnedSnippetIds,
  onPin,
  onUnpin,
  onToggleChildren,
  onClose,
  containerRef,
}: PinCodexDialogProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"codex" | "snippet">("codex");
  const entries = useCodexStore((s) => s.entries);
  const loadEntries = useCodexStore((s) => s.loadEntries);
  const snippetEntries = useSnippetStore((s) => s.entries);
  const loadSnippets = useSnippetStore((s) => s.loadEntries);

  useEffect(() => {
    if (open) {
      loadEntries();
      loadSnippets();
    }
  }, [open, loadEntries, loadSnippets]);

  return (
    <AnimatedPopover
      open={open}
      onClose={onClose}
      containerRef={containerRef}
      className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-background p-4 shadow-lg"
    >
      <h3 className="mb-3 text-sm font-semibold">
        {t("chat.context.pinEntries")}
      </h3>

      {/* Tab selector */}
      <div className="mb-3 flex overflow-hidden rounded-md border border-border">
        <button
          type="button"
          onClick={() => setActiveTab("codex")}
          className={`flex-1 px-3 py-1 text-xs font-medium transition-colors ${
            activeTab === "codex"
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-accent"
          }`}
        >
          Codex
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("snippet")}
          className={`flex-1 px-3 py-1 text-xs font-medium transition-colors ${
            activeTab === "snippet"
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-accent"
          }`}
        >
          Snippet
        </button>
      </div>

      {activeTab === "codex" ? (
        entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("chat.context.noCodexEntries")}
          </p>
        ) : (
          <PinCodexList
            entries={entries}
            pinnedIds={pinnedIds}
            withChildrenIds={withChildrenIds}
            onPin={(id) => onPin(id, "codex")}
            onUnpin={onUnpin}
            onToggleChildren={onToggleChildren}
          />
        )
      ) : snippetEntries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("chat.context.noSnippets")}
        </p>
      ) : (
        <PinSnippetList
          snippets={snippetEntries}
          pinnedSnippetIds={pinnedSnippetIds}
          onPin={(id) => onPin(id, "snippet")}
          onUnpin={onUnpin}
        />
      )}
    </AnimatedPopover>
  );
}
