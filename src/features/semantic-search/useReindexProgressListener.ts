import { useEffect } from "react";
import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { listen } from "@/lib/tauri";
import {
  useReindexProgressStore,
  type ReindexProgressPayload,
} from "./reindexProgressStore";

const EVENT_NAME = "semantic:reindex_progress";

/**
 * Rust 側 `semantic_reindex_all` が emit する progress event を購読し、
 * `reindexProgressStore` に流し込む。App.tsx に 1 度だけマウントする想定。
 *
 * Tauri 未起動環境 (browser-mock) では listen は CustomEvent fallback に
 * 落ちるが、本機能は実機でしか走らせないので問題ない。
 */
export function useReindexProgressListener(): void {
  useEffect(() => {
    // Electron/Tauri events are broadcast to every window. Only the main
    // renderer owns semantic coordination and its progress toast.
    if (isPanelWindow()) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<ReindexProgressPayload>(EVENT_NAME, (payload) => {
      // payload が undefined になる経路 (custom event の detail 不在) は
      // 安全に無視する。
      if (!payload) return;
      const progress = useReindexProgressStore.getState();
      const legacy = payload.projectId == null && payload.runId == null;
      const currentWorkspaceKey =
        useWorkspaceStore.getState().activeWorkspacePath;
      const currentWorkspaceOpenRevision =
        useWorkspaceStore.getState().workspaceOpenRevision;
      if (
        useWorkspaceStore.getState().workspaceSwitchInProgress ||
        !useWorkspaceStore.getState().workspaceHydrated
      ) {
        return;
      }
      const currentProjectId = useProjectStore.getState().currentProjectId;
      if (!currentWorkspaceKey || !currentProjectId) return;
      // A legacy payload has neither project nor run identity. Once project or
      // workspace switching exists, accepting it can complete an unrelated new
      // run. Modern Tauri and Electron both emit the discriminators; older
      // backends retain invoke completion but intentionally get no progress UI.
      if (legacy) return;
      if (
        progress.activeWorkspaceKey !== currentWorkspaceKey ||
        progress.activeWorkspaceOpenRevision !== currentWorkspaceOpenRevision ||
        progress.activeProjectId !== currentProjectId ||
        progress.activeRunId == null
      ) {
        return;
      }
      if (payload.projectId != null && payload.projectId !== currentProjectId) {
        return;
      }
      if (payload.runId != null && payload.runId !== progress.activeRunId) {
        return;
      }
      progress.setProgress(payload);
    }).then((stop) => {
      if (cancelled) {
        stop();
      } else {
        unlisten = stop;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
