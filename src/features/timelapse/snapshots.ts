import { db } from "@/db/client";
import { stateSnapshots } from "@/db/schema";
import { invoke } from "@/lib/tauri";
import { getTimelapseResetSequence } from "@/features/settings/api";
import { and, desc, eq, gte, lte } from "drizzle-orm";

/**
 * 執筆タイムラプス state snapshots.
 *
 * Snapshots anchor the replay seek path so the engine can jump to a known
 * doc state and forward-replay only the trailing events. Plan §6 specifies
 * one per (projectId, domain, entityId) every ~1000 events or 1 hour.
 *
 * Storage: plain JSON TEXT (`encoding: 'json'`). The drizzle sqlite-proxy can't
 * round-trip BLOBs (Rust returns a placeholder on read; Buffer is undefined in
 * the webview), so compression is dropped for v1 — payloads are small (a scene
 * doc is a few KB) and the column keeps BLOB affinity which holds TEXT verbatim.
 */

const DEFAULT_EVENT_GAP = 1000;
const DEFAULT_TIME_GAP_MS = 60 * 60 * 1000; // 1 hour

export type GenesisBaselineKind = "scene" | "codex" | "snippet";

export interface AppendGenesisBaselinesInput {
  expectedWorkspacePath: string;
  projectId: string;
  kind: GenesisBaselineKind;
  entityIds: readonly string[];
  anchorTimestamp: number;
}

export interface AppendGenesisBaselinesResult {
  insertedCount: number;
  skippedExistingBaselineCount: number;
  skippedExistingBodyStepCount: number;
  /** False when this activation must stop and resume on a later load. */
  completed: boolean;
}

type NativeAppendGenesisBaselinesResult = Omit<
  AppendGenesisBaselinesResult,
  "completed"
>;

export interface BodyBaselineTarget {
  kind: GenesisBaselineKind;
  id: string;
}

export interface AppendBodyBaselinesInput {
  expectedWorkspacePath: string;
  projectId: string;
  targets: readonly BodyBaselineTarget[];
  expectedAnchorSequence?: number | null;
}

export interface AppendBodyBaselinesResult {
  insertedCount: number;
  skippedExistingCount: number;
  anchorSequence: number;
  anchorTimestamp: number;
  /** False when a workspace switch invalidated the caller. */
  completed: boolean;
}

type NativeAppendBodyBaselinesResult = Omit<
  AppendBodyBaselinesResult,
  "completed"
>;

export interface PurgeTimelapseHistoryInput {
  expectedWorkspacePath: string;
  projectId: string;
}

export interface PurgeTimelapseHistoryResult {
  deletedEventCount: number;
  deletedSnapshotCount: number;
}

export interface LayoutSnapshotPayload {
  layout: object;
  activePresetId?: string | null;
  hiddenStripePanels?: readonly string[];
}

export interface RecordLayoutSnapshotInput {
  expectedWorkspacePath: string;
  projectId: string;
  payload: LayoutSnapshotPayload;
  expectedAnchorSequence?: number | null;
}

export interface RecordLayoutSnapshotResult {
  inserted: boolean;
  anchorSequence: number;
  anchorTimestamp: number;
}

const GENESIS_BASELINE_BATCH_SIZE = 64;
const GENESIS_BASELINE_BATCH_TOO_LARGE =
  "TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE";

/** The Native body writer accepts bounded identity batches only. */
const BODY_BASELINE_BATCH_SIZE = 64;

/**
 * Ask the authoritative backend to append missing genesis baselines.
 *
 * The renderer sends identities only. Native validates the exact Workspace,
 * checks each entity's existing baseline/body-step state, reads its current
 * content, and inserts snapshots in one transaction. Small bounded chunks keep
 * a long novel responsive while the expected Workspace path closes a switch
 * race at the actual database write boundary.
 */
