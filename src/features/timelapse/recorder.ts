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
import {
  GENESIS_HASH,
  computeEventHash,
  bytesToHex,
  hexToBytes,
  type VerifyResult,
} from "./hashChain";

const FLUSH_DEBOUNCE_MS = 100;

/**
 * How many consecutive failed flushes to tolerate before dropping the in-flight
 * batch. A genuinely unrecoverable insert (FK violation, disk full, ...) must
 * not tight-loop forever; a sequence collision / transport blip heals in one
 * retry via the DB-tail reconcile in `flushNow`.
 */
const MAX_FLUSH_RETRIES = 10;

type Domain =
  | "editor"
  | "codex"
  | "snippet"
  | "grid"
  | "map"
  | "synopsis"
  | "beat"
  // P0 (§17): forward-only capture of the chat conversation flow and the
  // panel/layout/focus motion, so the timelapse video can show "writing in
  // Grimodex" rather than bare prose. These domains carry no doc.step; their
  // replay consumer is separate from the editor-body replayEngine.
  | "chat"
  | "layout";

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
  /** Consecutive failed-flush count; gates retry backoff and the give-up cap. */
  flushRetries: number;
  initPromise: Promise<void> | null;
}

const state: RecorderState = {
  // OFF by default so test environments don't write through the chain. The
  // app entry point (projectStore.loadProject) flips this on when binding
  // to a real project.
  enabled: false,
  projectId: null,
  sessionId: newSessionId(),
  lastSequence: 0,
  lastHash: GENESIS_HASH,
  queue: [],
  flushTimer: null,
  flushPromise: null,
  flushRetries: 0,
  initPromise: null,
};

function newSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Read the current chain tail (highest sequence + its hash) for a project, or
 * null when the project has no events yet. Shared by init and the flush-failure
 * reconcile path so both anchor to the same ground truth (the DB).
 */
async function readChainTail(
  projectId: string,
): Promise<{ sequence: number; hash: string } | null> {
  const last = await db
    .select({
      sequence: changeEvents.sequence,
      hash: changeEvents.hash,
    })
    .from(changeEvents)
    .where(eq(changeEvents.projectId, projectId))
    .orderBy(desc(changeEvents.sequence))
    .limit(1);
  return last[0] ?? null;
}

/** Exponential flush-retry backoff: 100, 200, 400, ... capped at 5s. */
function flushBackoffMs(attempt: number): number {
  return Math.min(FLUSH_DEBOUNCE_MS * 2 ** (attempt - 1), 5000);
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
  // When the recorder is disabled (typical in tests), don't touch the DB —
  // mocked db harnesses don't need to mock the chain-tail SELECT and we
  // avoid leaking timers / promises across test files.
  if (!state.enabled) {
    state.projectId = projectId;
    // Clear any pending queue and timer so events from the prior project cannot
    // flush into this (OFF) project after a switch.
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.queue = [];
    return;
  }
  if (state.projectId === projectId && state.initPromise) {
    return state.initPromise;
  }
  state.projectId = projectId;
  state.sessionId = newSessionId();
  state.queue = [];

  state.initPromise = (async () => {
    const head = await readChainTail(projectId);
    if (head) {
      state.lastSequence = head.sequence;
      state.lastHash = hexToBytes(head.hash);
    } else {
      state.lastSequence = 0;
      state.lastHash = GENESIS_HASH;
    }
  })();
  return state.initPromise;
}

/**
 * Reset the in-memory chain head so the NEXT flush starts a fresh chain from
 * genesis (sequence 1, prevHash = GENESIS_HASH). Used by the timelapse ON/OFF
 * toggle after wiping a project's change_events: re-enabling must NOT continue
 * the old chain.
 *
 * Critically this nulls `initPromise` so a subsequent `initRecorderForProject`
 * for the SAME project does not short-circuit on its idempotency guard
 * (L105-107) and actually re-reads the now-empty tail. `enabled` / `projectId`
 * are left untouched — this is not a full teardown; the following
 * `initRecorderForProject` will mint a fresh sessionId.
 */
