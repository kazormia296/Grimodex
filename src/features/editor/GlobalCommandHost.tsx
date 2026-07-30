import { useCallback, useEffect } from "react";
import { toast } from "sonner";

import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";
import { useResultsPanelStore } from "@/features/commandCenter";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import {
  PANEL_COMMANDS,
  getMergedBindings,
  matchesBinding,
} from "@/features/settings/keybindings";
import { useTabStore } from "@/features/editor/tabStore";
import { handleEditorTabSwitchKeydown } from "@/features/editor/tabSwitchKeybinding";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import i18next from "@/lib/i18n";
import { isMac, matchesMod } from "@/lib/platform";

interface GlobalCommandHostProps {
  phoneWorkspace: boolean;
  runtimeCapabilities: RuntimeCapabilities;
  onToggleExport: () => void;
  onOpenSettings: () => void;
}

export function GlobalCommandHost({
  phoneWorkspace,
  runtimeCapabilities,
  onToggleExport,
  onOpenSettings,
}: GlobalCommandHostProps) {
  const togglePanel = useLayoutStore((state) => state.togglePanel);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!canScheduleQuiescenceMutation()) return;
      if (
        runtimeCapabilities.genericProjectTransfer &&
        matchesMod(event) &&
        event.shiftKey &&
        event.key.toLowerCase() === "e"
      ) {
        event.preventDefault();
        onToggleExport();
        return;
      }

      if (
        matchesMod(event) &&
        event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (phoneWorkspace) {
          useCompactNavigationStore.getState().openSurface("search");
          requestAnimationFrame(() => {
            useResultsPanelStore.getState().requestFocus();
          });
          return;
        }
        useLayoutStore.getState().showPanel("command-center-results");
        useResultsPanelStore.getState().requestFocus();
        return;
      }

      const merged = getMergedBindings();
      const mac = isMac();
      for (const panelCommand of PANEL_COMMANDS) {
        if (!matchesBinding(event, merged[panelCommand.id] ?? "", mac)) {
          continue;
        }
        event.preventDefault();
        if (phoneWorkspace) {
          const surface =
            panelCommand.panel === "editor"
              ? "editor"
              : panelCommand.panel === "scenes"
                ? "scenes"
                : panelCommand.panel === "codex" ||
                    panelCommand.panel === "codex-quick"
                  ? "codex"
                  : panelCommand.panel === "chat" ||
                      panelCommand.panel === "chat-history"
                    ? "ai"
                    : "more";
          useCompactNavigationStore.getState().openSurface(surface);
          return;
        }
        togglePanel(panelCommand.panel);
        if (panelCommand.panel === "codex-quick") {
          requestAnimationFrame(() => {
            useLayoutStore.getState().showPanel("codex-quick");
          });
        }
        return;
      }

      if (matchesBinding(event, merged.openSettings ?? "", mac)) {
        event.preventDefault();
        onOpenSettings();
        return;
      }

      const splitDirection = matchesBinding(
        event,
        merged.splitVertical ?? "",
        mac,
      )
        ? "right"
        : matchesBinding(event, merged.splitHorizontal ?? "", mac)
          ? "below"
          : null;
      if (!splitDirection) return;
      event.preventDefault();
      if (phoneWorkspace) return;
      const tabs = useTabStore.getState();
      if (tabs.activeTabId) {
        tabs.openInSecondaryGroupDirectional(tabs.activeTabId, splitDirection);
      } else {
        tabs.createEmptySecondaryGroup(splitDirection);
      }
    },
    [
      onOpenSettings,
      onToggleExport,
      phoneWorkspace,
      runtimeCapabilities.genericProjectTransfer,
      togglePanel,
    ],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    function onUndoRedo(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement) {
        const tag = activeElement.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (activeElement.isContentEditable) return;
        if (activeElement.closest('.ProseMirror, [contenteditable="true"]')) {
          return;
        }
      }

      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        void useGlobalHistoryStore
          .getState()
          .undo()
          .catch(() => {
            toast.error(
              i18next.t("history.undoError", "元に戻す操作に失敗しました"),
            );
          });
        return;
      }
      if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        void useGlobalHistoryStore
          .getState()
          .redo()
          .catch(() => {
            toast.error(
              i18next.t("history.redoError", "やり直し操作に失敗しました"),
            );
          });
      }
    }

    window.addEventListener("keydown", onUndoRedo);
    return () => window.removeEventListener("keydown", onUndoRedo);
  }, []);

  useEffect(() => {
    function onTabSwitch(event: KeyboardEvent) {
      if (!canScheduleQuiescenceMutation()) return;
      handleEditorTabSwitchKeydown(event, phoneWorkspace);
    }

    window.addEventListener("keydown", onTabSwitch);
    return () => window.removeEventListener("keydown", onTabSwitch);
  }, [phoneWorkspace]);

  return null;
}
