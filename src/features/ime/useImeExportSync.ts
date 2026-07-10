import { useEffect, useRef } from "react";
import { useProjectStore } from "@/features/project/projectStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import { clearImeExports, refreshImeExport, setActiveImeProject } from "./api";
import { isJapaneseProjectLanguage } from "./language";

interface ActiveImeProject {
  projectId: string;
  japanese: boolean;
}

/**
 * 開いた Project とフォーカス中の窓を state.json へ同期する。
 * DOM focus/pagehide は Tauri/Electron 共通なので shell 別ブリッジを増やさない。
 */
export function useImeExportSync(): void {
  const projectId = useProjectStore((s) => s.currentProjectId);
  const projectLanguage = useSettingsStore((s) => s.projectLanguage);
  const integrationMode = useSettingsStore((s) =>
    s.get("ime.integrationMode", "auto"),
  );
  const excludeHidden = useSettingsStore((s) =>
    s.getBoolean("ime.excludeHidden", false),
  );
  const includeProfile = useSettingsStore((s) =>
    s.getBoolean("ime.includeProfile", true),
  );
  const activeRef = useRef<ActiveImeProject | null>(null);

  activeRef.current = projectId
    ? {
        projectId,
        japanese: isJapaneseProjectLanguage(projectLanguage),
      }
    : null;

  // Project open/switch/language change: refresh the snapshot first, then point state.json at it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (integrationMode === "off") {
        await clearImeExports();
        if (!cancelled) await setActiveImeProject(null);
        return;
      }
      if (!projectId) {
        await setActiveImeProject(null);
        return;
      }
      // non-ja refresh is intentional: native removes a snapshot left from a
      // previous Japanese language setting before we clear the active pointer.
      await refreshImeExport(projectId);
      if (!cancelled) {
        await setActiveImeProject(
          isJapaneseProjectLanguage(projectLanguage) ? projectId : null,
        );
      }
    })().catch(() => {
      // fail-open: native export must never block project loading.
    });
    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    projectLanguage,
    integrationMode,
    excludeHidden,
    includeProfile,
  ]);

  useEffect(() => {
    const activateFocusedProject = () => {
      const active = activeRef.current;
      if (!active?.japanese) {
        void setActiveImeProject(null).catch(() => {});
        return;
      }
      // Refresh on focus as well as initial open. This is the detection point
      // for an auto-mode consumer installed/launched after Grimodex started.
      void refreshImeExport(active.projectId)
        .then(() => setActiveImeProject(active.projectId))
        .catch(() => {});
    };
    const clearOnClose = () => {
      // A floating panel shares the main window's Project. Closing it must not
      // clear the active pointer owned by the still-open main window.
      if (isPanelWindow()) return;
      void setActiveImeProject(null).catch(() => {});
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") activateFocusedProject();
    };

    window.addEventListener("focus", activateFocusedProject);
    window.addEventListener("pagehide", clearOnClose);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", activateFocusedProject);
      window.removeEventListener("pagehide", clearOnClose);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearOnClose();
    };
  }, []);
}
