import type { ChatContextPlanResult } from "./chatContextPlanner";
import type {
  NonSceneContextPlanResult,
  NonSceneContextPlannerDeps,
} from "./nonSceneContextPlanner";
import type { ContextPlannerDeps } from "./contextPlannerDeps";
import type {
  NonSceneTurnContextRequest,
  SceneTurnContextRequest,
  TurnContextRequest,
} from "./turnContextRequest";

export {
  createNonSceneTurnContextRequest,
  createSceneTurnContextRequest,
} from "./turnContextRequest";
export type {
  ContextPlanningPurpose,
  ContextScopeTarget,
  CreateNonSceneTurnContextRequestInput,
  CreateSceneTurnContextRequestInput,
  NonSceneTurnContextRequest,
  SceneTurnContextRequest,
  TurnContextActiveTab,
  TurnContextBudget,
  TurnContextMapSelection,
  TurnContextRequest,
  TurnContextSettings,
} from "./turnContextRequest";

export type PreparedTurnResult =
  | ChatContextPlanResult
  | NonSceneContextPlanResult;

export interface PrepareTurnDependencies {
  planScene: (
    request: SceneTurnContextRequest,
    deps: ContextPlannerDeps,
  ) => Promise<ChatContextPlanResult>;
  planNonScene: (
    request: NonSceneTurnContextRequest,
    deps: NonSceneContextPlannerDeps,
  ) => Promise<NonSceneContextPlanResult>;
}

export interface PrepareTurnPlannerDeps {
  scene?: ContextPlannerDeps;
  nonScene?: NonSceneContextPlannerDeps;
}

export interface TurnPreparer {
  (
    request: SceneTurnContextRequest,
    deps: { scene: ContextPlannerDeps },
  ): Promise<ChatContextPlanResult>;
  (
    request: NonSceneTurnContextRequest,
    deps: { nonScene: NonSceneContextPlannerDeps },
  ): Promise<NonSceneContextPlanResult>;
}

export function bindTurn(
  planScene: PrepareTurnDependencies["planScene"],
  planNonScene: PrepareTurnDependencies["planNonScene"],
): TurnPreparer {
  return ((request: TurnContextRequest, deps: PrepareTurnPlannerDeps) =>
    prepareTurnInternal(request, deps, {
      planScene,
      planNonScene,
    })) as TurnPreparer;
}

/**
 * Single application entrypoint for provider-bound context preparation.
 * Scope-specific source adapters remain isolated, but callers no longer own
 * the scene/non-scene planner selection.
 */
export function prepareTurn(
  request: SceneTurnContextRequest,
  deps: { scene: ContextPlannerDeps },
  planners: PrepareTurnDependencies,
): Promise<ChatContextPlanResult>;
export function prepareTurn(
  request: NonSceneTurnContextRequest,
  deps: { nonScene: NonSceneContextPlannerDeps },
  planners: PrepareTurnDependencies,
): Promise<NonSceneContextPlanResult>;
export function prepareTurn(
  request: TurnContextRequest,
  deps: PrepareTurnPlannerDeps,
  planners: PrepareTurnDependencies,
): Promise<PreparedTurnResult> {
  return prepareTurnInternal(request, deps, planners);
}

function isSceneRequest(
  request: TurnContextRequest,
): request is SceneTurnContextRequest {
  return request.scope.kind === "scene";
}

async function prepareTurnInternal(
  request: TurnContextRequest,
  deps: PrepareTurnPlannerDeps,
  planners: PrepareTurnDependencies,
): Promise<PreparedTurnResult> {
  if (isSceneRequest(request)) {
    if (!deps.scene) throw new Error("scene context planner is not configured");
    return planners.planScene(request, deps.scene);
  }
  if (!deps.nonScene) {
    throw new Error("non-scene context planner is not configured");
  }
  return planners.planNonScene(request, deps.nonScene);
}
