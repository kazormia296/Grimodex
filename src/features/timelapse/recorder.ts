/**
 * 執筆タイムラプス recorder — append-only write window.
 *
 * All capture sites (Editor onTransaction, store actions, Map ops, ...) call
 * `recordChangeEvent()`. Events are queued in memory, then flushed through the
 * Rust-side allocator every ~100ms. Rust is the single authority for sequence
 * numbers, hash chaining, and insertion.
 */

import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import { debugLog } from "@/lib/debugLog";
import { isWorkspaceSwitchingError } from "@/features/concurrency/workspaceSwitching";
import type { VerifyResult } from "./hashChain";

const FLUSH_DEBOUNCE_MS = 100;

/**
 * How many consecutive failed flushes to tolerate before dropping the in-flight
 * batch. A genuinely unrecoverable insert (disk full, malformed row, ...) must
 * not tight-loop forever. Sequence/hash allocation is now Rust-owned, so a
 * resend after a transient or committed-but-rejected blip is idempotent — Rust
 * skips already-present `eventUid`s and appends only the new suffix — so the
 * retry just succeeds rather than colliding.
 */
const MAX_FLUSH_RETRIES = 10;

/**
 * Canonical recorded-domain union. This is the single source of truth — the
 * player filter (`TimelapsePlayer`) and query helpers (`queryEvents`) re-use it
 * so the set can never drift.
 *
 * Some domains are ALSO appended by the Rust `agent_writes` path (AI writes /
 * undo journal): `codex`, `snippet`, `event`, `foreshadow`, `prose`. TS UI
 * hooks reuse the SAME domain name for the human-driven code path — the two
 * paths are disjoint callers, so this is not double-recording. `prose` is
 * recorded ONLY by Rust; TS never calls `recordChangeEvent` for it — it lives
 * in the union purely for read/caption/player-filter parity.
 */
export type Domain =
  | "editor"
  | "codex"
  | "snippet"
  | "grid"
  | "map"
  | "synopsis"
  | "intent"
  | "beat"
  // P0 (§17): forward-only capture of the chat conversation flow and the
  // panel/layout/focus motion, so the timelapse video can show "writing in
  // Grimodex" rather than bare prose. These domains carry no doc.step; their
  // replay consumer is separate from the editor-body replayEngine.
  | "chat"
  | "layout"
  // Planning / annotation / version / per-project-config layers. All are
  // metadata domains (no doc.step) — replayEngine early-returns for them and
  // they surface only as caption text.
  | "event" // chronicle (matches Rust agent_writes domain)
  | "plot"
  | "foreshadow" // matches Rust agent_writes/undo-journal domain
  | "review" // impact-review baselines + post-effect annotations
  | "labels"
  | "abtest"
  | "prompt"
  | "import"
  | "mount" // external-mount IN (file → app) sync
  | "trash" // restore (delete already recorded via grid)
  | "settings" // per-project settings only
  | "project" // per-project meta
  | "lint"
  | "attribution"
  | "revision"
  | "prose"; // Rust-recorded only; union member for parity

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
  eventUid: string;
  timestamp: number;
}

interface TimelapseAppendEvent {
  eventUid: string;
  sceneId: string | null;
  domain: Domain;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  timestamp: number;
}

interface TimelapseAppendResult {
  tailSequence: number;
}

interface RecorderState {
  enabled: boolean;
  projectId: string | null;
  sessionId: string;
  /** Last allocated sequence for the current project (monotone). */
  lastSequence: number;
  queue: PendingEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<void> | null;
  /** Consecutive failed-flush count; gates retry backoff and the give-up cap. */
  flushRetries: number;
  initPromise: Promise<void> | null;
  /**
   * Workspace 切替中フラグ。true の間は新規イベントを破棄し flush も no-op。
   * 切替の quiesce (workspace/store.ts) が suspend し、新 workspace の
   * project rebind (projectStore.loadProject) が resume する。これが無いと、
   * 切替中に拒否された flush の re-queue + backoff が open 完了後に再試行され、
   * project id が両 workspace とも 'default-project' のため FK が通って
   * 旧イベントが新 workspace の hash chain へ恒久混入する (M3 review C1)。
   */
  suspended: boolean;
  /** suspend 中に破棄したイベント数 (resume 時にまとめて warn する)。 */
  droppedWhileSuspended: number;
  /**
   * suspend の世代番号。suspend のたびに増える。resumeRecorder(epoch) は
   * 現世代のみ有効 — 切替1の遅い resume が切替2の suspend を打ち消して
   * 切替中に記録が流れ出す (C1 再発) のを防ぐ (M3 review R4-1 系列D)。
   */
  suspendEpoch: number;
  /**
   * 最後に initRecorderForProject が完了した時点の suspendEpoch。
   * 冪等ガードのキーに使う — projectId だけをキーにすると、両 workspace とも
   * 'default-project' の最頻ケースで切替後の rebind が no-op になり、旧
   * workspace の tail が新 workspace の seed snapshot に anchorSequence
   * として焼かれる (M3 review R4-3)。
   */
  initEpoch: number;
}

