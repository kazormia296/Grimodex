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
  scheduleNarrativeMaintenanceProcessInterruption,
  type NarrativeMaintenanceBackendLike,
  type NarrativeMaintenanceScheduler,
} from "./narrativeMaintenance.js";
import {
  createNarrativeMaintenanceTriggerCoordinator,
  type NarrativeMaintenanceTriggerCoordinator,
} from "./narrativeMaintenanceTriggers.js";
import {
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
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
    onCompletionRecoveryAcknowledged: (currentBinding) => {
      coordinator?.requestRecoveryRediscovery(currentBinding);
    },
    onCycleAccepted: ({ demandOnly }) => {
      // DR-PUBG-5-17: a cycle that carried only Graph Index demand wakes (no
      // work, no discovery wake) does not spend the discovery chain's
      // rediscovery budget. W1, the seam's B wake and every work cycle still
      // do, as before.
      if (!demandOnly) coordinator?.requestRediscovery();
      // Accepted cycles double as a wake-outbox drain point so an Epoch
      // rotation whose live event was lost mid-session is still delivered.
      void coordinator?.drainWakeOutbox();
    },
    onCiProcessInterruption: (ack, expectedBinding) => {
      if (!seam.active) return false;
      return scheduleNarrativeMaintenanceProcessInterruption(
        backend,
        ack,
        expectedBinding,
        () =>
          seam.active &&
          seam.ownerToken === NARRATIVE_MAINTENANCE_OWNER_TOKEN &&
          seam.fault === "process-interruption",
      );
    },
  });
  // The coordinator and scheduler retain their production owners. No
  // maintenance/scheduler callback is allowed to arm acceptance evidence;
  // the held-Freshness writer is fed directly by the Freshness scheduler.
  // The coordinator accepts Native's Graph Index build wakes (discovery's
  // `wakeProjectIds` and the Graph owner's demand event) in every launch.
  // B-ROUTE (DR-BSEAM-1) accepted them only for the validated, unpackaged CI
  // launch that selected the gated build; DR-PUBG-5-14 lifts that, because
  // main has no gate of its own to read: a main-side constant would be a
  // second switch beside `PRODUCT_GRAPH_PUBLISHED` (DR-PUBG-5-8), and the
  // gate lives in Native. While that constant is false Native returns no
  // wake and emits no demand, and a wake it did return would still meet the
  // closed gate of the cycle.
  coordinator = createCoordinator(backend, scheduler, {
    acceptGraphIndexBuildWakes: true,
  });
  scheduler.start();

  return { scheduler, coordinator };
}
