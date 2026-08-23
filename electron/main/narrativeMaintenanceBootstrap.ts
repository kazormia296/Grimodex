/**
 * Main-process-only construction seam for the C2-5B maintenance runtime.
 *
 * Keeping this small orchestration unit separate from `index.ts` lets the
 * production startup path be exercised without importing Electron's app
 * singleton or running the rest of the main-process side effects. The
 * scheduler and trigger coordinator remain the owners of their respective
 * runtime behavior; this module only controls whether they are constructed
 * and started.
 */
import {
  createNarrativeMaintenanceScheduler,
  type NarrativeMaintenanceBackendLike,
  type NarrativeMaintenanceScheduler,
} from "./narrativeMaintenance.js";
import {
  createNarrativeMaintenanceTriggerCoordinator,
  type NarrativeMaintenanceTriggerCoordinator,
} from "./narrativeMaintenanceTriggers.js";
import {
  shouldDisableNarrativeMaintenanceForLaunch,
  type NarrativeMaintenanceCiSeam,
} from "./narrativeMaintenanceCiSeam.js";

export interface NarrativeMaintenanceBootstrapRuntime {
  readonly scheduler: NarrativeMaintenanceScheduler | null;
  readonly coordinator: NarrativeMaintenanceTriggerCoordinator | null;
}

export interface NarrativeMaintenanceBootstrapFactories {
  readonly createScheduler?: typeof createNarrativeMaintenanceScheduler;
  readonly createCoordinator?: typeof createNarrativeMaintenanceTriggerCoordinator;
}

const inactiveRuntime = (): NarrativeMaintenanceBootstrapRuntime => ({
  scheduler: null,
  coordinator: null,
});

/**
 * Construct the exact main-owned maintenance runtime for one launch.
 *
 * Only the authorized setup launch disables this runtime. Inactive, packaged,
 * and wrong-owner seams are represented as `{ active: false }` and therefore
 * retain the ordinary production scheduler/coordinator path. Workspace events
 * are wired by `index.ts` after construction and remain the only discovery
 * trigger; this seam must not synthesize an event before the event bus exists.
 */
export function bootstrapNarrativeMaintenance(
  backend: NarrativeMaintenanceBackendLike | null,
  seam: NarrativeMaintenanceCiSeam,
  factories: NarrativeMaintenanceBootstrapFactories = {},
): NarrativeMaintenanceBootstrapRuntime {
  if (shouldDisableNarrativeMaintenanceForLaunch(seam)) {
    return inactiveRuntime();
  }

  let coordinator: NarrativeMaintenanceTriggerCoordinator | null = null;
  const createScheduler =
    factories.createScheduler ?? createNarrativeMaintenanceScheduler;
  const createCoordinator =
    factories.createCoordinator ?? createNarrativeMaintenanceTriggerCoordinator;
  const scheduler = createScheduler(backend, {
    onWorkspaceBindingMismatch: () => {
      coordinator?.requestRediscovery();
    },
    onCycleAccepted: () => {
      coordinator?.requestRediscovery();
    },
  });
  coordinator = createCoordinator(backend, scheduler);
  scheduler.start();

  return { scheduler, coordinator };
}
