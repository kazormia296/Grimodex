import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { useSettingsStore } from "./settingsStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useBackgroundStudioStore } from "@/features/editor/background/backgroundStudioStore";
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
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  initialCategory?: SettingsCategory;
  phoneWorkspace?: boolean;
}

function CategoryContent({
  category,
  onOpenBackgroundStudio,
}: {
  category: SettingsCategory;
  onOpenBackgroundStudio: () => void;
}) {
  switch (category) {
    case "project":
      return <ProjectCategory />;
    case "ai":
      return <AiCategory />;
    case "editor":
      return <EditorCategory />;
    case "display":
      return (
        <DisplayCategory onOpenBackgroundStudio={onOpenBackgroundStudio} />
      );
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
  phoneWorkspace = false,
}: SettingsDialogProps) {
  const { t } = useTranslation();
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

  const handleOpenBackgroundStudio = useCallback(async () => {
    await handleClose();
    useBackgroundStudioStore.getState().setOpen(true);
  }, [handleClose]);

  return (
    <AnimatedOverlay
      open={open}
      onClose={handleClose}
      testId="settings-dialog"
      className={cn(
        "flex min-h-0 min-w-0 overflow-hidden border border-border bg-background shadow-xl",
        phoneWorkspace
          ? "h-[var(--visual-viewport-height,100dvh)] w-screen max-h-none max-w-none resize-none rounded-none border-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          : "h-[640px] w-[780px] min-h-[400px] min-w-[480px] max-h-[90vh] max-w-[90vw] resize rounded-lg",
      )}
    >
      {/* Header */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-foreground">
            {t("app.settingsLabel")}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label={t("common.close")}
            className="flex min-h-11 min-w-11 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body: nav + content */}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 overflow-hidden",
            phoneWorkspace && "flex-col",
          )}
        >
          <CategoryNav
            active={activeCategory}
            onChange={setActiveCategory}
            phoneWorkspace={phoneWorkspace}
          />
          <div
            data-testid="settings-content"
            className="@container min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
          >
            <CategoryContent
              category={activeCategory}
              onOpenBackgroundStudio={() => {
                void handleOpenBackgroundStudio();
              }}
            />
          </div>
        </div>
      </div>
    </AnimatedOverlay>
  );
}
