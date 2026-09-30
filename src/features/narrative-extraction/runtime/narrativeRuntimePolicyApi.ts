import { invoke } from "@/lib/tauri";
import {
  DEFAULT_NARRATIVE_RUNTIME_POLICY,
  NARRATIVE_RUNTIME_POLICY_COMMANDS,
  type NarrativeRuntimeMode,
  type NarrativeRuntimePolicy,
} from "./narrativeRuntimePolicy";

const RUNTIME_MODES = new Set<NarrativeRuntimeMode>([
  "disabled",
  "review-only",
  "manual-apply",
  "automatic",
]);

/** Native-computed policy view used for renderer capability gating. */
export interface NativeNarrativeRuntimePolicy extends NarrativeRuntimePolicy {
  readonly effectiveMode: NarrativeRuntimeMode;
  readonly maintenancePreviewAllowed: boolean;
}

function failClosedNativePolicy(): NativeNarrativeRuntimePolicy {
  return {
    ...DEFAULT_NARRATIVE_RUNTIME_POLICY,
    effectiveMode: DEFAULT_NARRATIVE_RUNTIME_POLICY.runtimeMode,
    maintenancePreviewAllowed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the Native policy response without enabling a flag on malformed data. */
export function parseNativeNarrativeRuntimePolicy(
  value: unknown,
): NativeNarrativeRuntimePolicy {
  if (!isRecord(value)) return failClosedNativePolicy();

  const runtimeMode = value.runtimeMode;
  const effectiveMode = value.effectiveMode;
  const maintenanceEnabled = value.maintenanceEnabled;
  const maintenancePreviewAllowed = value.maintenancePreviewAllowed;
  const genericImportEnabled = value.genericImportEnabled;
  const backgroundAiEnabled = value.backgroundAiEnabled;
  if (
    typeof runtimeMode !== "string" ||
    !RUNTIME_MODES.has(runtimeMode as NarrativeRuntimeMode) ||
    typeof effectiveMode !== "string" ||
    !RUNTIME_MODES.has(effectiveMode as NarrativeRuntimeMode) ||
    typeof maintenanceEnabled !== "boolean" ||
    typeof maintenancePreviewAllowed !== "boolean" ||
    typeof genericImportEnabled !== "boolean" ||
    typeof backgroundAiEnabled !== "boolean"
  ) {
    return failClosedNativePolicy();
  }

  return {
    runtimeMode: runtimeMode as NarrativeRuntimeMode,
    effectiveMode: effectiveMode as NarrativeRuntimeMode,
    maintenanceEnabled,
    maintenancePreviewAllowed,
    genericImportEnabled,
    backgroundAiEnabled,
  };
}

export async function getNarrativeRuntimePolicy(): Promise<NativeNarrativeRuntimePolicy> {
  const value = await invoke<unknown>(NARRATIVE_RUNTIME_POLICY_COMMANDS.get);
  return parseNativeNarrativeRuntimePolicy(value);
}
