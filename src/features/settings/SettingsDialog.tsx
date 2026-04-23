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
import { LinterCategory } from "./categories/LinterCategory";
import { AboutCategory } from "./categories/AboutCategory";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";

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
    case "linter":
      return <LinterCategory />;
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
    useCursorSettingsStore.getState().initFromSettings();
    onClose();
  }, [flushPending, onClose]);

  return (
    <AnimatedOverlay
      open={open}
      onClose={handleClose}
      className="flex h-[600px] w-[780px] min-h-[400px] min-w-[480px] max-h-[90vh] max-w-[90vw] resize overflow-hidden rounded-lg border border-border bg-background shadow-xl"
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
    </AnimatedOverlay>
  );
}
