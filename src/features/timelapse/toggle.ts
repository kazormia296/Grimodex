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
import { and, count, eq, inArray } from "drizzle-orm";
import {
  flushNow,
  getRecorderChainHead,
  initRecorderForProject,
  isRecorderEnabled,
  resetRecorderChain,
  setRecorderEnabled,
} from "./recorder";
import { recordStateSnapshot, loadLatestSnapshot } from "./snapshots";
import { getProjectSetting, setProjectSetting } from "@/features/settings/api";
import {
  listAllNodes,
  loadSceneContent,
  loadScenesFull,
} from "@/features/tree/api";
import {
  getCodexEntry,
  listCodexContentsForBaseline,
} from "@/features/codex/api";
import { getSnippet, listSnippets } from "@/features/snippets/api";

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

/** doc.step domain + entityType per kind (must match the recorder + buildCursors). */
const KIND_SNAPSHOT: Record<
  BaselineKind,
  { domain: string; entityType: string }
> = {
  scene: { domain: "editor", entityType: "scene" },
  codex: { domain: "codex", entityType: "codex_entry" },
  snippet: { domain: "snippet", entityType: "snippet" },
};

/**
 * Current PM-JSON body for an entity, or null when it no longer exists (a stale
 * ref must be skipped, not stamped with an empty doc). Scenes throw on a missing
 * node (caught upstream); codex/snippet resolve to undefined.
 */
async function loadEntityContent(
  projectId: string,
  ref: EntityBaselineRef,
): Promise<string | null> {
  if (ref.kind === "scene") return loadSceneContent(ref.id);
  if (ref.kind === "codex") {
    return (await getCodexEntry(projectId, ref.id))?.content ?? null;
  }
  return (await getSnippet(projectId, ref.id))?.content ?? null;
}

/**
 * Record one entity baseline. Best-effort: a failure degrades that entity's
 * replay seek but never corrupts the chain, so callers swallow the warning and
 * continue with the rest.
 */
async function recordEntityBaseline(
  projectId: string,
  kind: BaselineKind,
  entityId: string,
  payload: string,
  anchorSequence: number,
  anchorTimestamp: number,
  isAuthoritative: () => boolean = () => true,
): Promise<void> {
  if (!isAuthoritative()) return;
  const spec = KIND_SNAPSHOT[kind];
  await recordStateSnapshot({
    projectId,
    domain: spec.domain,
    entityType: spec.entityType,
    entityId,
    anchorSequence,
    anchorTimestamp,
    payload,
  });
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
  const [row] = await db
    .select({ n: count() })
    .from(changeEvents)
    .where(eq(changeEvents.projectId, projectId));
  return row?.n ?? 0;
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
 * Stamp the current doc of every editor-body entity (scenes + codex entries +
 * snippets) as a genesis (anchorSequence=0) baseline so post-enable edits replay
 * from a known starting doc. codex/snippet list rows already carry `.content`,
 * so they're stamped without a re-fetch; scenes load their body lazily.
 * `which` limits the pass to kinds that don't already have a baseline (see
 * `ensureGenesisBaselines`), so a codex added after the first genesis pass still
 * gets baselined without re-stamping scenes. Best-effort per entity: a failure
 * degrades that entity's replay seek but never corrupts the chain.
 */
async function stampEntityBaselines(
  projectId: string,
  which: BaselineKindFilter = ALL_KINDS,
  isAuthoritative: () => boolean = () => true,
): Promise<void> {
  const anchorTimestamp = Date.now();

  if (which.scene) {
    const nodes = await listAllNodes(projectId);
    const scenes = nodes.filter((n) => n.nodeType === "scene");
    // per-scene loadSceneContent は 1 件ごとに IPC 往復 + drizzle sqlite-proxy の
    // warmed microtask を積み上げる N+1 (長編で数百シーン)。loadScenesFull で 1 往復に
    // 畳む — 内部で同じ read-after-write バリア (awaitPendingSceneContentWrite) を
    // 張るので、記録される baseline payload は loadSceneContent と不変。
    const contents = await loadScenesFull(scenes.map((s) => s.id));
    for (const scene of scenes) {
      try {
        const payload = contents.get(scene.id)?.content ?? ""; // PM-JSON string
        await recordEntityBaseline(
          projectId,
          "scene",
          scene.id,
          payload,
          0,
          anchorTimestamp,
          isAuthoritative,
        );
      } catch (err) {
        console.warn("[timelapse] baseline failed for scene", scene.id, err);
      }
    }
  }

  if (which.codex) {
    // baseline payload は content (PM JSON) だけなので id+content projection。
    const codex = await listCodexContentsForBaseline(projectId);
    for (const entry of codex) {
      try {
        await recordEntityBaseline(
          projectId,
          "codex",
          entry.id,
          entry.content,
          0,
          anchorTimestamp,
          isAuthoritative,
        );
      } catch (err) {
        console.warn("[timelapse] baseline failed for codex", entry.id, err);
      }
    }
  }

  if (which.snippet) {
    const snippetRows = await listSnippets(projectId);
    for (const snippet of snippetRows) {
      try {
        await recordEntityBaseline(
          projectId,
          "snippet",
          snippet.id,
          snippet.content,
          0,
          anchorTimestamp,
          isAuthoritative,
        );
      } catch (err) {
        console.warn(
          "[timelapse] baseline failed for snippet",
          snippet.id,
          err,
        );
      }
    }
  }
}

