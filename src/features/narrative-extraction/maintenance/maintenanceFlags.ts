import {
  parseNarrativeRuntimePolicy,
  type NarrativeRuntimePolicy,
} from "../runtime/narrativeRuntimePolicy";

/**
 * Renderer-side mirrors of Narrative Maintenance flags.
 * Native `require_narrative_maintenance_allowed` remains authoritative.
 */
export function isNarrativeMaintenanceUiEnabled(
  policy: NarrativeRuntimePolicy = parseNarrativeRuntimePolicy(null),
): boolean {
  return policy.maintenanceEnabled && policy.runtimeMode !== "disabled";
}

export function isNarrativeGenericImportUiEnabled(
  policy: NarrativeRuntimePolicy = parseNarrativeRuntimePolicy(null),
): boolean {
  return policy.genericImportEnabled && policy.runtimeMode !== "disabled";
}

export function isNarrativeBackgroundAiUiEnabled(
  policy: NarrativeRuntimePolicy = parseNarrativeRuntimePolicy(null),
): boolean {
  return policy.backgroundAiEnabled && policy.runtimeMode === "automatic";
}

/** Opt-in flag for the new Narrative Maintenance change-feed pipeline. */
export function isNarrativeMaintenancePipelinePreferred(): boolean {
  return import.meta.env.VITE_GRIMODEX_NARRATIVE_MAINTENANCE_PIPELINE === "new";
}
