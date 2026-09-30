import {
  invalidateProjectLoadsForWorkspaceSwitch as invalidateProjectLoads,
  useProjectStore,
} from "@/features/project/projectStore";
import type { ProjectLoadContext } from "@/features/project/projectLoadGate";
import type { ProjectLifecycleTimingObserver } from "./ProjectLifecycleRegistry";
import { getCurrentProjectId } from "./currentProjectAuthority";

/** Invalidate Project reads before replacing the Workspace database binding. */
export function invalidateWorkspaceProjectLoads(): void {
  invalidateProjectLoads();
}

/** Resolve and publish the initial Project for a newly opened Workspace. */
export async function initializeWorkspaceProject(): Promise<string> {
  await useProjectStore.getState().initCurrentProject();
  return getCurrentProjectId();
}

/** Hydrate the replacement Project while the Workspace owns the load lease. */
export function hydrateWorkspaceProject(
  projectId: string,
  context: ProjectLoadContext,
  expectedWorkspacePath: string,
  workspaceOpenRevision: number,
  lifecycleTiming?: ProjectLifecycleTimingObserver,
): Promise<void> {
  return useProjectStore
    .getState()
    .loadProjectWithinLifecycle(projectId, context, {
      skipStrictQuiescence: true,
      expectedWorkspacePath,
      workspaceOpenRevision,
      lifecycleTiming,
    });
}

/** Ensure a tutorial or import-selected Project is active after Workspace open. */
export async function ensureProjectActive(projectId: string): Promise<boolean> {
  const store = useProjectStore.getState();
  if (store.currentProjectId !== projectId) {
    await store.loadProject(projectId);
  }
  return useProjectStore.getState().currentProjectId === projectId;
}
