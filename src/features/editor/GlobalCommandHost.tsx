import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";

import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";
import {
  isAppCommandAvailable,
  matchesFixedKey,
  runAppCommand,
} from "@/features/commands/appCommandRegistry";
import {
  registerCommandContext,
  type CommandContext,
} from "@/features/commands/commandContext";
import {
  PANEL_COMMANDS,
  getMergedBindings,
  matchesBinding,
} from "@/features/settings/keybindings";
import { handleEditorTabSwitchKeydown } from "@/features/editor/tabSwitchKeybinding";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import i18next from "@/lib/i18n";
import { isMac } from "@/lib/platform";

interface GlobalCommandHostProps {
  phoneWorkspace: boolean;
  runtimeCapabilities: RuntimeCapabilities;
  onToggleExport: () => void;
  onOpenSettings: () => void;
}

/**
 * 全体に効くキーの host。どのキーがどのコマンドかを決め（照合の優先順、固定キー、
 * defaultPrevented、phone で preventDefault するか）、動作は registry の run に任せる。
 */
export function GlobalCommandHost({
  phoneWorkspace,
  runtimeCapabilities,
  onToggleExport,
  onOpenSettings,
}: GlobalCommandHostProps) {
  const genericProjectTransfer = runtimeCapabilities.genericProjectTransfer;
  const ctx = useMemo<CommandContext>(
    () => ({
      phoneWorkspace,
      runtimeCapabilities: { genericProjectTransfer },
      onToggleExport,
      onOpenSettings,
    }),
    [phoneWorkspace, genericProjectTransfer, onToggleExport, onOpenSettings],
  );

  // キー以外の呼び出し元（agent 等）が同じ文脈で run できるように登録する。
  useEffect(() => registerCommandContext(ctx), [ctx]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const merged = getMergedBindings();
      const mac = isMac();

      // オーバーレイの開閉。layout を変えない（揮発の状態だけ）ので、
      // 静止待ちの guard より前に処理する。phone 幅と空の overlay では何もしない。
      const overlayCommandId = matchesBinding(
        event,
        merged.toggleLeftOverlay ?? "",
        mac,
      )
        ? "toggleLeftOverlay"
        : matchesBinding(event, merged.toggleRightOverlay ?? "", mac)
          ? "toggleRightOverlay"
          : null;
      if (overlayCommandId !== null) {
        if (!isAppCommandAvailable(overlayCommandId, ctx)) return;
        event.preventDefault();
        runAppCommand(overlayCommandId, ctx);
        return;
      }

      if (!canScheduleQuiescenceMutation()) return;
      if (
        isAppCommandAvailable("toggleExport", ctx) &&
        matchesFixedKey("toggleExport", event)
      ) {
        event.preventDefault();
        runAppCommand("toggleExport", ctx);
        return;
      }

      if (matchesFixedKey("searchWorkspace", event)) {
        if (event.defaultPrevented) return;
        event.preventDefault();
        runAppCommand("searchWorkspace", ctx);
        return;
      }

      for (const panelCommand of PANEL_COMMANDS) {
        if (!matchesBinding(event, merged[panelCommand.id] ?? "", mac)) {
          continue;
        }
        event.preventDefault();
        runAppCommand(panelCommand.id, ctx);
        return;
      }

      if (matchesBinding(event, merged.openSettings ?? "", mac)) {
        event.preventDefault();
        runAppCommand("openSettings", ctx);
        return;
      }

      const splitCommandId = matchesBinding(
        event,
        merged.splitVertical ?? "",
        mac,
      )
        ? "splitVertical"
        : matchesBinding(event, merged.splitHorizontal ?? "", mac)
          ? "splitHorizontal"
          : null;
      if (!splitCommandId) return;
      // phone でも consume する（run 側で phone は何もしない）。
      event.preventDefault();
      runAppCommand(splitCommandId, ctx);
    },
    [ctx],
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
