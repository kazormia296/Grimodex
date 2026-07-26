import { useEffect } from "react";
import { listen } from "@/lib/tauri";
import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { debugLog } from "@/lib/debugLog";
import {
  useModelDownloadStore,
  type ModelDownloadPayload,
} from "./modelDownloadStore";
import {
  ensureSemanticIndexesOnOpen,
  resetBackIndexGuards,
  resetIndexGuards,
} from "./autoIndex";

const EVENT_NAME = "semantic:model_download_progress";

/**
 * Rust 側 ModelDownloader が emit する進捗 event を購読し `modelDownloadStore`
 * に流し込む。App.tsx に 1 度だけマウントする想定。
 *
 * 成功終端 (done && !error) を受けたら、モデル不在で degrade していた back-index を
 * やり直す (現在プロジェクトの `ensureSemanticIndexesOnOpen` を再呼び出し)。失敗時は
 * model guard を解放し、FTS で続行しつつトーストから明示的に再試行できるようにする。
 */
export function useModelDownloadListener(): void {
  useEffect(() => {
    // The event is broadcast to all BrowserWindows. Only main may restart the
    // back-index pipeline; panel renderers would otherwise duplicate all work.
    if (isPanelWindow()) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<ModelDownloadPayload>(EVENT_NAME, (payload) => {
      if (!payload) return;
      useModelDownloadStore.getState().setProgress(payload);
      if (payload.done && !payload.error) {
        const workspaceKey = useWorkspaceStore.getState().activeWorkspacePath;
        const projectId = useProjectStore.getState().currentProjectId;
        if (workspaceKey && projectId) {
          resetBackIndexGuards(projectId, workspaceKey);
          void ensureSemanticIndexesOnOpen(projectId, workspaceKey);
        }
      } else if (payload.done && payload.error) {
        const workspaceKey = useWorkspaceStore.getState().activeWorkspacePath;
        const projectId = useProjectStore.getState().currentProjectId;
        if (workspaceKey && projectId) {
          resetIndexGuards(projectId, workspaceKey);
        }
        debugLog.warn(
          "semantic-search",
          `model download failed: ${payload.dirName}`,
          payload.error,
        );
      }
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
