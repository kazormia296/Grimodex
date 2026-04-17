import { useEffect, useRef, useState } from "react";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { getChildrenFromArray } from "@/features/codex/childrenBudget";
import type { CodexEntry } from "@/features/codex/api";
import type { Snippet } from "@/features/snippets/api";
import { getTypeLabel } from "../utils/typeLabels";

function PinCodexVirtualList({
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
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 5,
  });

  return (
    <div ref={parentRef} className="max-h-72 overflow-y-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const entry = entries[virtualItem.index];
          const isPinned = pinnedIds.has(entry.id);
          const hasChildren =
            getChildrenFromArray(entry.id, entries).length > 0;
          const isWithChildren = withChildrenIds.has(entry.id);

          return (
            <div
              key={entry.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
              className="flex flex-col justify-center rounded px-2 hover:bg-accent"
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isPinned}
                  onChange={() =>
                    isPinned ? onUnpin(entry.id) : onPin(entry.id)
                  }
                  className="rounded"
                />
                <span>{entry.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {getTypeLabel(entry.type)}
                </span>
              </label>
              {isPinned && hasChildren && (
                <label className="ml-5 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={isWithChildren}
                    onChange={(e) =>
                      onToggleChildren(entry.id, e.target.checked)
                    }
                    className="rounded"
                  />
                  {t("chat.context.includeChildren")}
                </label>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PinSnippetVirtualList({
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
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: snippets.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 5,
  });

  return (
    <div ref={parentRef} className="max-h-72 overflow-y-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const snippet = snippets[virtualItem.index];
          const isPinned = pinnedSnippetIds.has(snippet.id);

          return (
            <div
              key={snippet.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
              className="flex items-center rounded px-2 hover:bg-accent"
            >
              <label className="flex w-full cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isPinned}
                  onChange={() =>
                    isPinned ? onUnpin(snippet.id) : onPin(snippet.id)
                  }
                  className="rounded"
                />
                <span className="truncate">{snippet.title}</span>
              </label>
            </div>
          );
        })}
      </div>
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
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="max-h-[28rem] w-80 rounded-lg border border-border bg-background p-4 shadow-lg"
    >
      <h3 className="mb-3 text-sm font-semibold">
        {t("chat.context.pinEntries")}
      </h3>

      {/* Tab selector */}
      <div className="mb-3 flex rounded-md border border-border overflow-hidden">
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
          <PinCodexVirtualList
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
        <PinSnippetVirtualList
          snippets={snippetEntries}
          pinnedSnippetIds={pinnedSnippetIds}
          onPin={(id) => onPin(id, "snippet")}
          onUnpin={onUnpin}
        />
      )}

      <button
        type="button"
        onClick={onClose}
        className="mt-3 w-full rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
      >
        {t("common.close")}
      </button>
    </AnimatedOverlay>
  );
}
