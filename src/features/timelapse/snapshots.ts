import { db } from "@/db/client";
import { stateSnapshots } from "@/db/schema";
import { invoke } from "@/lib/tauri";
import { and, desc, eq, lte } from "drizzle-orm";

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

export interface RecordSnapshotInput {
  projectId: string;
  domain: string;
  entityType?: string | null;
  entityId?: string | null;
  anchorSequence: number;
  anchorTimestamp: number;
  /** Caller-defined payload. Stringified before storage. */
  payload: unknown;
}

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

const GENESIS_BASELINE_BATCH_SIZE = 64;
const GENESIS_BASELINE_BATCH_TOO_LARGE =
  "TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE";

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

export async function recordStateSnapshot(
  input: RecordSnapshotInput,
): Promise<void> {
  const json =
    typeof input.payload === "string"
      ? input.payload
      : JSON.stringify(input.payload);
  await db.insert(stateSnapshots).values({
    projectId: input.projectId,
    domain: input.domain,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    anchorSequence: input.anchorSequence,
    anchorTimestamp: input.anchorTimestamp,
    payload: json,
    encoding: "json",
    createdAt: Date.now(),
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
  const filters = [
    eq(stateSnapshots.projectId, opts.projectId),
    eq(stateSnapshots.domain, opts.domain),
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
