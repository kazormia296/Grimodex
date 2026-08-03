/**
 * Application-owned projections for external change events.
 *
 * The polling transport must stay independent from the feature stores that it
 * refreshes. A typed projector boundary keeps the fan-out contract explicit
 * and prevents the transport from growing another module-init cycle.
 */
export interface ExternalWriteProjectors {
  reloadForeshadows: (projectId: string) => Promise<void>;
  bumpChronicleRevision: () => void;
  reloadPlotThreads: (projectId: string) => Promise<void>;
  reloadLabels: (projectId: string) => Promise<void>;
}

let registeredProjectors: ExternalWriteProjectors | null = null;

/** Install feature adapters from the renderer composition root. */
export function registerExternalWriteProjectors(
  projectors: ExternalWriteProjectors,
): void {
  registeredProjectors = projectors;
}

/** Resolve the projectors used by the external-write transport. */
export function getExternalWriteProjectors(): ExternalWriteProjectors {
  if (!registeredProjectors) {
    throw new Error("External-write projectors are not registered");
  }
  return registeredProjectors;
}
