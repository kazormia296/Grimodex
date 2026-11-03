/**
 * "Apply the default to unset scenes" (SDEF/1 R14, R16, R18; DR-SDEF-30).
 *
 * One renderer helper loops the existing A1 writer `narrative_scene_scope_update`
 * per Scene: it is the author's operation, not a new bulk writer. Only Scenes
 * whose marker is the requested one are written; `explicit` Scenes are never
 * touched. Every write carries the Scene's own read version, so Native's OCC
 * and registry checks still decide. The result may be partial.
 */
import { invoke } from "@/lib/tauri";
import {
  readScopeProjectDefault,
  type ScopeDefaultAxes,
} from "@/lib/sceneScopeDefault";
import type {
  Binding,
  ScopeRead,
  ScopeUpdate,
} from "@/features/editor/sceneMeta/sceneScopeTypes";

export type ScopeApplyTarget = "unknown" | "legacy-absent";

export type ScopeApplyResult =
  | { status: "no-default" }
  | {
      status: "done";
      applied: number;
      /** Scenes whose marker was not the target (left unchanged). */
      skipped: number;
      /** Scenes that could not be read or written (OCC, removed, ...). */
      failed: number;
    };

export type ScopeMarkerCounts = {
  unknown: number;
  legacyAbsent: number;
  explicit: number;
  failed: number;
};

type ApplyInput = {
  workspacePath: string;
  projectId: string;
  sceneIds: readonly string[];
};

function readScope(
  workspacePath: string,
  projectId: string,
  sceneId: string,
): Promise<ScopeRead> {
  return invoke<ScopeRead>("narrative_scene_scope_read", {
    expectedWorkspacePath: workspacePath,
    projectId,
    sceneId,
  });
}

/** Counts the markers of the given Scenes before asking the author. */
export async function countScopeMarkers({
  workspacePath,
  projectId,
  sceneIds,
}: ApplyInput): Promise<ScopeMarkerCounts> {
  const counts: ScopeMarkerCounts = {
    unknown: 0,
    legacyAbsent: 0,
    explicit: 0,
    failed: 0,
  };
  for (const sceneId of sceneIds) {
    try {
      const marker = (await readScope(workspacePath, projectId, sceneId))
        .binding.compatibilityMarker;
      if (marker === "unknown") counts.unknown += 1;
      else if (marker === "legacy-absent") counts.legacyAbsent += 1;
      else counts.explicit += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

export function applyBindingScope(
  binding: Binding,
  axes: {
    queryIdentity: ScopeDefaultAxes;
    materialConstraint: ScopeDefaultAxes;
  },
) {
  return {
    projectId: binding.projectId,
    sceneId: binding.sceneId,
    requestId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    eventUid: crypto.randomUUID(),
    baseVersion: binding.version,
    updatedAt: new Date().toISOString(),
    scope: {
      schemaVersion: 1,
      compatibilityMarker: "explicit",
      queryIdentity: axes.queryIdentity,
      materialConstraint: axes.materialConstraint,
      knowledgeHolder: { kind: "reader" },
      audience: { kind: "reader" },
    },
  };
}

export async function applyScopeDefaultToScenes({
  workspacePath,
  projectId,
  sceneIds,
  target,
}: ApplyInput & { target: ScopeApplyTarget }): Promise<ScopeApplyResult> {
  const current = await readScopeProjectDefault(workspacePath, projectId);
  if (current.default.state !== "set") return { status: "no-default" };
  const axes = current.default;
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  for (const sceneId of sceneIds) {
    try {
      const { binding } = await readScope(workspacePath, projectId, sceneId);
      if (binding.compatibilityMarker !== target) {
        skipped += 1;
        continue;
      }
      await invoke<ScopeUpdate>("narrative_scene_scope_update", {
        expectedWorkspacePath: workspacePath,
        payload: applyBindingScope(binding, axes),
      });
      applied += 1;
    } catch {
      failed += 1;
    }
  }
  return { status: "done", applied, skipped, failed };
}
