export type NarrativeRuntimeMode =
  | "disabled"
  | "review-only"
  | "manual-apply"
  | "automatic";

export interface NarrativeRuntimePolicy {
  runtimeMode: NarrativeRuntimeMode;
  maintenanceEnabled: boolean;
  genericImportEnabled: boolean;
  backgroundAiEnabled: boolean;
}

/**
 * @deprecated Legacy app_settings keys. Authority now lives in the Native-owned
 * `narrative_runtime_policy` table. Do not write these keys from renderer SQL.
 */
export const NARRATIVE_RUNTIME_SETTING_KEYS = {
  runtimeMode: "narrative.runtimeMode",
  maintenanceEnabled: "narrative.maintenanceEnabled",
  genericImportEnabled: "narrative.genericImportEnabled",
  backgroundAiEnabled: "narrative.backgroundAiEnabled",
} as const;

/** IPC commands for the Native-owned policy singleton. */
export const NARRATIVE_RUNTIME_POLICY_COMMANDS = {
  get: "narrative_runtime_policy_get",
  set: "narrative_runtime_policy_set",
} as const;

/** Public release Stage 1 defaults — Preview / review only. */
export const DEFAULT_NARRATIVE_RUNTIME_POLICY: NarrativeRuntimePolicy = {
  runtimeMode: "review-only",
  maintenanceEnabled: false,
  genericImportEnabled: false,
  backgroundAiEnabled: false,
};

const VALID_MODES = new Set<NarrativeRuntimeMode>([
  "disabled",
  "review-only",
  "manual-apply",
  "automatic",
]);

function parseBoolFailClosed(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const trimmed = raw.trim().toLowerCase();
  if (
    trimmed === "true" ||
    trimmed === "1" ||
    trimmed === "yes" ||
    trimmed === "on"
  ) {
    return true;
  }
  return false;
}

export function parseNarrativeRuntimeMode(
  raw: string | null | undefined,
): NarrativeRuntimeMode {
  if (raw == null) return "review-only";
  const trimmed = raw.trim() as NarrativeRuntimeMode;
  return VALID_MODES.has(trimmed) ? trimmed : "review-only";
}

/**
 * Fail-closed parser. Missing / corrupt / unknown values collapse to
 * Stage 1 preview defaults (review-only, flags off).
 */
export function parseNarrativeRuntimePolicy(
  settings:
    | Partial<Record<string, string | null | undefined>>
    | null
    | undefined,
): NarrativeRuntimePolicy {
  if (!settings) return { ...DEFAULT_NARRATIVE_RUNTIME_POLICY };
  return {
    runtimeMode: parseNarrativeRuntimeMode(
      settings[NARRATIVE_RUNTIME_SETTING_KEYS.runtimeMode],
    ),
    maintenanceEnabled: parseBoolFailClosed(
      settings[NARRATIVE_RUNTIME_SETTING_KEYS.maintenanceEnabled],
    ),
    genericImportEnabled: parseBoolFailClosed(
      settings[NARRATIVE_RUNTIME_SETTING_KEYS.genericImportEnabled],
    ),
    backgroundAiEnabled: parseBoolFailClosed(
      settings[NARRATIVE_RUNTIME_SETTING_KEYS.backgroundAiEnabled],
    ),
  };
}

export function narrativeDomainApplyAllowed(
  policy: NarrativeRuntimePolicy,
): boolean {
  return (
    policy.runtimeMode === "manual-apply" || policy.runtimeMode === "automatic"
  );
}

export function narrativeExtractionAllowed(
  policy: NarrativeRuntimePolicy,
): boolean {
  return policy.runtimeMode !== "disabled";
}

export function narrativeUndoAllowed(_policy: NarrativeRuntimePolicy): boolean {
  return true;
}

export function narrativeRedoAllowed(policy: NarrativeRuntimePolicy): boolean {
  return narrativeDomainApplyAllowed(policy);
}
