import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useBackgroundStudioStore } from "./background/backgroundStudioStore";

const ZEN_ENTRY_HINT_MSEC = 2_000;

/**
 * Session-only Zen lifecycle: hierarchical Escape dismissal plus a short,
 * non-interactive entry hint. The editor itself stays mounted elsewhere.
 */
export function ZenModeController() {
  const { t } = useTranslation();
  const zenMode = useCursorSettingsStore((state) => state.zenMode);
  const setZenMode = useCursorSettingsStore((state) => state.setZenMode);
  const activeSceneId = useTreeStore((state) => state.activeSceneId);
  const activeTitle = useTreeStore(
    (state) =>
      state.nodes.find((node) => node.id === activeSceneId)?.title ?? "",
  );
  const [hintVisible, setHintVisible] = useState(false);

  useEffect(() => {
    if (!zenMode) {
      setHintVisible(false);
      return undefined;
    }
    setHintVisible(true);
    const timer = window.setTimeout(
      () => setHintVisible(false),
      ZEN_ENTRY_HINT_MSEC,
    );
    return () => window.clearTimeout(timer);
  }, [zenMode]);

  useEffect(() => {
    if (!zenMode) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      event.preventDefault();
      if (useBackgroundStudioStore.getState().open) {
        useBackgroundStudioStore.getState().setOpen(false);
        return;
      }
      setZenMode(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setZenMode, zenMode]);

  if (!zenMode || !hintVisible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-full border border-border/60 bg-popover/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur"
    >
      {activeTitle
        ? t("editor.zen.entryHint", { title: activeTitle })
        : t("editor.zen.entryHintNoTitle")}
    </div>
  );
}
