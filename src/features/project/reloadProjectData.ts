import {
  reloadProjectLifecycle,
  resetChatForProject,
  resetPhaseStateForProject,
  resetUnplacedBeatsForProject,
} from "@/application/project/projectLifecycle";
import type {
  ProjectLifecycleReloadResult,
  ProjectLifecycleTimingObserver,
} from "@/application/project/ProjectLifecycleRegistry";

export {
  resetChatForProject,
  resetPhaseStateForProject,
  resetUnplacedBeatsForProject,
};

/**
 * Project 切替時の reset / critical hydrate / optional hydrate / activation は
 * application 層の lifecycle registry が調停する。Project feature は個々の
 * Store shape や load 順序を知る必要がない。
 */
export async function reloadProjectData(
  projectId: string,
  beforeCommit?: () => boolean | void,
  workspaceOpenRevision?: number,
  afterCommit?: () => void,
  lifecycleTiming?: ProjectLifecycleTimingObserver,
): Promise<ProjectLifecycleReloadResult> {
  return reloadProjectLifecycle(
    { projectId, workspaceOpenRevision },
    { beforeCommit, afterCommit, lifecycleTiming },
  );
}
