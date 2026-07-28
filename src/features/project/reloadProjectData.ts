import {
  projectLifecycleRegistry,
  resetChatForProject,
  resetPhaseStateForProject,
  resetUnplacedBeatsForProject,
} from "@/application/project/defaultProjectLifecycle";
import type { ProjectLifecycleReloadResult } from "@/application/project/ProjectLifecycleRegistry";

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
): Promise<ProjectLifecycleReloadResult> {
  return projectLifecycleRegistry.reload(
    { projectId, workspaceOpenRevision },
    { beforeCommit, afterCommit },
  );
}
