import { useEffect, useMemo, useRef } from "react";
import { useProjectStore } from "@/features/project/projectStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import { listen } from "@/lib/tauri";
import { clearImeExports, refreshImeExport, setActiveImeProject } from "./api";
import { isJapaneseProjectLanguage } from "./language";
import { cancelScheduledImeExports } from "./scheduler";
import {
  getCurrentImeWorkspaceIdentity,
  setCurrentImeWorkspaceIdentity,
  type ImeWorkspaceIdentity,
} from "./workspaceScope";

interface ActiveImeProject extends ImeWorkspaceIdentity {
  projectId: string;
  japanese: boolean;
}

function sameActiveProject(
  left: ActiveImeProject | null,
  right: ActiveImeProject,
): boolean {
  return (
    left?.projectId === right.projectId &&
    left.path === right.path &&
    left.openRevision === right.openRevision
  );
}

function workspaceIdentityOf(active: ActiveImeProject): ImeWorkspaceIdentity {
  return { path: active.path, openRevision: active.openRevision };
}

/**
 * 開いた Project とフォーカス中の窓を state.json へ同期する。
 * IME pointer は main renderer だけが所有し、floating panel は辞書更新の
 * scheduler scopeだけを持つ。
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
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const workspaceOpenRevision = useWorkspaceStore(
    (s) => s.workspaceOpenRevision,
  );
  const workspaceSwitchInProgress = useWorkspaceStore(
    (s) => s.workspaceSwitchInProgress,
  );
  const workspaceHydrated = useWorkspaceStore((s) => s.workspaceHydrated);
  const panel = isPanelWindow();
  const activeRef = useRef<ActiveImeProject | null>(null);
  const operationSequenceRef = useRef(0);
  const clearBarrierRef = useRef<Promise<void>>(Promise.resolve());

  const workspaceIdentity = useMemo<ImeWorkspaceIdentity | null>(
    () =>
      workspacePath && workspaceHydrated && !workspaceSwitchInProgress
        ? { path: workspacePath, openRevision: workspaceOpenRevision }
        : null,
    [
      workspacePath,
      workspaceHydrated,
      workspaceSwitchInProgress,
      workspaceOpenRevision,
    ],
  );
  activeRef.current =
    !panel && workspaceIdentity && projectId
      ? {
          ...workspaceIdentity,
          projectId,
          japanese: isJapaneseProjectLanguage(projectLanguage),
        }
      : null;

  // Each renderer has its own scheduler module, so both main and panel publish
  // their local binding. Pointer ownership below remains main-only.
  useEffect(() => {
    // Keep the old database identity valid while strict quiescence drains
    // admitted turns. Workspace open clears it explicitly after that drain.
    if (workspaceSwitchInProgress) return;
    setCurrentImeWorkspaceIdentity(workspaceIdentity);
  }, [workspaceIdentity, workspaceSwitchInProgress]);

  // Project open/switch/language change: deactivate first. If refresh fails,
  // the previous workspace/project can never remain active by accident.
  useEffect(() => {
    const sequence = ++operationSequenceRef.current;
    cancelScheduledImeExports();
    if (panel) return;
    let disposed = false;
    const isCurrent = (active: ActiveImeProject): boolean =>
      !disposed &&
      operationSequenceRef.current === sequence &&
      sameActiveProject(activeRef.current, active);
    const isCurrentSequence = (): boolean =>
      !disposed && operationSequenceRef.current === sequence;

    const run = async () => {
      await setActiveImeProject(null);
      if (!isCurrentSequence()) return;
      if (integrationMode === "off") {
        // Publish synchronously with invoke creation. A newer on-mode effect
        // cannot observe "no barrier" after this clear was already issued.
        const clearOperation = clearImeExports();
        clearBarrierRef.current = clearOperation.catch(() => {});
        await clearOperation;
        return;
      }
      if (!workspaceIdentity || !projectId) {
        return;
      }
      await clearBarrierRef.current;
      if (!isCurrentSequence()) return;
      const active: ActiveImeProject = {
        ...workspaceIdentity,
        projectId,
        japanese: isJapaneseProjectLanguage(projectLanguage),
      };
      await refreshImeExport(projectId, workspaceIdentity);
      if (!isCurrent(active)) return;
      await setActiveImeProject(
        active.japanese ? active.projectId : null,
        active.japanese ? workspaceIdentity : undefined,
      );
    };

    void run().catch(() => {
      if (disposed || operationSequenceRef.current !== sequence) return;
      void setActiveImeProject(null).catch(() => {});
    });
    return () => {
      disposed = true;
      operationSequenceRef.current += 1;
      cancelScheduledImeExports();
    };
  }, [
    panel,
    projectId,
    projectLanguage,
    integrationMode,
    excludeHidden,
    includeProfile,
    workspaceIdentity,
  ]);

  useEffect(() => {
    if (panel) return;
    const activateFocusedProject = () => {
      const active = activeRef.current;
      const sequence = ++operationSequenceRef.current;
      if (!active) {
        void setActiveImeProject(null).catch(() => {});
        return;
      }
      void (async () => {
        const identity = workspaceIdentityOf(active);
        await setActiveImeProject(null);
        await clearBarrierRef.current;
        if (operationSequenceRef.current !== sequence) return;
        await refreshImeExport(active.projectId, identity);
        if (
          operationSequenceRef.current === sequence &&
          sameActiveProject(activeRef.current, active)
        ) {
          await setActiveImeProject(active.projectId, identity);
        }
      })().catch(() => {
        if (operationSequenceRef.current === sequence) {
          void setActiveImeProject(null).catch(() => {});
        }
      });
    };
    const clearOnClose = () => {
      operationSequenceRef.current += 1;
      cancelScheduledImeExports();
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
  }, [panel]);

  // Native open/restore is broadcast to every window. The main renderer uses
  // its explicit store revision lifecycle; a panel has no such remote update,
  // so invalidate its scheduler scope and pending jobs on the event.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ path: string; reason?: string }>(
      "workspace:opened",
      (payload) => {
        const currentIdentity = getCurrentImeWorkspaceIdentity();
        const invalidated =
          payload?.reason === "restore" ||
          currentIdentity?.path !== payload?.path;
        if (invalidated) {
          cancelScheduledImeExports();
          setCurrentImeWorkspaceIdentity(null);
        }
        if (panel) {
          if (
            invalidated &&
            workspacePath !== null &&
            !workspaceSwitchInProgress
          ) {
            // A floating panel has no cross-window store rehydration path. Close
            // stale UI rather than let it issue commands against the new shared
            // backend workspace; reopening creates a correctly hydrated panel.
            window.close();
          }
          return;
        }
        // Opening a panel reuses the shared Backend and performs a same-path
        // native reopen. The swap barrier deliberately deactivates state.json;
        // the main renderer must restore its current pointer afterward.
        if (
          payload?.reason !== "restore" &&
          payload?.path === workspacePath &&
          !workspaceSwitchInProgress &&
          workspaceHydrated
        ) {
          const active = activeRef.current;
          if (!active) return;
          const identity = workspaceIdentityOf(active);
          const sequence = ++operationSequenceRef.current;
          void clearBarrierRef.current
            .then(() => {
              if (operationSequenceRef.current !== sequence) return;
              return refreshImeExport(active.projectId, identity);
            })
            .then(() => {
              if (
                operationSequenceRef.current === sequence &&
                sameActiveProject(activeRef.current, active)
              ) {
                return setActiveImeProject(active.projectId, identity);
              }
            })
            .catch(() => {
              if (operationSequenceRef.current === sequence) {
                void setActiveImeProject(null).catch(() => {});
              }
            });
        }
      },
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [panel, workspacePath, workspaceSwitchInProgress, workspaceHydrated]);
}
