import { withProjectLoad } from "./projectLoadGate";
import {
  projectLifecycleRegistry,
  resetChatForProject,
  resetPhaseStateForProject,
} from "@/application/project/defaultProjectLifecycle";

export { resetChatForProject, resetPhaseStateForProject };

/**
 * Project 切替時の reset / critical hydrate / optional hydrate / activation は
 * application 層の lifecycle registry が調停する。Project feature は個々の
 * Store shape や load 順序を知る必要がない。
 */
export async function reloadProjectData(projectId: string): Promise<void> {
  return withProjectLoad(() => projectLifecycleRegistry.reload({ projectId }));
}
