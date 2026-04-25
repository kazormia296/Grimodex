import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useForeshadowStore } from "./foreshadowStore";

const PROJECT_ID = "default-project";

type MarkMode = "setup" | "payoff" | "payoff-unanchored";

interface SavedRange {
  from: number;
  to: number;
}

interface Props {
  editor: Editor | null;
}

export function ForeshadowMarkPopover({ editor }: Props) {
  const { t } = useTranslation();
  const open = useCursorSettingsStore((s) => s.foreshadowPickerOpen);
  const setOpen = useCursorSettingsStore((s) => s.setForeshadowPickerOpen);

  const { items, isLoading, load, create } = useForeshadowStore();

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [savedRange, setSavedRange] = useState<SavedRange | null>(null);
  const [mode, setMode] = useState<MarkMode | null>(null);
  const [search, setSearch] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const newTitleRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !editor) {
      setMode(null);
      setSearch("");
      setNewTitle("");
      setShowNewForm(false);
      setPos(null);
      setSavedRange(null);
      return;
    }

    const { from, to } = editor.state.selection;
    if (from === to) {
      setOpen(false);
      return;
    }

    const coords = editor.view.coordsAtPos(to);
    setPos({ x: coords.left, y: coords.bottom + 6 });
    setSavedRange({ from, to });

    const initialMode =
      useCursorSettingsStore.getState().foreshadowPickerInitialMode;
    if (initialMode !== null) {
      setMode(initialMode);
    }
  }, [open, editor, setOpen]);

  useEffect(() => {
    if (mode === null) return;
    if (!useForeshadowStore.getState().isLoading) {
      void load(PROJECT_ID);
    }
    setTimeout(() => searchRef.current?.focus(), 0);
  }, [mode, load]);

  useEffect(() => {
    if (showNewForm) {
      setTimeout(() => newTitleRef.current?.focus(), 0);
    }
  }, [showNewForm]);

  const close = () => {
    setOpen(false);
    editor?.commands.focus();
  };

  const applySetupMark = (foreshadowId: string) => {
    if (!editor || !savedRange) return;
    const setupId = crypto.randomUUID();
    editor
      .chain()
      .setTextSelection(savedRange)
      .setMark("foreshadowSetup", { setupId, foreshadowId })
      .run();
    close();
  };

  const applyPayoffMark = (foreshadowId: string) => {
    if (!editor || !savedRange) return;
    editor
      .chain()
      .setTextSelection(savedRange)
      .setMark("foreshadowPayoff", { foreshadowId })
      .run();
    close();
  };

  const handleItemClick = (foreshadowId: string) => {
    if (mode === "setup") applySetupMark(foreshadowId);
    else if (mode === "payoff" || mode === "payoff-unanchored")
      applyPayoffMark(foreshadowId);
  };

  const handleCreateAndLink = async () => {
    if (!newTitle.trim()) return;
    const item = await create({
      projectId: PROJECT_ID,
      title: newTitle.trim(),
      intent: null,
    });
    handleItemClick(item.id);
  };

  // ESC / outside-click
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  if (!open || !pos) return null;

  const popoverWidth = 260;
  const x = Math.min(pos.x, window.innerWidth - popoverWidth - 8);
  const y = Math.min(pos.y, window.innerHeight - 240);

  const filtered = items.filter((item) => {
    if (!item.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (mode === "payoff-unanchored")
      return item.label === "planned" || item.label === "seeded";
    return true;
  });

  return createPortal(
    <div
      ref={rootRef}
      data-foreshadow-popover="mark"
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y, width: popoverWidth }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="flex-1 text-xs font-semibold text-foreground">
          {mode === null
            ? t("foreshadow.popover.heading", "伏線マーク")
            : mode === "setup"
              ? t("foreshadow.popover.setupHeading", "Setup 対象を選択")
              : mode === "payoff-unanchored"
                ? t("foreshadow.popover.designateHeading", "回収先として指名")
                : t("foreshadow.popover.payoffHeading", "Payoff 対象を選択")}
        </span>
        {mode !== null && (
          <button
            type="button"
            onClick={() => {
              setMode(null);
              setSearch("");
              setShowNewForm(false);
            }}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            ←
          </button>
        )}
      </div>

      {/* Mode selector */}
      {mode === null && (
        <div className="flex gap-2 p-2">
          <button
            type="button"
            onClick={() => setMode("setup")}
            className="flex-1 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-500/20 dark:text-blue-400"
          >
            Setup
          </button>
          <button
            type="button"
            onClick={() => setMode("payoff")}
            className="flex-1 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-xs font-medium text-green-600 hover:bg-green-500/20 dark:text-green-400"
          >
            Payoff
          </button>
        </div>
      )}

      {/* Foreshadow picker */}
      {mode !== null && (
        <>
          <div className="border-b border-border px-2 py-1.5">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("foreshadow.popover.searchPlaceholder", "検索…")}
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="max-h-36 overflow-y-auto">
            {isLoading && (
              <p className="px-3 py-2 text-xs text-muted-foreground">…</p>
            )}
            {!isLoading && filtered.length === 0 && !showNewForm && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t("foreshadow.popover.noResults", "見つかりません")}
              </p>
            )}
            {filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleItemClick(item.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
              >
                <span className="flex-1 truncate text-foreground">
                  {item.title}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t(`foreshadow.label.${item.label}`)}
                </span>
              </button>
            ))}
          </div>

          {/* Create new */}
          {!showNewForm ? (
            <button
              type="button"
              onClick={() => setShowNewForm(true)}
              className="flex w-full items-center gap-1 border-t border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
            >
              <span className="text-primary">+</span>
              {t("foreshadow.popover.createNew", "新規伏線を作成して追加")}
            </button>
          ) : (
            <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
              <input
                ref={newTitleRef}
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreateAndLink();
                  }
                  if (e.key === "Escape") setShowNewForm(false);
                }}
                placeholder={t(
                  "foreshadow.create.titlePlaceholder",
                  "タイトル…",
                )}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
              <button
                type="button"
                onClick={() => void handleCreateAndLink()}
                disabled={!newTitle.trim()}
                className="shrink-0 rounded px-2 py-0.5 text-xs bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                {t("common.save", "保存")}
              </button>
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
