import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { useSettingsStore } from "./settingsStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { CategoryNav } from "./CategoryNav";
import type { SettingsCategory } from "./types";
import { ProjectCategory } from "./categories/ProjectCategory";
import { AiCategory } from "./categories/AiCategory";
import { EditorCategory } from "./categories/EditorCategory";
import { DisplayCategory } from "./categories/DisplayCategory";
import { KeysCategory } from "./categories/KeysCategory";
import { DataCategory } from "./categories/DataCategory";
import { CodexCategory } from "./categories/CodexCategory";
import { AboutCategory } from "./categories/AboutCategory";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  initialCategory?: SettingsCategory;
}

function CategoryContent({ category }: { category: SettingsCategory }) {
  switch (category) {
    case "project":
      return <ProjectCategory />;
    case "ai":
      return <AiCategory />;
    case "editor":
      return <EditorCategory />;
    case "display":
      return <DisplayCategory />;
    case "keys":
      return <KeysCategory />;
    case "data":
      return <DataCategory />;
    case "codex":
      return <CodexCategory />;
    case "about":
      return <AboutCategory />;
  }
}

export function SettingsDialog({
  open,
  onClose,
  initialCategory = "project",
}: SettingsDialogProps) {
  const [activeCategory, setActiveCategory] =
    useState<SettingsCategory>(initialCategory);
  const { loadAll, flushPending } = useSettingsStore();

  useEffect(() => {
    if (open) {
      loadAll();
      setActiveCategory(initialCategory);
    }
  }, [open, initialCategory, loadAll]);

  const handleClose = useCallback(async () => {
    await flushPending();
    // Sync runtime stores that mirror persisted settings
    useCursorSettingsStore.getState().initFromSettings();
    onClose();
  }, [flushPending, onClose]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, handleClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        className="flex h-[520px] w-[680px] min-h-[400px] min-w-[480px] max-h-[90vh] max-w-[90vw] resize overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-2">
            <h2 className="text-sm font-semibold text-foreground">Settings</h2>
            <button
              type="button"
              onClick={handleClose}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body: nav + content */}
          <div className="flex flex-1 overflow-hidden">
            <CategoryNav active={activeCategory} onChange={setActiveCategory} />
            <div className="flex-1 overflow-y-auto">
              <CategoryContent category={activeCategory} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