export async function appendGenesisBaselines(
  input: AppendGenesisBaselinesInput,
  isAuthoritative: () => boolean = () => true,
): Promise<AppendGenesisBaselinesResult> {
  const total: AppendGenesisBaselinesResult = {
    insertedCount: 0,
    skippedExistingBaselineCount: 0,
    skippedExistingBodyStepCount: 0,
    completed: true,
  };
  const entityIds = [...new Set(input.entityIds)];
  let aborted = false;
  let warned = false;

  const dispatch = async (batchEntityIds: string[]): Promise<void> => {
    if (aborted || !isAuthoritative()) {
      aborted = true;
      total.completed = false;
      return;
    }
    let result: NativeAppendGenesisBaselinesResult;
    try {
      result = await invoke<NativeAppendGenesisBaselinesResult>(
        "timelapse_genesis_baselines_append",
        {
          expectedWorkspacePath: input.expectedWorkspacePath,
          projectId: input.projectId,
          kind: input.kind,
          entityIds: batchEntityIds,
          anchorTimestamp: input.anchorTimestamp,
        },
      );
    } catch (error) {
      // A Workspace switch between the renderer precheck and Native authority
      // validation is expected cancellation, not a background-init failure.
      if (!isAuthoritative()) {
        aborted = true;
        total.completed = false;
        return;
      }
      if (
        batchEntityIds.length > 1 &&
        String(error).includes(GENESIS_BASELINE_BATCH_TOO_LARGE)
      ) {
        const midpoint = Math.ceil(batchEntityIds.length / 2);
        if (!isAuthoritative()) {
          aborted = true;
          total.completed = false;
          return;
        }
        await dispatch(batchEntityIds.slice(0, midpoint));
        if (aborted || !isAuthoritative()) {
          aborted = true;
          total.completed = false;
          return;
        }
        await dispatch(batchEntityIds.slice(midpoint));
        return;
      }
      if (!warned) {
        warned = true;
        console.warn(
          "[timelapse] genesis baseline batch failed; remaining entities will resume on next load",
          error,
        );
      }
      aborted = true;
      total.completed = false;
      return;
    }
    if (!isAuthoritative()) {
      aborted = true;
      total.completed = false;
      return;
    }
    total.insertedCount += result.insertedCount;
    total.skippedExistingBaselineCount += result.skippedExistingBaselineCount;
    total.skippedExistingBodyStepCount += result.skippedExistingBodyStepCount;
  };

  for (
    let offset = 0;
    offset < entityIds.length;
    offset += GENESIS_BASELINE_BATCH_SIZE
  ) {
    if (aborted || !isAuthoritative()) {
      total.completed = false;
      return total;
    }
    await dispatch(
      entityIds.slice(offset, offset + GENESIS_BASELINE_BATCH_SIZE),
    );
  }

  return total;
}

/**
 * Ask Native to append body baselines at its current canonical tail. The
 * renderer sends only `(kind, id)` identities; body bytes and snapshot scope
 * are never accepted from this boundary. Batches are bounded and an
 * authority callback prevents a workspace switch from being reported as a
 * successful background pass.
 */
export async function appendBodyBaselines(
  input: AppendBodyBaselinesInput,
  isAuthoritative: () => boolean = () => true,
): Promise<AppendBodyBaselinesResult> {
  const targets = [...input.targets];
  if (targets.length === 0) {
    return {
      insertedCount: 0,
      skippedExistingCount: 0,
      anchorSequence: input.expectedAnchorSequence ?? 0,
      anchorTimestamp: 0,
      completed: true,
    };
  }
  const total: AppendBodyBaselinesResult = {
    insertedCount: 0,
    skippedExistingCount: 0,
    anchorSequence: input.expectedAnchorSequence ?? 0,
    anchorTimestamp: 0,
    completed: true,
  };
  for (let offset = 0; offset < targets.length; offset += BODY_BASELINE_BATCH_SIZE) {
    if (!isAuthoritative()) {
      total.completed = false;
      return total;
    }
    const result = await invoke<NativeAppendBodyBaselinesResult>(
      "timelapse_body_baselines_append",
      {
        expectedWorkspacePath: input.expectedWorkspacePath,
        projectId: input.projectId,
        targets: targets.slice(offset, offset + BODY_BASELINE_BATCH_SIZE),
        expectedAnchorSequence: input.expectedAnchorSequence ?? null,
      },
    );
    if (!isAuthoritative()) {
      total.completed = false;
      return total;
    }
    total.insertedCount += result.insertedCount;
    total.skippedExistingCount += result.skippedExistingCount;
    total.anchorSequence = result.anchorSequence;
    total.anchorTimestamp = result.anchorTimestamp;
  }
  return total;
}

