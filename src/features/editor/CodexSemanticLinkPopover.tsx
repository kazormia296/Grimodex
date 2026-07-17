import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorEvents } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { parseAliases } from "@/features/codex/codexMatcher";
import { useCodexStore } from "@/features/codex/codexStore";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { ensureEditorOverlayVisible } from "@/features/editor/ensureOverlayVisible";

interface SavedRange {
  from: number;
  to: number;
}

interface CodexSemanticLinkPopoverProps {
  editor: Editor | null;
}

function selectionHasSemanticLink(editor: Editor, range: SavedRange): boolean {
  const markType = editor.schema.marks.codexSemanticLink;
  if (!markType) return false;

  let found = false;
  editor.state.doc.nodesBetween(range.from, range.to, (node) => {
    if (found) return false;
    found = node.marks.some((mark) => mark.type === markType);
    return !found;
  });
  return found;
}

export function CodexSemanticLinkPopover({
  editor,
}: CodexSemanticLinkPopoverProps) {
  const { t } = useTranslation();
  const open = useCursorSettingsStore((s) => s.semanticLinkPickerOpen);
  const owner = useCursorSettingsStore((s) => s.semanticLinkPickerOwner);
  const setOpen = useCursorSettingsStore((s) => s.setSemanticLinkPickerOpen);
  const completionTargets = useCodexStore((s) => s.completionTargets);
  const ensureEntriesLoaded = useCodexStore((s) => s.ensureEntriesLoaded);

  const [savedRange, setSavedRange] = useState<SavedRange | null>(null);
  const [position, setPosition] = useState({ x: 8, y: 8 });
  const [search, setSearch] = useState("");
  const [hasExistingLink, setHasExistingLink] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !editor || (owner !== null && owner !== editor)) {
      setSavedRange(null);
      setSearch("");
      setHasExistingLink(false);
      return;
    }

    if (!editor.isEditable) {
      setOpen(false);
      return;
    }

    const { from, to } = editor.state.selection;
    if (from === to) {
      setOpen(false);
      return;
    }

    const range = { from, to };
    setSavedRange(range);
    setHasExistingLink(selectionHasSemanticLink(editor, range));

    try {
      const coords = editor.view.coordsAtPos(to);
      setPosition({ x: coords.left, y: coords.bottom + 6 });
    } catch {
      // A headless editor or a just-unmounted view has no measurable caret.
      setPosition({ x: 8, y: 8 });
    }

    void ensureEntriesLoaded();
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [open, owner, editor, ensureEntriesLoaded, setOpen]);

  useEffect(() => {
    if (!open || !editor || owner !== editor) return;
    return () => {
      const state = useCursorSettingsStore.getState();
      if (
        state.semanticLinkPickerOpen &&
        state.semanticLinkPickerOwner === editor
      ) {
        state.setSemanticLinkPickerOpen(false);
      }
    };
  }, [open, owner, editor]);

  useEffect(() => {
    if (!open || !editor || owner !== editor) return;

    const closeOnDocumentChange = ({
      transaction,
    }: EditorEvents["transaction"]) => {
      if (!transaction.docChanged) return;
      const state = useCursorSettingsStore.getState();
      if (
        state.semanticLinkPickerOpen &&
        state.semanticLinkPickerOwner === editor
      ) {
        state.setSemanticLinkPickerOpen(false);
      }
    };

    editor.on("transaction", closeOnDocumentChange);
    return () => {
      editor.off("transaction", closeOnDocumentChange);
    };
  }, [open, owner, editor]);

  const close = useCallback(() => {
    setOpen(false);
    editor?.commands.focus(null, { scrollIntoView: false });
  }, [editor, setOpen]);

  useEffect(() => {
    if (!open || !editor || (owner !== null && owner !== editor)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, owner, editor, close]);

  const filteredTargets = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = completionTargets.filter((target) => {
      if (!query) return true;
      return [target.name, ...parseAliases(target.aliases)].some((surface) =>
        surface.toLocaleLowerCase().includes(query),
      );
    });
    return matches.slice(0, 100);
  }, [completionTargets, search]);

  const applyLink = (entryId: string) => {
    if (!editor || editor.isDestroyed || !editor.isEditable || !savedRange) {
      close();
      return;
    }
    const target = useCodexStore
      .getState()
      .completionTargets.find((entry) => entry.id === entryId);
    if (!target) {
      close();
      return;
    }
    editor
      .chain()
      .setTextSelection(savedRange)
      .setMark("codexSemanticLink", { entryId, label: target.name })
      .run();
    ensureEditorOverlayVisible("codex", editor);
    close();
  };

  const removeLink = () => {
    if (!editor || editor.isDestroyed || !editor.isEditable || !savedRange) {
      close();
      return;
    }
    editor
      .chain()
      .setTextSelection(savedRange)
      .unsetMark("codexSemanticLink")
      .run();
    close();
  };

  if (!open || !editor || (owner !== null && owner !== editor) || !savedRange) {
    return null;
  }

  const width = 288;
  const x = Math.max(8, Math.min(position.x, window.innerWidth - width - 8));
  const y = Math.max(8, Math.min(position.y, window.innerHeight - 300));

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t(
        "editor.semanticLink.pickerLabel",
        "Codex セマンティックリンク",
      )}
      className="fixed z-50 flex w-72 flex-col rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
        {t("editor.semanticLink.heading", "Codex エントリにリンク")}
      </div>
      <div className="border-b border-border p-2">
        <input
          ref={searchRef}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t("editor.semanticLink.search", "Codex エントリを検索")}
          placeholder={t(
            "editor.semanticLink.searchPlaceholder",
            "名前・別名で検索…",
          )}
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <div className="max-h-56 overflow-y-auto py-1">
        {filteredTargets.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("editor.semanticLink.noResults", "見つかりません")}
          </p>
        ) : (
          filteredTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              data-testid={`semantic-link-entry-${target.id}`}
              onClick={() => applyLink(target.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {target.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {getTypeLabel(target.type)}
              </span>
            </button>
          ))
        )}
      </div>
      {hasExistingLink && (
        <button
          type="button"
          data-testid="semantic-link-remove"
          onClick={removeLink}
          className="border-t border-border px-3 py-2 text-left text-xs text-destructive hover:bg-destructive/10"
        >
          {t("editor.semanticLink.remove", "Codex リンクを解除")}
        </button>
      )}
    </div>,
    document.body,
  );
}
