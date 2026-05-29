import { db } from "@/db/client";
import { stateSnapshots } from "@/db/schema";
import { and, desc, eq, lte } from "drizzle-orm";
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";

/**
 * 執筆タイムラプス state snapshots.
 *
 * Snapshots anchor the replay seek path so the engine can jump to a known
 * doc state and forward-replay only the trailing events. Plan §6 specifies
 * one per (projectId, domain, entityId) every ~1000 events or 1 hour.
 *
 * Encoding note: the plan calls for zstd but we use gzip via fflate (already
 * a dep). gzip is ~10% larger but avoids adding zstd-wasm; we keep an
 * `encoding` column so a future swap stays read-compatible.
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
  /** Caller-defined payload. Stringified before compression. */
  payload: unknown;
}

export async function recordStateSnapshot(
  input: RecordSnapshotInput,
): Promise<void> {
  const json =
    typeof input.payload === "string"
      ? input.payload
      : JSON.stringify(input.payload);
  const compressed = gzipSync(strToU8(json));
  await db.insert(stateSnapshots).values({
    projectId: input.projectId,
    domain: input.domain,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    anchorSequence: input.anchorSequence,
    anchorTimestamp: input.anchorTimestamp,
    payload: Buffer.from(compressed),
    encoding: "gzip-json",
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
  const buf = toBytes(row.payload);
  // The encoding column is authoritative. recordStateSnapshot writes
  // 'gzip-json'; the schema default 'zstd-json' is unused. Decode per the
  // stored encoding rather than assuming gzip.
  const json =
    row.encoding === "gzip-json" ? strFromU8(gunzipSync(buf)) : strFromU8(buf);
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    payload = json;
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

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (
    v &&
    typeof v === "object" &&
    "buffer" in (v as { buffer?: unknown }) &&
    "byteLength" in (v as { byteLength?: unknown })
  ) {
    const view = v as {
      buffer: ArrayBufferLike;
      byteOffset: number;
      byteLength: number;
    };
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error("unsupported snapshot payload representation");
}
