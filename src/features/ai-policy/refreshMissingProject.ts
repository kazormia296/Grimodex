import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { debugLog } from "@/lib/debugLog";

/** 読み直しを起こした（workspace, Project）の組。失敗しても繰り返さない。 */
const requested = new Set<string>();

/**
 * 現在の作品が一覧に無いとき、一覧の読み直しを後ろで 1 回だけ起こす（A4 の案 b）。
 * 作成や取込みの直後に読み直しが失敗しても、次の操作から直るようにする。
 * 書き込みを止める判定は変えない。workspace の切替中と、現在の作品が未定の
 * ときは起こさない。
 */
export function refreshProjectListOnceIfCurrentMissing(): void {
  const key = missingCurrentProjectKey();
  if (key === null || requested.has(key)) return;
  // 表示を組み立てる経路からも呼ばれるので、store の更新は後回しにする。
  queueMicrotask(() => {
    if (requested.has(key) || missingCurrentProjectKey() !== key) return;
    requested.add(key);
    void useProjectStore
      .getState()
      .refreshProjects()
      .then(() => {
        // refreshProjects は失敗を投げないので、結果で確かめて記録する。
        if (missingCurrentProjectKey() === key) {
          debugLog.warn(
            "aiPolicy",
            "current Project is still missing after refreshing the list",
          );
        }
      });
  });
}

function missingCurrentProjectKey(): string | null {
  const { currentProjectId, projects } = useProjectStore.getState();
  const { activeWorkspaceId, activeWorkspacePath, workspaceSwitchInProgress } =
    useWorkspaceStore.getState();
  const workspace = activeWorkspaceId ?? activeWorkspacePath;
  if (
    !currentProjectId ||
    !workspace ||
    workspaceSwitchInProgress ||
    projects.some((project) => project.id === currentProjectId)
  ) {
    return null;
  }
  return JSON.stringify([workspace, currentProjectId]);
}
