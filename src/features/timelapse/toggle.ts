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
import { changeEvents, stateSnapshots } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  flushNow,
  initRecorderForProject,
  resetRecorderChain,
  setRecorderEnabled,
} from "./recorder";
import { recordStateSnapshot } from "./snapshots";
import { getProjectSetting, setProjectSetting } from "@/features/settings/api";
import { listAllNodes, loadSceneContent } from "@/features/tree/api";

export const TIMELAPSE_ENABLED_KEY = "timelapse.enabled";

/** Persisted per-project flag. Defaults ON for legacy projects with no row. */
export async function isTimelapseEnabled(projectId: string): Promise<boolean> {
  return (
    (await getProjectSetting(projectId, TIMELAPSE_ENABLED_KEY)) !== "false"
  );
}

/** Number of recorded events for a project (for purge confirmation UI). */
export async function countTimelapseEvents(projectId: string): Promise<number> {
  const rows = await db
    .select({ id: changeEvents.id })
    .from(changeEvents)
    .where(eq(changeEvents.projectId, projectId));
  return rows.length;
}

/**
 * Delete all recorded history for a project and reset the in-memory chain so
 * the next flush starts a fresh genesis chain. Does NOT touch the project row.
 */
async function wipeHistory(projectId: string): Promise<void> {
  await flushNow(); // drain any queued events first (defensive)
  await db.delete(changeEvents).where(eq(changeEvents.projectId, projectId));
  await db
    .delete(stateSnapshots)
    .where(eq(stateSnapshots.projectId, projectId));
  resetRecorderChain();
}

/**
 * Stamp the current doc of every scene as a genesis (anchorSequence=0) baseline
 * so post-enable edits replay from a known starting doc. Best-effort per scene:
 * a failure degrades replay seek for that scene but never corrupts the chain.
 */
async function stampSceneBaselines(projectId: string): Promise<void> {
  const nodes = await listAllNodes(projectId);
  const scenes = nodes.filter((n) => n.nodeType === "scene");
  const anchorTimestamp = Date.now();
  for (const scene of scenes) {
    try {
      const payload = await loadSceneContent(scene.id); // PM-JSON string
      await recordStateSnapshot({
        projectId,
        domain: "editor",
        entityType: "scene",
        entityId: scene.id,
        anchorSequence: 0,
        anchorTimestamp,
        payload,
      });
    } catch (err) {
      console.warn(
        "[timelapse] baseline snapshot failed for scene",
        scene.id,
        err,
      );
    }
  }
}

/** Re-arm the recorder on a freshly-wiped project and stamp baselines. */
async function rearmFromGenesis(projectId: string): Promise<void> {
  setRecorderEnabled(true);
  await initRecorderForProject(projectId); // re-reads now-empty tail -> genesis
  await stampSceneBaselines(projectId);
  // Seed the workspace layout snapshot so forward layout events have an initial
  // state to replay on top of (§17 P0.4). Mirrors the per-session seed in
  // projectStore.loadProject so toggle-ON without a reload also anchors the UI.
  const { seedWorkspaceSnapshot } = await import("./seedSession");
  await seedWorkspaceSnapshot(projectId);
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
    await wipeHistory(projectId);
    await rearmFromGenesis(projectId);
    await setProjectSetting(projectId, TIMELAPSE_ENABLED_KEY, "true");
  } else {
    await flushNow();
    setRecorderEnabled(false);
    await setProjectSetting(projectId, TIMELAPSE_ENABLED_KEY, "false");
  }
}

/**
 * Manually clear a project's timelapse history (§15.10).
 * - recording ON:  "discard and re-record" — wipe, re-genesis, re-baseline.
 * - recording OFF: simple wipe (chain reset so the next enable starts clean).
 */
export async function purgeTimelapseHistory(projectId: string): Promise<void> {
  const enabled = await isTimelapseEnabled(projectId);
  await wipeHistory(projectId);
  if (enabled) await rearmFromGenesis(projectId);
}
