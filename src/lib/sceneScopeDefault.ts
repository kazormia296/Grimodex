/**
 * Typed renderer wrapper of the project Scene Scope default (SDEF/1 MD5,
 * DR-SDEF-25). The renderer reads and writes the default only through these
 * two IPC commands; Main re-validates the arguments and Native owns the value.
 */
import { invoke } from "@/lib/tauri";

export type ScopeDefaultExact = { kind: "exact"; ref: string };

export type ScopeDefaultAxes = {
  timeline: ScopeDefaultExact;
  worldline: ScopeDefaultExact;
  narrativeLayer: ScopeDefaultExact;
};

export type ScopeDefaultValue =
  | {
      state: "set";
      queryIdentity: ScopeDefaultAxes;
      materialConstraint: ScopeDefaultAxes;
    }
  | { state: "none" };

export type ScopeProjectDefault = {
  projectId: string;
  default: ScopeDefaultValue;
  /** 0 when the project has no row yet; the first write expects 0. */
  version: number;
  sourceToken: string | null;
  updatedAt: string | null;
};

/** The registry refs of the main line (SDEF/1 R13). */
export const MAIN_LINE_REFS = {
  timeline: "timeline:main",
  worldline: "worldline:prime",
  narrativeLayer: "layer:manuscript",
} as const;

export function scopeDefaultAxes(refs: {
  timeline: string;
  worldline: string;
  narrativeLayer: string;
}): ScopeDefaultAxes {
  return {
    timeline: { kind: "exact", ref: refs.timeline },
    worldline: { kind: "exact", ref: refs.worldline },
    narrativeLayer: { kind: "exact", ref: refs.narrativeLayer },
  };
}

export function readScopeProjectDefault(
  workspacePath: string,
  projectId: string,
): Promise<ScopeProjectDefault> {
  return invoke<ScopeProjectDefault>("narrative_scope_project_default_read", {
    expectedWorkspacePath: workspacePath,
    projectId,
  });
}

export function updateScopeProjectDefault(
  workspacePath: string,
  input: {
    projectId: string;
    baseVersion: number;
    default: ScopeDefaultValue;
  },
): Promise<ScopeProjectDefault> {
  return invoke<ScopeProjectDefault>("narrative_scope_project_default_update", {
    expectedWorkspacePath: workspacePath,
    payload: {
      projectId: input.projectId,
      requestId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      eventUid: crypto.randomUUID(),
      baseVersion: input.baseVersion,
      updatedAt: new Date().toISOString(),
      default: input.default,
    },
  });
}
