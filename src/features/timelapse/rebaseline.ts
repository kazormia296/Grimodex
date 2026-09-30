import {
  flushNow,
  isRecorderEnabled,
  readAuthoritativeChainTail,
} from "./recorder";
import {
  appendBodyBaselines,
  type GenesisBaselineKind,
} from "./baselineSnapshots";
import {
  getCurrentWorkspaceIdentity,
  isCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";

/**
 * Editor-body entity kinds whose doc.step stream the timelapse replays. The
 * center EditorPane tab fires a `doc.step` change_event for all three
 * (EditorPane.tsx: domain = editor|codex|snippet). Each needs a state_snapshot
 * baseline anchored under the SAME domain the doc.step carries so
 * `compositeTimelapse.buildCursors` can seek to a known starting doc — otherwise
 * a body edit on a pre-existing codex/snippet replays from an empty doc and the
 * first step's position exceeds it (RangeError → replay halts, blank frame).
 */
export type BaselineKind = GenesisBaselineKind;

export interface EntityBaselineRef {
  kind: BaselineKind;
  id: string;
}

/**
 * Re-anchor scene editor baselines at the CURRENT chain tail after an
 * out-of-band body rewrite (revision project-snapshot restore / import bulk /
 * external-mount IN). Unlike `stampSceneBaselines` (which anchors at
 * genesis=0), this stamps at the live head so subsequent doc.steps replay on
 * top of the rewritten doc while the pre-write history still replays from the
 * older genesis baseline — `loadLatestSnapshot` picks the greatest
 * `anchorSequence <= asOfSequence`, so both segments stay coherent and the
 * `RangeError: Position out of range` that a stale baseline caused is avoided.
 *
 * Contract: a renderer-recorded caller MUST have already enqueued its meta
 * event before calling this. Native aggregate callers pass the sequence that
 * was committed with the domain mutation; this avoids anchoring at the stale
 * in-memory recorder head when Native appended the canonical event directly.
 * We still flush first so any earlier renderer events reach the DB.
 * Best-effort per scene: a failure degrades that scene's replay seek but never
 * corrupts the chain. No-op when recording is disabled (nothing to keep
 * coherent) or the scene list is empty.
 */
export async function rebaselineEntitiesAtTail(
  projectId: string,
  refs: EntityBaselineRef[],
  committedSequence?: number,
): Promise<void> {
  if (!isRecorderEnabled() || refs.length === 0) return;
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  if (!workspaceIdentity) {
    console.warn(
      "[timelapse] rebaseline skipped because no active workspace identity is available",
    );
    return;
  }
  await flushNow();
  if (!isCurrentWorkspaceIdentity(workspaceIdentity)) return;
  const anchorSequence =
    committedSequence ?? (await readAuthoritativeChainTail(projectId));
  const targets = refs.map((ref) => ({ kind: ref.kind, id: ref.id }));
  const isAuthoritative = () => isCurrentWorkspaceIdentity(workspaceIdentity);
  const append = async (batch: typeof targets): Promise<boolean> => {
    if (!isAuthoritative()) return false;
    try {
      const result = await appendBodyBaselines(
        {
          expectedWorkspacePath: workspaceIdentity.path,
          projectId,
          targets: batch,
          expectedAnchorSequence: anchorSequence,
        },
        isAuthoritative,
      );
      return result.completed;
    } catch (err) {
      console.warn("[timelapse] rebaseline snapshot batch failed", batch, err);
      return false;
    }
  };

  // Native validates every member before inserting. If a stale identity makes
  // a multi-entity transaction fail, retry bounded singletons so valid bodies
  // still receive their tail baseline without ever accepting renderer bytes.
  for (let offset = 0; offset < targets.length; offset += 64) {
    const batch = targets.slice(offset, offset + 64);
    if (await append(batch)) continue;
    if (!isAuthoritative()) return;
    if (batch.length === 1) continue;
    for (const target of batch) {
      const completed = await append([target]);
      if (!completed && !isAuthoritative()) return;
    }
  }
}

/**
 * Back-compat wrapper: re-anchor scene editor baselines at the current tail.
 * Callers that predate the multi-entity generalization keep passing scene ids.
 */
export async function rebaselineScenesAtTail(
  projectId: string,
  sceneIds: string[],
): Promise<void> {
  await rebaselineEntitiesAtTail(
    projectId,
    sceneIds.map((id) => ({ kind: "scene" as const, id })),
  );
}
