import {
  parseNarrativeRuntimePolicy,
  type NarrativeRuntimePolicy,
} from "../runtime/narrativeRuntimePolicy";
import type { NativeNarrativeRuntimePolicy } from "../runtime/narrativeRuntimePolicyApi";

/**
 * Renderer-side mirrors of Narrative Maintenance flags.
 * Native `require_narrative_maintenance_allowed` remains authoritative.
 */
export function isNarrativeMaintenanceUiEnabled(
  policy?: NativeNarrativeRuntimePolicy,
): boolean {
  return (
    policy?.maintenancePreviewAllowed === true &&
    policy.effectiveMode !== "disabled"
  );
}

export function isNarrativeGenericImportUiEnabled(
  policy: NarrativeRuntimePolicy = parseNarrativeRuntimePolicy(null),
): boolean {
  return policy.genericImportEnabled && policy.runtimeMode !== "disabled";
}

export function isNarrativeBackgroundAiUiEnabled(
  _policy: NarrativeRuntimePolicy = parseNarrativeRuntimePolicy(null),
): boolean {
  // Gate C0 is preview-only. Native policy fields reserve the future contract,
  // but this restack must not expose or start Background AI.
  return false;
}
