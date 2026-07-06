import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { useSettingsStore } from "./settingsStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { CategoryNav } from "./CategoryNav";
import type { SettingsCategory } from "./types";
import { ProjectCategory } from "./categories/ProjectCategory";
import { AiCategory } from "./categories/AiCategory";
import { EditorCategory } from "./categories/EditorCategory";
import { DisplayCategory } from "./categories/DisplayCategory";
import { KeysCategory } from "./categories/KeysCategory";
import { DataCategory } from "./categories/DataCategory";
import { CodexCategory } from "./categories/CodexCategory";
import { MapCategory } from "./categories/MapCategory";
import { LinterCategory } from "./categories/LinterCategory";
import { UsageCategory } from "./categories/UsageCategory";
import { LicenseCategory } from "./categories/LicenseCategory";
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
    case "map":
      return <MapCategory />;
    case "linter":
      return <LinterCategory />;
    case "usage":
      return <UsageCategory />;
    case "license":
      return <LicenseCategory />;
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
    // 設定から初期化される runtime ストアをすべて再同期する
    // （本文レイヤートグルの写し先: cursor / attribution / annotation / codex）。
    useCursorSettingsStore.getState().initFromSettings();
    useAttributionStore.getState().initFromSettings();
    useAnnotationStore.getState().initFromSettings();
    useCodexHighlightStore.getState().initFromSettings();
    // initFromSettings はパネル連動 (Auto) 中の非永続な追従状態を手動基準値へ
    // 巻き戻す。パネル可視状態は変わっておらず follow effect が自発しないため、
    // nonce を bump して再同期させる（Auto OFF なら effect 側の guard で無視）。
    useCursorSettingsStore.getState().requestLayerAutoFollowSync();
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
