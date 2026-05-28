/**
 * 執筆タイムラプス recorder — append-only write window.
 *
 * All capture sites (Editor onTransaction, store actions, Map ops, ...) call
 * `recordChangeEvent()`. Events are queued in memory, sequence numbers and
 * hash chain are computed serially, then flushed in a single batched insert
 * every ~100ms.
 *
 * The recorder is GLOBAL per-tab. Tauri runs a single window so cross-tab
 * sequence collisions are not a concern. If we ever ship multi-window, the
 * sequence allocator needs to move into the Rust side.
 */

import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { GENESIS_HASH, computeEventHash, type VerifyResult } from "./hashChain";

const FLUSH_DEBOUNCE_MS = 100;

type Domain =
  | "editor"
  | "codex"
  | "snippet"
  | "grid"
  | "map"
  | "synopsis"
  | "beat";

export interface RecordEventInput {
  domain: Domain;
  opType: string;
  /**
   * Free-form payload — recorder JSON-stringifies it after sorting top-level
   * keys for canonical hashing. Caller should keep payloads small (< ~4 KB
   * typical) so the 100ms flush stays cheap.
   */
  payload: unknown;
  /** Optional: scene/codex/snippet id this event belongs to. */
  sceneId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

interface PendingEvent extends Required<RecordEventInput> {
  timestamp: number;
}

interface RecorderState {
  enabled: boolean;
  projectId: string | null;
  sessionId: string;
  /** Last allocated sequence for the current project (monotone). */
  lastSequence: number;
  /** Most recently committed event hash (chain head). */
  lastHash: Uint8Array;
  queue: PendingEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<void> | null;
  initPromise: Promise<void> | null;
}

const state: RecorderState = {
  enabled: typeof window !== "undefined", // disabled in node/vitest by default
  projectId: null,
  sessionId: newSessionId(),
  lastSequence: 0,
  lastHash: GENESIS_HASH,
  queue: [],
  flushTimer: null,
  flushPromise: null,
  initPromise: null,
};

function newSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Enable or disable the recorder at runtime. Tests call this to suppress the
 * write path; release builds leave it on.
 */
export function setRecorderEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

/**
 * Bind the recorder to a project and resume the chain from the DB tail.
 *
 * Idempotent for the same projectId. Switching projects starts a fresh
 * in-memory session (sessionId changes) but stitches the chain to the prior
 * project's last hash transparently.
 */
export async function initRecorderForProject(projectId: string): Promise<void> {
  if (state.projectId === projectId && state.initPromise) {
    return state.initPromise;
  }
  state.projectId = projectId;
  state.sessionId = newSessionId();
  state.queue = [];

  state.initPromise = (async () => {
    const last = await db
      .select({
        sequence: changeEvents.sequence,
        hash: changeEvents.hash,
      })
      .from(changeEvents)
      .where(eq(changeEvents.projectId, projectId))
      .orderBy(desc(changeEvents.sequence))
      .limit(1);
    const head = last[0];
    if (head) {
      state.lastSequence = head.sequence;
      state.lastHash = toUint8(head.hash);
    } else {
      state.lastSequence = 0;
      state.lastHash = GENESIS_HASH;
    }
  })();
  return state.initPromise;
}

/**
 * Public test hook: reset all in-memory state. Production code should not
 * call this — `initRecorderForProject` is the normal entry point.
 */
export function _resetRecorderForTests(): void {
  state.enabled = false;
  state.projectId = null;
  state.sessionId = newSessionId();
  state.lastSequence = 0;
  state.lastHash = GENESIS_HASH;
  state.queue = [];
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = null;
  state.flushPromise = null;
  state.initPromise = null;
}

/**
 * Queue an event for the current project. Cheap, non-blocking — the caller
 * never awaits the flush. If the recorder is disabled or no project bound
 * yet, the call is silently dropped.
 */
export function recordChangeEvent(input: RecordEventInput): void {
  if (!state.enabled || !state.projectId) return;
  state.queue.push({
    domain: input.domain,
    opType: input.opType,
    payload: input.payload,
    sceneId: input.sceneId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    timestamp: Date.now(),
  });
  scheduleFlush();
}

function scheduleFlush(): void {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void flushNow().catch((err) =>
      console.warn("[timelapse] flush failed", err),
    );
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * Force an immediate flush. Returns the running promise if a flush is already
 * in progress so callers can await completion without racing the timer.
 */
export async function flushNow(): Promise<void> {
  if (state.flushPromise) return state.flushPromise;
  state.flushPromise = (async () => {
    if (state.initPromise) await state.initPromise;
    if (!state.projectId) {
      state.queue = [];
      return;
    }
    if (state.queue.length === 0) return;

    const batch = state.queue;
    state.queue = [];

    const rows: Array<typeof changeEvents.$inferInsert> = [];
    let seq = state.lastSequence;
    let prev = state.lastHash;
    for (const ev of batch) {
      seq += 1;
      const payloadStr = canonicalisePayload(ev.payload);
      const body = {
        projectId: state.projectId,
        sceneId: ev.sceneId,
        domain: ev.domain,
        opType: ev.opType,
        entityType: ev.entityType,
        entityId: ev.entityId,
        payload: payloadStr,
        sessionId: state.sessionId,
        sequence: seq,
        timestamp: ev.timestamp,
        prevHash: prev,
      };
      const hash = await computeEventHash(body);
      rows.push({
        projectId: body.projectId,
        sceneId: body.sceneId,
        domain: body.domain,
        opType: body.opType,
        entityType: body.entityType,
        entityId: body.entityId,
        payload: body.payload,
        sessionId: body.sessionId,
        sequence: body.sequence,
        timestamp: body.timestamp,
        prevHash: Buffer.from(prev),
        hash: Buffer.from(hash),
      });
      prev = hash;
    }

    try {
      await db.insert(changeEvents).values(rows);
      state.lastSequence = seq;
      state.lastHash = prev;
    } catch (err) {
      // Re-queue on failure so the next tick retries; preserve order by
      // prepending the original batch.
      state.queue = batch.concat(state.queue);
      throw err;
    }
  })().finally(() => {
    state.flushPromise = null;
  });
  return state.flushPromise;
}

function canonicalisePayload(p: unknown): string {
  if (typeof p === "string") return p;
  // Top-level key sort — keeps hash stable for objects with same content but
  // different insertion order. Nested objects are passed through as-is; if
  // capture sites need fully canonical nested JSON they should sort upstream.
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const keys = Object.keys(p).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = (p as Record<string, unknown>)[k];
    return JSON.stringify(out);
  }
  return JSON.stringify(p);
}

function toUint8(v: unknown): Uint8Array {
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
  throw new Error("unsupported hash representation");
}

export type { VerifyResult };
export { verifyChain } from "./hashChain";
