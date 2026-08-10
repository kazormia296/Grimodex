/** Opt-in flag for the new Narrative Maintenance change-feed pipeline. */
export function isNarrativeMaintenancePipelinePreferred(): boolean {
  return import.meta.env.VITE_GRIMODEX_NARRATIVE_MAINTENANCE_PIPELINE === "new";
}