const state: RecorderState = {
  // OFF by default so test environments don't write through the chain. The
  // app entry point (projectStore.loadProject) flips this on when binding
  // to a real project.
  enabled: false,
  projectId: null,
  sessionId: newSessionId(),
  lastSequence: 0,
  queue: [],
  flushTimer: null,
  flushPromise: null,
  flushRetries: 0,
  initPromise: null,
  suspended: false,
  droppedWhileSuspended: 0,
  suspendEpoch: 0,
  initEpoch: 0,
};

function newSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Read the current chain tail sequence for a project, or null when the project
 * has no events yet. Hash restoration is Rust-owned at append time.
 */
async function readChainTail(
  projectId: string,
): Promise<{ sequence: number } | null> {
  const last = await db
    .select({
      sequence: changeEvents.sequence,
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

/** Expose the current recorder session id for AI write primitives. */
export function getRecorderSessionId(): string {
  return state.sessionId;
}

/** Whether the recorder is currently writing through to the chain. */
export function isRecorderEnabled(): boolean {
  return state.enabled;
}

/**
 * Workspace 切替の quiesce から呼ぶ: 以後のイベント記録・flush を止め、
 * 旧 workspace 向けのキューと進行中の backoff 再試行を破棄する。
 * 切替を跨いだ flush 再試行が新 workspace の hash chain に旧イベントを
 * 混入させるのを防ぐ (C1)。resume するまで新規イベントは破棄される。
 *
 * 戻り値はこの suspend の世代番号。遅延して resume する経路 (rebind 完了 /
 * 失敗ロールバック) は必ずこれを resumeRecorder(epoch) に渡すこと — 古い
 * 世代の resume は無視され、後発の切替の suspend を打ち消さない (系列D)。
 */
export function suspendRecorderForWorkspaceSwitch(): number {
  state.suspendEpoch += 1;
  state.suspended = true;
  state.droppedWhileSuspended = 0;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.flushRetries = 0;
  if (state.queue.length > 0) {
    debugLog.warn(
      "timelapse",
      `workspace switch: dropping ${state.queue.length} queued event(s) for the old workspace`,
    );
  }
  state.queue = [];
  return state.suspendEpoch;
}

/** 現在の suspend 世代番号。遅延 resume する経路が entry 時に捕捉して使う。 */
export function getRecorderSuspendEpoch(): number {
  return state.suspendEpoch;
}

/**
 * suspend の解除。新 workspace の project rebind 完了後
 * (projectStore.loadProject) と、open_workspace 失敗時のロールバック
 * (workspace/store.ts) から呼ぶ。suspend されていなければ no-op。
 *
 * `epoch` を渡すと現世代の suspend のみ解除する (古い世代の遅延 resume は
 * 無視)。省略時は無条件に現在の suspend を解除する — 呼び出しと suspend の
 * 間に別の切替が割り込み得ない同期的な文脈でのみ省略してよい。
 */
export function resumeRecorder(epoch?: number): void {
  if (epoch !== undefined && epoch !== state.suspendEpoch) {
    // 古い切替の resume が後発の切替の suspend を打ち消すのを防ぐ (系列D)。
    return;
  }
  if (!state.suspended) return;
  state.suspended = false;
  if (state.droppedWhileSuspended > 0) {
    debugLog.warn(
      "timelapse",
      `workspace switch: dropped ${state.droppedWhileSuspended} event(s) recorded during the switch`,
    );
    state.droppedWhileSuspended = 0;
  }
}

/**
 * Bind the recorder to a project and resume the chain from the DB tail.
 *
 * Idempotent for the same projectId. Switching projects starts a fresh
 * in-memory session (sessionId changes). Rust reads the live DB tail again
 * during each append, so this only caches the latest tail sequence for UI
 * consumers.
 */
export async function initRecorderForProject(projectId: string): Promise<void> {
  // When the recorder is disabled (typical in tests), don't touch the DB —
  // mocked db harnesses don't need to mock the chain-tail SELECT and we
  // avoid leaking timers / promises across test files.
  if (!state.enabled) {
    state.projectId = projectId;
    state.initEpoch = state.suspendEpoch;
    // Clear any pending queue and timer so events from the prior project cannot
    // flush into this (OFF) project after a switch.
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.queue = [];
    return;
  }
  // 冪等ガードは projectId + suspend 世代の複合キー。workspace 切替 (suspend)
  // を跨いだら、同一 projectId ('default-project' 同士の切替が最頻) でも必ず
  // 再 init して新 workspace の tail / 新 sessionId を引き直す (R4-3)。
  if (
    state.projectId === projectId &&
    state.initEpoch === state.suspendEpoch &&
    state.initPromise
  ) {
    return state.initPromise;
  }
  state.projectId = projectId;
  state.initEpoch = state.suspendEpoch;
  state.sessionId = newSessionId();
  state.queue = [];

  state.initPromise = (async () => {
    const head = await readChainTail(projectId);
    if (head) {
      state.lastSequence = head.sequence;
    } else {
      state.lastSequence = 0;
    }
  })();
  return state.initPromise;
}

/**
 * Reset the in-memory chain head after wiping a project's change_events.
 * The next Rust append reads the empty DB tail and starts from genesis.
 *
 * Critically this nulls `initPromise` so a subsequent `initRecorderForProject`
 * for the SAME project does not short-circuit on its idempotency guard
 * (L105-107) and actually re-reads the now-empty tail. `enabled` / `projectId`
 * are left untouched — this is not a full teardown; the following
 * `initRecorderForProject` will mint a fresh sessionId.
 */
export function resetRecorderChain(): void {
  state.lastSequence = 0;
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
  state.queue = [];
  state.flushRetries = 0;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = null;
  state.flushPromise = null;
  state.initPromise = null;
  state.suspended = false;
  state.droppedWhileSuspended = 0;
  state.suspendEpoch = 0;
  state.initEpoch = 0;
}

/**
 * Queue an event for the current project. Cheap, non-blocking — the caller
 * never awaits the flush. If the recorder is disabled or no project bound
 * yet, the call is silently dropped.
 */
export function recordChangeEvent(input: RecordEventInput): void {
  if (state.suspended) {
    // workspace 切替中: どちらの workspace に属すべきか確定できないため破棄
    // (件数は resume 時にまとめて warn)。
    state.droppedWhileSuspended += 1;
    return;
  }
  if (!state.enabled || !state.projectId) return;
  state.queue.push({
    eventUid: crypto.randomUUID(),
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
  if (state.suspended) return;
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
    // Workspace 切替中は何も流さない (キューは suspend 時に破棄済み)。ここで
    // flush すると switching 拒否 → re-queue → open 完了後に新 workspace の
    // chain へ着地する (C1)。projectStore の rebind 前 drain もこの経路で
    // no-op になる。
    if (state.suspended) {
      state.queue = [];
      return;
    }
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

    const events: TimelapseAppendEvent[] = batch.map((ev) => ({
      eventUid: ev.eventUid,
      sceneId: ev.sceneId,
      domain: ev.domain,
      opType: ev.opType,
      entityType: ev.entityType,
      entityId: ev.entityId,
      payload: canonicalisePayload(ev.payload),
      timestamp: ev.timestamp,
    }));

    try {
      const result = await invoke<TimelapseAppendResult>(
        "timelapse_append_batch",
        {
          projectId,
          sessionId: state.sessionId,
          events,
        },
      );
      state.lastSequence = result.tailSequence;
      state.flushRetries = 0;
    } catch (err) {
      // workspace 切替拒否 (WORKSPACE_SWITCHING マーカー) は再送しない —
      // suspend と二重の防御。再送すると open 完了後に旧イベントが新
      // workspace の chain へ混入する (C1)。バッチは破棄して件数を warn。
      if (isWorkspaceSwitchingError(err)) {
        debugLog.warn(
          "timelapse",
          `workspace switching: dropping ${batch.length} event(s) instead of re-queueing`,
        );
        return;
      }
      // Rust owns sequence/hash allocation, so client-side UNIQUE collision
      // reconciliation is gone. Retry the same eventUid batch: if the command
      // committed but the transport rejected, Rust treats the resend as a no-op.
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