/**
 * Cheap existence probe: has this project recorded any editor-body step (scene,
 * codex, OR snippet)? LIMIT 1 keeps it O(1) on the load path even for a large
 * change_events table (a long novel's log can reach tens of MB — §6). "Genesis"
 * for a body baseline means specifically "no body doc.step to double-apply", not
 * "no events at all": a project may hold only layout/chat events yet still have
 * content-bearing scenes/codex/snippets that need baselining. A codex-only edit
 * (editor doc.step absent, codex doc.step present) is likewise past genesis —
 * stamping anchor=0 over its recorded steps would double-apply them.
 */
async function hasBodySteps(projectId: string): Promise<boolean> {
  const rows = await db
    .select({ id: changeEvents.id })
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.projectId, projectId),
        inArray(changeEvents.domain, ["editor", "codex", "snippet"]),
        eq(changeEvents.opType, "doc.step"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Default-ON wiring fix: bake genesis scene baselines without a toggle.
 *
 * `stampSceneBaselines` otherwise runs only on the explicit OFF→ON toggle /
 * purge (`rearmFromGenesis`). Under the default-ON setting `loadProject`
 * auto-enables recording, so a project that is never toggled gets no scene
 * baselines — and a non-empty scene then can't be replayed in the timelapse
 * export (it seeds from an empty doc and a step referencing the pre-existing
 * content throws RangeError). Bake baselines once, at genesis (no recorded
 * events yet), so the default-ON path matches the toggled path.
 *
 * Two guards keep this safe and idempotent:
 *  - Skip when body steps already exist: past genesis an anchorSequence=0
 *    baseline would double-apply the already-recorded steps on top of a doc
 *    that already includes them (positions go out of range — the very bug we
 *    fix). Such projects can only be repaired by an explicit OFF→ON re-record.
 *  - Skip PER KIND when a baseline for that kind already exists: avoids duplicate
 *    rows on reload, yet still baselines a codex/snippet added AFTER the first
 *    genesis pass (scenes stay skipped, the new kind gets stamped) — otherwise a
 *    single editor-only guard would leave the fresh codex/snippet unbaselined.
 */
export async function ensureGenesisBaselines(
  projectId: string,
  isAuthoritative: () => boolean = () => true,
): Promise<void> {
  if (!isAuthoritative()) return;
  if (await hasBodySteps(projectId)) return; // past genesis
  if (!isAuthoritative()) return;
  const which: BaselineKindFilter = {
    scene: !(await loadLatestSnapshot({ projectId, domain: "editor" })),
    codex: !(await loadLatestSnapshot({ projectId, domain: "codex" })),
    snippet: !(await loadLatestSnapshot({ projectId, domain: "snippet" })),
  };
  if (!isAuthoritative()) return;
  if (!which.scene && !which.codex && !which.snippet) return; // all baked
  await stampEntityBaselines(projectId, which, isAuthoritative);
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
  await flushNow();
  const anchorSequence = committedSequence ?? getRecorderChainHead();
  const anchorTimestamp = Date.now();
  for (const ref of refs) {
    try {
      const payload = await loadEntityContent(projectId, ref); // PM-JSON string
      if (payload === null) continue; // entity gone — skip, don't stamp empty
      await recordEntityBaseline(
        projectId,
        ref.kind,
        ref.id,
        payload,
        anchorSequence,
        anchorTimestamp,
      );
    } catch (err) {
      console.warn(
        "[timelapse] rebaseline snapshot failed for",
        ref.kind,
        ref.id,
        err,
      );
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
async function rearmFromGenesis(projectId: string): Promise<void> {
  setRecorderEnabled(true);
  await initRecorderForProject(projectId); // re-reads now-empty tail -> genesis
  await stampEntityBaselines(projectId);
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
