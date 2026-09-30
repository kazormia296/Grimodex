export interface StructureHealthPreviewModel {
  readonly phase: "foundation-only";
  readonly liveCountsAvailable: false;
  readonly automaticRepairEnabled: false;
  readonly idleSchedulerEnabled: false;
  readonly backgroundAiEnabled: false;
}

/**
 * Gate C0 exposes only a truthful soft entry. Feed consumers and live
 * freshness counts arrive in later gates, so this model must not invent data.
 */
export function buildStructureHealthPreview(): StructureHealthPreviewModel {
  return {
    phase: "foundation-only",
    liveCountsAvailable: false,
    automaticRepairEnabled: false,
    idleSchedulerEnabled: false,
    backgroundAiEnabled: false,
  };
}