/** Clear both protected timelapse ledgers through the typed Native boundary. */
export async function purgeTimelapseHistoryNative(
  input: PurgeTimelapseHistoryInput,
): Promise<PurgeTimelapseHistoryResult> {
  return invoke<PurgeTimelapseHistoryResult>("timelapse_history_purge", {
    expectedWorkspacePath: input.expectedWorkspacePath,
    projectId: input.projectId,
  });
}

/**
 * Persist a renderer UI payload under the fixed
 * `layout/workspace/workspace` scope. Native derives the canonical tail and
 * rejects a stale expected sequence.
 */
export async function recordLayoutSnapshot(
  input: RecordLayoutSnapshotInput,
): Promise<RecordLayoutSnapshotResult> {
  return invoke<RecordLayoutSnapshotResult>("timelapse_layout_snapshot_record", {
    expectedWorkspacePath: input.expectedWorkspacePath,
    projectId: input.projectId,
    payload: input.payload,
    expectedAnchorSequence: input.expectedAnchorSequence ?? null,
  });
}

export interface DecodedSnapshot {
  domain: string;
  entityType: string | null;
  entityId: string | null;
  anchorSequence: number;
  anchorTimestamp: number;
  payload: unknown;
}

/**
 * Load the latest snapshot for `(projectId, domain, entityId)` at or before
 * `asOfSequence` (defaults to "the very latest").
 */
export async function loadLatestSnapshot(opts: {
  projectId: string;
  domain: string;
  entityId?: string | null;
  asOfSequence?: number;
}): Promise<DecodedSnapshot | null> {
  const resetSequence = await getTimelapseResetSequence(opts.projectId);
  const filters = [
    eq(stateSnapshots.projectId, opts.projectId),
    eq(stateSnapshots.domain, opts.domain),
    gte(stateSnapshots.anchorSequence, resetSequence),
  ];
  if (opts.entityId !== undefined) {
    // drizzle: eq() can't compare against null directly via eq; the recorder
    // never inserts a null entityId for scoped entities, so a non-null filter
    // is sufficient for the documented use case.
    if (opts.entityId !== null) {
      filters.push(eq(stateSnapshots.entityId, opts.entityId));
    }
  }
  if (opts.asOfSequence !== undefined) {
    filters.push(lte(stateSnapshots.anchorSequence, opts.asOfSequence));
  }
  const rows = await db
    .select()
    .from(stateSnapshots)
    .where(and(...filters))
    .orderBy(desc(stateSnapshots.anchorSequence))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Payload is plain JSON TEXT (encoding 'json'). Fall back to the raw string
  // if it somehow isn't valid JSON.
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }
  return {
    domain: row.domain,
    entityType: row.entityType,
    entityId: row.entityId,
    anchorSequence: row.anchorSequence,
    anchorTimestamp: row.anchorTimestamp,
    payload,
  };
}

/**
 * Gating heuristic: should we record a new snapshot now?
 * Plan §6 — every ~1000 events or 1 hour, whichever comes first.
 */
export function shouldCreateSnapshot(args: {
  eventsSinceLast: number;
  timeSinceLastMs: number;
  eventGap?: number;
  timeGapMs?: number;
}): boolean {
  const eventGap = args.eventGap ?? DEFAULT_EVENT_GAP;
  const timeGapMs = args.timeGapMs ?? DEFAULT_TIME_GAP_MS;
  if (args.eventsSinceLast >= eventGap) return true;
  if (args.timeSinceLastMs >= timeGapMs) return true;
  return false;
}
