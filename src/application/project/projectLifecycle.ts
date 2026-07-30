import type {
  ProjectLifecycleContext,
  ProjectLifecycleRegistry,
  ProjectLifecycleReloadResult,
} from "./ProjectLifecycleRegistry";

export interface ProjectLifecycleResetPorts {
  resetChatForProject: (projectId: string) => void;
  resetPhaseStateForProject: () => void;
  resetUnplacedBeatsForProject: () => void;
}

let registeredProjectLifecycle: ProjectLifecycleRegistry | null = null;
let registeredProjectLifecycleResets: ProjectLifecycleResetPorts | null = null;

/** Install the concrete project participants from the renderer composition root. */
export function registerProjectLifecycle(
  registry: ProjectLifecycleRegistry,
  resets: ProjectLifecycleResetPorts,
): void {
  registeredProjectLifecycle = registry;
  registeredProjectLifecycleResets = resets;
}

/** Run the registered project lifecycle without exposing concrete stores. */
export function reloadProjectLifecycle(
  context: ProjectLifecycleContext,
  options?: Parameters<ProjectLifecycleRegistry["reload"]>[1],
): Promise<ProjectLifecycleReloadResult> {
  if (!registeredProjectLifecycle) {
    throw new Error("Project lifecycle dependencies are not registered");
  }
  return registeredProjectLifecycle.reload(context, options);
}

function projectLifecycleResets(): ProjectLifecycleResetPorts {
  if (!registeredProjectLifecycleResets) {
    throw new Error("Project lifecycle reset dependencies are not registered");
  }
  return registeredProjectLifecycleResets;
}

export function resetChatForProject(projectId: string): void {
  projectLifecycleResets().resetChatForProject(projectId);
}

export function resetPhaseStateForProject(): void {
  projectLifecycleResets().resetPhaseStateForProject();
}

export function resetUnplacedBeatsForProject(): void {
  projectLifecycleResets().resetUnplacedBeatsForProject();
}
