/**
 * 執筆タイムラプス 記録 ON/OFF オーケストレーター (§15)。
 *
 * recorder.ts を tree/api・settings/api・snapshots といった cross-feature 依存
 * から切り離すため、wipe / baseline / 永続化をここに集約する。
 *
 * 連続性契約 (§15.1): タイムラプス記録は連続・完全なチェーンであって初めて
 * 意味を持つ。途中で OFF にして穴が空いた記録は無意味なので、OFF→ON の
 * 再有効化では既存の change_events / state_snapshots を全 wipe して genesis から
 * 録り直す。ON→OFF は記録を止めるだけ (履歴は保持)。
 *
 * いずれの関数も `projectId` が「現在ロード中のプロジェクト = recorder が bind
 * している先」であることを前提とする (Settings UI は currentProjectId で呼ぶ)。
 * 設定値は固定 PROJECT_ID の settings store を経由せず、実 projectId で
 * getProjectSetting/setProjectSetting を直接読み書きする。
 */

import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { and, count, eq, gt } from "drizzle-orm";
import {
  flushNow,
  initRecorderForProject,
  isRecorderEnabled,
  resetRecorderChain,
  setRecorderEnabled,
  readAuthoritativeChainTail,
} from "./recorder";
import {
  appendBodyBaselines,
  appendGenesisBaselines,
  purgeTimelapseHistoryNative,
} from "./snapshots";
import {
  getProjectSetting,
  getTimelapseResetSequence,
  setTimelapseEnabledSetting,
} from "@/features/settings/api";
import { listAllNodes } from "@/features/tree/api";
import { listCodexContentsForBaseline } from "@/features/codex/api";
import { listSnippets } from "@/features/snippets/api";
import {
  getCurrentWorkspaceIdentity,
  isCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";

export const TIMELAPSE_ENABLED_KEY = "timelapse.enabled";

/**
 * Editor-body entity kinds whose doc.step stream the timelapse replays. The
 * center EditorPane tab fires a `doc.step` change_event for all three
 * (EditorPane.tsx: domain = editor|codex|snippet). Each needs a state_snapshot
 * baseline anchored under the SAME domain the doc.step carries so
 * `compositeTimelapse.buildCursors` can seek to a known starting doc — otherwise
 * a body edit on a pre-existing codex/snippet replays from an empty doc and the
 * first step's position exceeds it (RangeError → replay halts, blank frame).
 */
export type BaselineKind = "scene" | "codex" | "snippet";

export interface EntityBaselineRef {
  kind: BaselineKind;
  id: string;
}

/** Persisted per-project flag. Defaults ON for legacy projects with no row. */
export async function isTimelapseEnabled(projectId: string): Promise<boolean> {
  return (
    (await getProjectSetting(projectId, TIMELAPSE_ENABLED_KEY)) !== "false"
  );
}

/** Number of recorded events for a project (for purge confirmation UI). */
export async function countTimelapseEvents(projectId: string): Promise<number> {
  // COUNT(*) を SQL 側で集計する。全行の id を webview に持ち帰って rows.length で
  // 数えると、長編の change_events (数十 MB になり得る §6) を丸ごと転送してしまう。
  const resetSequence = await getTimelapseResetSequence(projectId);
  const [row] = await db
    .select({ n: count() })
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.projectId, projectId),
        gt(changeEvents.sequence, resetSequence),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Reset the visible recorded history for a project and reset the in-memory
 * chain binding. Native retains the shared canonical hash chain and advances
 * its typed reset epoch so Narrative Change Feed foreign keys remain valid.
 * Does NOT touch the project row.
 */
async function wipeHistory(
  projectId: string,
  expectedWorkspacePath: string,
): Promise<void> {
  await flushNow(); // drain any queued events first (defensive)
  await purgeTimelapseHistoryNative({ expectedWorkspacePath, projectId });
  resetRecorderChain();
}

/** Which entity kinds a genesis-baseline pass should stamp. */
interface BaselineKindFilter {
  scene: boolean;
  codex: boolean;
  snippet: boolean;
}

const ALL_KINDS: BaselineKindFilter = {
  scene: true,
  codex: true,
  snippet: true,
};

/**
 * Stamp every editor-body entity as a genesis baseline through the typed
 * Native writer. The renderer sends IDs only; Native reads each trusted body
 * and commits one bounded kind batch. A failed re-arm is surfaced so the
 * caller can roll the setting back instead of claiming recording is active.
 */
async function stampEntityBaselines(
  projectId: string,
  expectedWorkspacePath: string,
  anchorSequence?: number,
  which: BaselineKindFilter = ALL_KINDS,
  isAuthoritative: () => boolean = () => true,
): Promise<void> {
  const anchorTimestamp = Date.now();
  const batches: Array<{
    kind: BaselineKind;
    entityIds: string[];
    enabled: boolean;
  }> = [];
  if (which.scene) {
    const nodes = await listAllNodes(projectId);
    batches.push({
      kind: "scene",
      entityIds: nodes
        .filter((node) => node.nodeType === "scene")
        .map((node) => node.id),
      enabled: true,
    });
  }
  if (which.codex) {
    const codex = await listCodexContentsForBaseline(projectId);
    batches.push({
      kind: "codex",
      entityIds: codex.map((entry) => entry.id),
      enabled: true,
    });
  }
  if (which.snippet) {
    const snippets = await listSnippets(projectId);
    batches.push({
      kind: "snippet",
      entityIds: snippets.map((snippet) => snippet.id),
      enabled: true,
    });
  }

  for (const batch of batches) {
    if (!batch.enabled || batch.entityIds.length === 0) continue;
    if (!isAuthoritative()) return;
    const result =
      anchorSequence === undefined
        ? await appendGenesisBaselines(
            {
              expectedWorkspacePath,
              projectId,
              kind: batch.kind,
              entityIds: batch.entityIds,
              anchorTimestamp,
            },
            isAuthoritative,
          )
        : await appendBodyBaselines(
            {
              expectedWorkspacePath,
              projectId,
              targets: batch.entityIds.map((id) => ({
                kind: batch.kind,
                id,
              })),
              expectedAnchorSequence: anchorSequence,
            },
            isAuthoritative,
          );
    if (!isAuthoritative()) return;
    if (!result.completed) {
      throw new Error(
        `Timelapse genesis baseline pass did not complete for ${batch.kind}`,
      );
    }
  }
}

/**
 * Default-ON wiring fix: bake genesis entity baselines without a toggle.
 *
 * Explicit OFF→ON/purge continues to use `stampEntityBaselines` after a full
 * wipe. The default-ON load path instead sends only current entity identities
 * to the typed Native writer. Native owns the atomic decision per entity:
 * any existing baseline and existing body step are skipped, current body
 * content is loaded from the trusted table, and a missing baseline is inserted
 * under the exact expected Workspace binding.
 *
 * Entity-level checks make interrupted passes resumable: one existing scene no
 * longer suppresses every remaining scene. Batches stay bounded at the typed
 * wrapper and the mutation-generation callback is checked around every await.
 */
export async function ensureGenesisBaselines(
  projectId: string,
  expectedWorkspacePath: string,
  isAuthoritative: () => boolean = () => true,
): Promise<void> {
  if (!isAuthoritative()) return;
  const nodes = await listAllNodes(projectId);
  if (!isAuthoritative()) return;
  const sceneIds = nodes
    .filter((node) => node.nodeType === "scene")
    .map((node) => node.id);

  if (!isAuthoritative()) return;
  // These are the narrowest existing list projections for the two domains.
  // They still return content, but it is deliberately discarded here: Native
  // reloads the authoritative payload inside the atomic append transaction.
  const codex = await listCodexContentsForBaseline(projectId);
  if (!isAuthoritative()) return;
  const snippets = await listSnippets(projectId);
  if (!isAuthoritative()) return;

  const anchorTimestamp = Date.now();
  const batches = [
    { kind: "scene" as const, entityIds: sceneIds },
    { kind: "codex" as const, entityIds: codex.map((entry) => entry.id) },
    {
      kind: "snippet" as const,
      entityIds: snippets.map((snippet) => snippet.id),
    },
  ];
  for (const batch of batches) {
    if (!isAuthoritative()) return;
    if (batch.entityIds.length === 0) continue;
    const result = await appendGenesisBaselines(
      {
        expectedWorkspacePath,
        projectId,
        kind: batch.kind,
        entityIds: batch.entityIds,
        anchorTimestamp,
      },
      isAuthoritative,
    );
    if (!isAuthoritative()) return;
    if (!result.completed) {
      throw new Error(
        `Timelapse genesis baseline pass did not complete for ${batch.kind}`,
      );
    }
  }
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
      console.warn(
        "[timelapse] rebaseline snapshot batch failed",
        batch,
        err,
      );
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

/** Re-arm the recorder on a freshly-wiped project and stamp baselines. */
async function rearmFromGenesis(
  projectId: string,
  expectedWorkspacePath: string,
): Promise<void> {
  setRecorderEnabled(true);
  await initRecorderForProject(projectId); // re-reads now-empty tail -> genesis
  const anchorSequence = await readAuthoritativeChainTail(projectId);
  await stampEntityBaselines(
    projectId,
    expectedWorkspacePath,
    anchorSequence,
  );
  // Seed the workspace layout snapshot so forward layout events have an initial
  // state to replay on top of (§17 P0.4). Mirrors the per-session seed in
  // projectStore.loadProject so toggle-ON without a reload also anchors the UI.
  const { seedWorkspaceSnapshot } = await import("./seedSession");
  await seedWorkspaceSnapshot(projectId);
}

async function rollbackFailedRearm(
  projectId: string,
  expectedWorkspacePath: string,
  workspaceIdentity: ReturnType<typeof getCurrentWorkspaceIdentity>,
  error: unknown,
): Promise<never> {
  setRecorderEnabled(false);
  try {
    // Both rollback writes are path-bound Native commands. A switch therefore
    // rejects them instead of redirecting cleanup to a same-id project in the
    // replacement workspace.
    await setTimelapseEnabledSetting(projectId, expectedWorkspacePath, false);
  } catch (settingError) {
    console.warn("[timelapse] failed to roll back enabled setting", settingError);
  }
  if (workspaceIdentity && isCurrentWorkspaceIdentity(workspaceIdentity)) {
    try {
      await purgeTimelapseHistoryNative({ expectedWorkspacePath, projectId });
      resetRecorderChain();
    } catch (cleanupError) {
      console.warn("[timelapse] failed to clean up partial re-arm", cleanupError);
    }
  } else {
    console.warn(
      "[timelapse] skipped failed re-arm cleanup because workspace authority changed",
    );
  }
  throw error;
}

/**
 * Toggle recording for a project (§15.6 / §15.7).
 * - enable:  wipe gapped history, restart genesis, baseline current docs.
 * - disable: flush the tail, stop recording, KEEP the existing history.
 */
export async function setTimelapseEnabled(
  projectId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    const workspaceIdentity = getCurrentWorkspaceIdentity();
    if (!workspaceIdentity) {
      throw new Error("Timelapse enable requires an active workspace");
    }
    await wipeHistory(projectId, workspaceIdentity.path);
    try {
      await rearmFromGenesis(projectId, workspaceIdentity.path);
    } catch (error) {
      return rollbackFailedRearm(
        projectId,
        workspaceIdentity.path,
        workspaceIdentity,
        error,
      );
    }
    try {
      await setTimelapseEnabledSetting(
        projectId,
        workspaceIdentity.path,
        true,
      );
    } catch (error) {
      return rollbackFailedRearm(
        projectId,
        workspaceIdentity.path,
        workspaceIdentity,
        error,
      );
    }
  } else {
    await flushNow();
    setRecorderEnabled(false);
    const workspaceIdentity = getCurrentWorkspaceIdentity();
    if (!workspaceIdentity) {
      throw new Error("Timelapse disable requires an active workspace");
    }
    await setTimelapseEnabledSetting(
      projectId,
      workspaceIdentity.path,
      false,
    );
  }
}

/**
 * Manually clear a project's timelapse history (§15.10).
 * - recording ON:  "discard and re-record" — wipe, re-genesis, re-baseline.
 * - recording OFF: simple wipe (chain reset so the next enable starts clean).
 */
export async function purgeTimelapseHistory(projectId: string): Promise<void> {
  const enabled = await isTimelapseEnabled(projectId);
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  if (!workspaceIdentity) {
    throw new Error("Timelapse purge requires an active workspace");
  }
  await wipeHistory(projectId, workspaceIdentity.path);
  if (enabled) {
    try {
      await rearmFromGenesis(projectId, workspaceIdentity.path);
    } catch (error) {
      return rollbackFailedRearm(
        projectId,
        workspaceIdentity.path,
        workspaceIdentity,
        error,
      );
    }
  }
}
