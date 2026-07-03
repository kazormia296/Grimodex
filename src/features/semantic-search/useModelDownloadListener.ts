import { useEffect } from "react";
import { listen } from "@/lib/tauri";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { debugLog } from "@/lib/debugLog";
import {
  useModelDownloadStore,
  type ModelDownloadPayload,
} from "./modelDownloadStore";
import { ensureSemanticIndexesOnOpen } from "./autoIndex";

const EVENT_NAME = "semantic:model_download_progress";

/**
 * Rust 側 ModelDownloader が emit する進捗 event を購読し `modelDownloadStore`
 * に流し込む。App.tsx に 1 度だけマウントする想定。
 *
 * 成功終端 (done && !error) を受けたら、モデル不在で degrade していた back-index を
 * やり直す (現在プロジェクトの `ensureSemanticIndexesOnOpen` を再呼び出し)。失敗は
 * warn ログのみ — 呼び出し側は FTS で動くグレースフル契約。
 */
export function useModelDownloadListener(): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<ModelDownloadPayload>(EVENT_NAME, (payload) => {
      if (!payload) return;
      useModelDownloadStore.getState().setProgress(payload);
      if (payload.done && !payload.error) {
        const projectId = getCurrentProjectId();
        if (projectId) void ensureSemanticIndexesOnOpen(projectId);
      } else if (payload.done && payload.error) {
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