export function resetRecorderChain(): void {
  state.lastSequence = 0;
  state.lastHash = GENESIS_HASH;
  state.queue = [];
  state.flushRetries = 0;
  state.initPromise = null;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
}

/**
 * Current chain head sequence (last committed event for the bound project).
 * Used to anchor per-session seed snapshots (§17 P0.4) so forward layout/chat
 * events (sequence > head) replay on top of the seeded initial state.
 */
export function getRecorderChainHead(): number {
  return state.lastSequence;
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
  state.flushRetries = 0;
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

function scheduleFlush(delayMs: number = FLUSH_DEBOUNCE_MS): void {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void flushNow().catch((err) =>
      console.warn("[timelapse] flush failed", err),
    );
  }, delayMs);
}

/**
 * Force an immediate flush. Returns the running promise if a flush is already
 * in progress so callers can await completion without racing the timer.
 */
export async function flushNow(): Promise<void> {
  if (state.flushPromise) return state.flushPromise;
  state.flushPromise = (async () => {
    // Bail out immediately when the recorder is disabled so an OFF project is
    // never contaminated by events that were queued for the previous project.
    if (!state.enabled) {
      state.queue = [];
      return;
    }
    if (state.initPromise) await state.initPromise;
    const projectId = state.projectId;
    if (!projectId) {
      state.queue = [];
      return;
    }
    if (state.queue.length === 0) return;

    const batch = state.queue;
    state.queue = [];

    const rows: Array<typeof changeEvents.$inferInsert> = [];
    const batchFirstSeq = state.lastSequence + 1;
    let seq = state.lastSequence;
    let prev = state.lastHash;
    for (const ev of batch) {
      seq += 1;
      const payloadStr = canonicalisePayload(ev.payload);
      const body = {
        projectId,
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
        prevHash: bytesToHex(prev),
        hash: bytesToHex(hash),
      });
      prev = hash;
    }

    try {
      await db.insert(changeEvents).values(rows);
      state.lastSequence = seq;
      state.lastHash = prev;
      state.flushRetries = 0;
    } catch (err) {
      // The insert did not resolve cleanly. Do NOT blindly re-queue the same
      // sequence numbers: on a UNIQUE collision (uq_change_events_project_seq)
      // that loops forever, and on a "committed in SQLite but the proxy promise
      // rejected" flush it would re-issue rows that already landed, which
      // double-applies doc.step on replay. Reconcile against the DB tail
      // (ground truth) instead.
      //
      // The desync that makes our seq collide is environmental: a second writer
      // racing the per-project counter (HMR-duplicated module state, a stray
      // `pnpm dev` tab, or multi-window — confirmed in the wild by interleaved
      // session_ids), or a committed-but-rejected flush. The file header notes
      // the true fix is a Rust-side allocator; this keeps the chain self-healing
      // for the single-process path.
      const tail = await readChainTail(projectId).catch(() => null);
      if (tail) {
        state.lastSequence = tail.sequence;
        state.lastHash = hexToBytes(tail.hash);
      }
      if (tail && tail.sequence >= batchFirstSeq) {
        // Slots [batchFirstSeq..seq] are already taken in the DB — our atomic
        // insert actually landed, or another writer owns them. Drop the batch:
        // the data is persisted (or owned), and re-queueing would collide
        // forever. Self-healed, so resolve without surfacing the error.
        state.flushRetries = 0;
        return;
      }
      // Nothing of ours committed (transient error). Cap the attempts so a
      // genuinely unrecoverable insert can't tight-loop, then re-queue with
      // backoff. Preserve order by prepending the original batch.
      state.flushRetries += 1;
      if (state.flushRetries > MAX_FLUSH_RETRIES) {
        console.warn(
          `[timelapse] dropping ${batch.length} event(s) after ${MAX_FLUSH_RETRIES} failed flush attempts`,
        );
        state.flushRetries = 0;
        return;
      }
      state.queue = batch.concat(state.queue);
      scheduleFlush(flushBackoffMs(state.flushRetries));
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
  // JSON.stringify(undefined) returns undefined (not a string); coerce to
  // "null" so the payload key is always present in the hash body.
  return JSON.stringify(p) ?? "null";
}

export type { VerifyResult };
export { verifyChain } from "./hashChain";
