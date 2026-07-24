import { useCallback, useEffect, useState } from "react";
import { Bot, FolderOpen, Info, Monitor, Type, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useBackgroundStudioStore } from "@/features/editor/background/backgroundStudioStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { AboutCategory } from "@/features/settings/categories/AboutCategory";
import { DisplayCategory } from "@/features/settings/categories/DisplayCategory";
import { EditorCategory } from "@/features/settings/categories/EditorCategory";
import { ProjectCategory } from "@/features/settings/categories/ProjectCategory";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { SettingsCategory } from "@/features/settings/types";
import { cn } from "@/lib/utils";
import { WebEditorAiCategory } from "./WebEditorAiCategory";

type WebSettingsCategory = "project" | "ai" | "editor" | "display" | "about";

export const WEB_EDITOR_SETTINGS_CATEGORIES = [
  {
    id: "project",
    labelKey: "hostedEditor.settings.categories.project",
    Icon: FolderOpen,
  },
  { id: "ai", labelKey: "hostedEditor.settings.categories.ai", Icon: Bot },
  {
    id: "editor",
    labelKey: "hostedEditor.settings.categories.editor",
    Icon: Type,
  },
  {
    id: "display",
    labelKey: "hostedEditor.settings.categories.display",
    Icon: Monitor,
  },
  {
    id: "about",
    labelKey: "hostedEditor.settings.categories.about",
    Icon: Info,
  },
] as const;

function initialWebCategory(category: SettingsCategory): WebSettingsCategory {
  return WEB_EDITOR_SETTINGS_CATEGORIES.some(
    (candidate) => candidate.id === category,
  )
    ? (category as WebSettingsCategory)
    : "project";
}

function CategoryContent({
  category,
  onOpenBackgroundStudio,
}: {
  category: WebSettingsCategory;
  onOpenBackgroundStudio: () => void;
}) {
  switch (category) {
    case "project":
      return <ProjectCategory />;
    case "ai":
      return <WebEditorAiCategory />;
    case "editor":
      return <EditorCategory />;
    case "display":
      return (
        <DisplayCategory onOpenBackgroundStudio={onOpenBackgroundStudio} />
      );
    case "about":
      return <AboutCategory />;
  }
}

export function SettingsDialog({
  open,
  onClose,
  initialCategory = "project",
  phoneWorkspace = false,
}: {
  open: boolean;
  onClose: () => void;
  initialCategory?: SettingsCategory;
  phoneWorkspace?: boolean;
}) {
  const { t } = useTranslation();
  const [activeCategory, setActiveCategory] = useState<WebSettingsCategory>(
    initialWebCategory(initialCategory),
  );
  const { loadAll, flushPending } = useSettingsStore();

  useEffect(() => {
    if (!open) return;
    loadAll();
    setActiveCategory(initialWebCategory(initialCategory));
  }, [initialCategory, loadAll, open]);

  const handleClose = useCallback(async () => {
    await flushPending();
    useCursorSettingsStore.getState().initFromSettings();
    useAttributionStore.getState().initFromSettings();
    useAnnotationStore.getState().initFromSettings();
    useCodexHighlightStore.getState().initFromSettings();
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
          : "h-[600px] w-[780px] min-h-[400px] min-w-[480px] max-h-[90vh] max-w-[90vw] resize rounded-lg",
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-foreground">
            {t("app.settingsLabel")}
          </h2>
          <button
            type="button"
            onClick={() => void handleClose()}
            aria-label={t("common.close")}
            className="flex min-h-11 min-w-11 items-center justify-center rounded text-muted-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 overflow-hidden",
            phoneWorkspace && "flex-col",
          )}
        >
          <nav
            aria-label={t("app.settingsLabel")}
            data-phone-category-nav={phoneWorkspace ? "true" : undefined}
            className={cn(
              "flex min-w-0 shrink-0 gap-0.5 border-border p-2",
              phoneWorkspace
                ? "w-full overscroll-x-contain overflow-x-auto border-b"
                : "w-[120px] flex-col border-r",
            )}
          >
            {WEB_EDITOR_SETTINGS_CATEGORIES.map(({ id, labelKey, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveCategory(id)}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                  phoneWorkspace && "shrink-0 whitespace-nowrap",
                  activeCategory === id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {t(labelKey)}
              </button>
            ))}
          </nav>
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
