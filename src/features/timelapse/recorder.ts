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
import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";
import { isWorkspaceSwitchingError } from "@/features/concurrency/workspaceSwitching";
import type { VerifyResult } from "./hashChain";

const FLUSH_DEBOUNCE_MS = 100;

/**
 * How many consecutive failed automatic flushes to tolerate before pausing
 * retries. A genuinely unrecoverable insert (disk full, malformed row, ...)
 * must not tight-loop forever, but the in-memory batch is retained so close /
 * Project / Workspace quiescence can report the failure and retry. Sequence/hash
 * allocation is now Rust-owned, so a
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
   * Owning project when the mutation targets an explicit project. Events for
   * a project other than the recorder's current binding are discarded rather
   * than contaminating the active project's hash chain.
   */
  projectId?: string;
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
  /** Original domain mutation time when a durable retry records it later. */
  timestamp?: number;
}

type PendingEventStatus = "reserved" | "committed";

interface PendingEvent extends Omit<Required<RecordEventInput>, "timestamp"> {
  eventUid: string;
  timestamp: number;
  status: PendingEventStatus;
  reservationId: string | null;
}

export interface ChangeEventReservation {
  commit: () => void;
  discard: () => void;
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

/**
 * Workspace 切替まわりの recorder 状態機械 (M3 review r5)。
 *
 * 記録可否は単一の不変条件で決まる:
 *
 *     recording可 ⟺ bound(enabled ∧ projectId≠null) ∧ ¬bindingInvalidated ∧ ¬switchInProgress
 *
 * 「resume」という命令は存在しない。束縛を有効化する唯一の経路は
 * `initRecorderForProject`(正規 rebind) であり、切替中・世代跨ぎ・旧 init は
 * 束縛を書けない。これにより「resume したが束縛が誤り」「他人の切替を解除」
 * という命令的 resume の穴 (r4 で反証されたもの) が構造的に不可能になる。
 *
 * 遷移一覧:
 * - beginWorkspaceSwitch():  switchInProgress=true, bindingInvalidated=true,
 *   switchEpoch++, キュー破棄 + backoff キャンセル。
 * - endWorkspaceSwitch({restoreBinding}): switchInProgress=false。
 *   restoreBinding=true (切替失敗 = swap 未実行で旧束縛が依然正しい) のときのみ
 *   bindingInvalidated=false。成功時は invalidated のまま = init 完了まで記録停止。
 * - initRecorderForProject(): 切替中 (switchInProgress) は abort、完了時に
 *   世代 (switchEpoch) が entry から進んでいたら abort、自分が現行 init で
 *   なければ state を書かない。成功時のみ束縛を書き bindingInvalidated=false。
 */
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
  /**
   * Active destructive-lifecycle drains. A strict waiter promotes an already
   * running automatic append to lossless failure handling.
   */
  strictFlushWaiters: number;
  /** 現行 init。resolve 値は「束縛を書いたか」(bystander/世代跨ぎ abort = false)。 */
  initPromise: Promise<boolean> | null;
  /**
   * workspace 切替の実行中 (beginWorkspaceSwitch 〜 endWorkspaceSwitch)。
   * true の間は記録・flush を止め、bystander init も束縛を書けない。
   */
  switchInProgress: boolean;
  /**
   * 束縛 (projectId / lastSequence / sessionId) が現在の workspace に対して
   * 有効でない。切替開始で true になり、正規 rebind (initRecorderForProject)
   * の完了、または切替失敗時の endWorkspaceSwitch({restoreBinding:true})
   * だけが false に戻す。true の間のイベントは warn 付きで破棄 — 誤った束縛で
   * 新 workspace の hash chain に旧イベントを混入させる (C1) よりも
   * 「記録しない」が正しい。
   */
  bindingInvalidated: boolean;
  /** 束縛無効中に破棄したイベント数 (初回は即 warn、以降は再束縛時にまとめて warn)。 */
  droppedWhileInvalidated: number;
  /**
   * workspace 切替の世代番号 (beginWorkspaceSwitch のたびに増える)。
   * init は entry で捕捉した世代と完了時の世代が一致するときだけ束縛を書く。
   */
  switchEpoch: number;
  /**
   * 最後に束縛を書いた init の switchEpoch。冪等ガードのキーに使う —
   * projectId だけをキーにすると、両 workspace とも 'default-project' の
   * 最頻ケースで切替後の rebind が no-op になり、旧 workspace の tail が
   * 新 workspace の seed snapshot に anchorSequence として焼かれる (R4-3)。
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
  strictFlushWaiters: 0,
  initPromise: null,
  switchInProgress: false,
  bindingInvalidated: false,
  droppedWhileInvalidated: 0,
  switchEpoch: 0,
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

/** 束縛無効中に破棄した件数のまとめ warn (再束縛/復元の時点で出す)。 */
function reportDroppedWhileInvalidated(): void {
  if (state.droppedWhileInvalidated > 0) {
    debugLog.warn(
      "timelapse",
      `workspace switch: dropped ${state.droppedWhileInvalidated} event(s) recorded before the project rebind completed`,
    );
    state.droppedWhileInvalidated = 0;
  }
}

/**
 * Workspace 切替の開始。openWorkspace が quiesce 直後・invoke 前に呼ぶ。
 * 以後のイベント記録・flush を止め、旧 workspace 向けのキューと進行中の
 * backoff 再試行を破棄する (切替を跨いだ flush 再試行が新 workspace の
 * hash chain へ旧イベントを混入させる C1 の防止)。
 *
 * 併せて束縛を無効化 (bindingInvalidated=true) する。切替後の記録再開は
 * 「命令」ではなく、正規 rebind (initRecorderForProject) の完了だけが束縛を
 * 有効に戻す。戻り値は新しい切替世代 (テスト/診断用)。
 */
export function beginWorkspaceSwitch(): number {
  state.switchEpoch += 1;
  state.switchInProgress = true;
  state.bindingInvalidated = true;
  state.droppedWhileInvalidated = 0;
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
  return state.switchEpoch;
}

/**
 * Workspace 切替の終了。openWorkspace が swap (open_workspace invoke) を
 * 括る finally で成功/失敗の両方で必ず呼ぶ (openWorkspaceInFlight ガードに
 * より begin/end は厳密に交互)。swap の成否確定より広い区間を括らないこと —
 * set({view}) 以降まで switchInProgress を保つと、React の EditorScreen
 * mount が走らせる正規 rebind が bystander と誤判定される。
 *
 * - `restoreBinding: true` は「swap が実行されなかった失敗」(open_workspace
 *   invoke が失敗し旧 workspace 続行) のときのみ渡す — 旧束縛は依然正しい
 *   ので記録をそのまま再開する。
 * - 成功時 (および swap 後の後続処理の失敗時) は bindingInvalidated=true の
 *   まま = 正規 rebind (initRecorderForProject) が完了するまで記録は再開
 *   しない。「resume したが束縛が誤り」を構造的に排除するための非対称。
 */
export function endWorkspaceSwitch(options?: {
  restoreBinding?: boolean;
}): void {
  state.switchInProgress = false;
  if (options?.restoreBinding) {
    state.bindingInvalidated = false;
    reportDroppedWhileInvalidated();
  }
}

/**
 * Bind the recorder to a project and resume the chain from the DB tail.
 *
 * Idempotent for the same projectId within the same switch generation.
 * Switching projects starts a fresh in-memory session (sessionId changes).
 * Rust reads the live DB tail again during each append, so this only caches
 * the latest tail sequence for UI consumers.
 *
 * **束縛を有効化する唯一の経路** (状態機械コメント参照)。戻り値は
 * 「束縛を書いたか」— 切替中の bystander init / 完了時に世代が進んでいた
 * 旧 init は state を書かず false を返す (呼び出し側はその場合 seed
 * snapshot 等の anchorSequence 依存処理を行ってはならない)。
 */
export async function initRecorderForProject(
  projectId: string,
): Promise<boolean> {
  // 切替中の bystander init は束縛を書かない。切替が終われば正規 rebind
  // (loadProject) が改めて init する。
  if (state.switchInProgress) return false;

  // When the recorder is disabled (typical in tests), don't touch the DB —
  // mocked db harnesses don't need to mock the chain-tail SELECT and we
  // avoid leaking timers / promises across test files.
  if (!state.enabled) {
    state.projectId = projectId;
    state.initEpoch = state.switchEpoch;
    // disabled でも束縛自体は書けたことにする (記録可否は enabled 側が閉じる)。
    // これで後から toggle-ON → init される流れでも invalidated が残らない。
    state.bindingInvalidated = false;
    // 過去の enabled init の promise を残すと、後の enabled init が複合キー
    // 一致で stale promise を short-circuit し、旧 workspace の tail を束縛に
    // 使い続ける理論穴がある (r5 Minor-3)。disabled バインドは tail を読まない
    // ので必ず破棄し、次の enabled init に tail を引き直させる。
    state.initPromise = null;
    reportDroppedWhileInvalidated();
    // Clear any pending queue and timer so events from the prior project cannot
    // flush into this (OFF) project after a switch.
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.queue = [];
    return true;
  }
  // 冪等ガードは projectId + 切替世代の複合キー。workspace 切替を跨いだら、
  // 同一 projectId ('default-project' 同士の切替が最頻) でも必ず再 init して
  // 新 workspace の tail / 新 sessionId を引き直す (R4-3)。
  if (
    state.projectId === projectId &&
    state.initEpoch === state.switchEpoch &&
    state.initPromise
  ) {
    return state.initPromise;
  }
  const entryEpoch = state.switchEpoch;
  state.projectId = projectId;
  state.initEpoch = state.switchEpoch;
  state.sessionId = newSessionId();
  state.queue = [];

  // 自己参照用ホルダー: IIFE の最初の await より後で読むため、下の代入は
  // 必ず完了している (TS の use-before-assign を避けるため let + null 初期化)。
  let self: Promise<boolean> | null = null;
  const init = (async (): Promise<boolean> => {
    const head = await readChainTail(projectId);
    // 自分が現行 init でなければ state を書かない — 旧 init の遅延 resolve が
    // 新 init の lastSequence を clobber するのを防ぐ (r5 Minor-2)。
    if (state.initPromise !== self) return false;
    // 完了時に切替世代が進んでいた / 切替中なら束縛を書かない — 旧 workspace
    // の tail を新 workspace の束縛として有効化しない (r5 契約 (c)(d))。
    if (state.switchEpoch !== entryEpoch || state.switchInProgress) {
      return false;
    }
    state.lastSequence = head ? head.sequence : 0;
    state.bindingInvalidated = false;
    reportDroppedWhileInvalidated();
    return true;
  })();
  self = init;
  state.initPromise = init;
  return init;
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
  state.strictFlushWaiters = 0;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = null;
  state.flushPromise = null;
  state.initPromise = null;
  state.switchInProgress = false;
  state.bindingInvalidated = false;
  state.droppedWhileInvalidated = 0;
  state.switchEpoch = 0;
  state.initEpoch = 0;
}

/**
 * Queue an event for the current project. Cheap, non-blocking — the caller
 * never awaits the flush. If the recorder is disabled or no project bound
 * yet, the call is silently dropped.
 */
function canCaptureChangeEvent(input: RecordEventInput): boolean {
  if (input.projectId && input.projectId !== state.projectId) return false;
  if (state.switchInProgress || state.bindingInvalidated) {
    // 束縛が無効 (切替中 or 正規 rebind 未完了): 誤った束縛で新 workspace の
    // hash chain へ混入させるより破棄が正しい。ただし無警告にしない —
    // 初回は即 warn、以降は件数を集計して再束縛時にまとめて warn する。
    if (state.droppedWhileInvalidated === 0) {
      debugLog.warn(
        "timelapse",
        "workspace 切替後 project 未ロードのため timelapse イベントを破棄中 (プロジェクトを開き直すと再開する)",
      );
    }
    state.droppedWhileInvalidated += 1;
    return false;
  }
  return state.enabled && state.projectId !== null;
}

function createPendingEvent(
  input: RecordEventInput,
  status: PendingEventStatus,
  reservationId: string | null,
): PendingEvent {
  if (!state.projectId) {
    throw new Error("Timelapse recorder is not bound to a Project");
  }
  return {
    eventUid: crypto.randomUUID(),
    domain: input.domain,
    opType: input.opType,
    projectId: state.projectId,
    payload: input.payload,
    sceneId: input.sceneId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    timestamp: input.timestamp ?? Date.now(),
    status,
    reservationId,
  };
}

/**
 * Reserves one contiguous position in the forward-only Chronicle without
 * making the events flushable. This lets a completed Chat turn retain its
 * original order while its durable rows are retried. A reservation must be
 * committed only after the source mutation is durable, or discarded when the
 * source payload is explicitly abandoned.
 */
export function reserveChangeEvents(
  inputs: readonly RecordEventInput[],
): ChangeEventReservation {
  if (
    inputs.length === 0 ||
    !inputs.every((input) => canCaptureChangeEvent(input))
  ) {
    return {
      commit() {},
      discard() {},
    };
  }

  const reservationId = crypto.randomUUID();
  state.queue.push(
    ...inputs.map((input) =>
      createPendingEvent(input, "reserved", reservationId),
    ),
  );
  let active = true;
  return {
    commit() {
      if (!active) return;
      active = false;
      let committed = false;
      for (const event of state.queue) {
        if (event.reservationId !== reservationId) continue;
        event.status = "committed";
        event.reservationId = null;
        committed = true;
      }
      if (committed) scheduleFlush();
    },
    discard() {
      if (!active) return;
      active = false;
      const retained = state.queue.filter(
        (event) => event.reservationId !== reservationId,
      );
      if (retained.length === state.queue.length) return;
      state.queue = retained;
      if (state.queue.some((event) => event.status === "committed")) {
        scheduleFlush();
      }
    },
  };
}

export function recordChangeEvent(input: RecordEventInput): void {
  if (!canCaptureChangeEvent(input)) return;
  state.queue.push({
    ...createPendingEvent(input, "committed", null),
  });
  scheduleFlush();
}

function scheduleFlush(delayMs: number = FLUSH_DEBOUNCE_MS): void {
  if (state.switchInProgress || state.bindingInvalidated) return;
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void flushNow().catch((_error) => {
      debugLog.warn("timelapse", "flush failed", {
        sensitivity: "safe",
        fields: {
          operation: "flush",
          outcome: "failed",
        },
      });
    });
  }, delayMs);
}

/**
 * Force an immediate flush. Returns the running promise if a flush is already
 * in progress so callers can await completion without racing the timer.
 */
export async function flushNow(): Promise<void> {
  if (state.flushPromise) return state.flushPromise;
  state.flushPromise = (async () => {
    // 切替中・束縛無効中は何も流さない (キューは beginWorkspaceSwitch で
    // 破棄済み)。ここで flush すると switching 拒否 → re-queue → open 完了後に
    // 新 workspace の chain へ着地する (C1)。projectStore の rebind 前 drain
    // もこの経路で no-op になる。
    if (state.switchInProgress || state.bindingInvalidated) {
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

    const firstReservedIndex = state.queue.findIndex(
      (event) => event.status === "reserved",
    );
    const batchEnd =
      firstReservedIndex === -1 ? state.queue.length : firstReservedIndex;
    if (batchEnd === 0) return;
    const batch = state.queue.slice(0, batchEnd);
    state.queue = state.queue.slice(batchEnd);

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
      // beginWorkspaceSwitch の束縛無効化と二重の防御。再送すると open 完了後
      // に旧イベントが新 workspace の chain へ混入する (C1)。バッチは破棄して
      // 件数を warn。
      if (isWorkspaceSwitchingError(err)) {
        if (state.strictFlushWaiters > 0) {
          state.queue = batch.concat(state.queue);
          debugLog.warn(
            "timelapse",
            `workspace switching: retaining ${batch.length} event(s) for strict lifecycle recovery`,
          );
          throw err;
        }
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
        state.queue = batch.concat(state.queue);
        state.flushRetries = MAX_FLUSH_RETRIES;
        console.warn(
          `[timelapse] pausing automatic retry for ${batch.length} event(s) after ${MAX_FLUSH_RETRIES} failed flush attempts`,
        );
        throw err;
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

/**
 * Destructive-lifecycle drain. It also catches events queued while a previous
 * flush was in flight and never treats the retry cap as permission to discard.
 */
export async function flushStrict(): Promise<void> {
  state.strictFlushWaiters += 1;
  let completed = false;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  try {
    for (let round = 0; round < 50; round++) {
      await flushNow();
      if (state.queue.length === 0 && state.flushPromise === null) {
        completed = true;
        return;
      }
      if (state.queue[0]?.status === "reserved") {
        throw new Error(
          "Timelapse recorder has an unresolved event reservation",
        );
      }
    }
    throw new Error("Timelapse recorder did not reach quiescence");
  } finally {
    state.strictFlushWaiters = Math.max(0, state.strictFlushWaiters - 1);
    // Preserve strict recovery material until an explicit retry. Otherwise an
    // older debounce/backoff timer could wake after this waiter releases and
    // apply the automatic WORKSPACE_SWITCHING drop policy to the retained batch.
    if (!completed && state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
  }
}

function discardPendingTimelapseEvents(): void {
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = null;
  state.queue = [];
  state.flushRetries = 0;
}

registerQuiescenceProvider({
  id: "timelapse-recorder",
  stage: "timelapse",
  flush: flushStrict,
  discard: discardPendingTimelapseEvents,
  recovery: () =>
    state.queue
      .filter((event) => event.status === "committed")
      .map((event) => ({
        kind: "timelapse-event",
        projectId: event.projectId,
        eventUid: event.eventUid,
        sceneId: event.sceneId,
        domain: event.domain,
        opType: event.opType,
        entityType: event.entityType,
        entityId: event.entityId,
        payload: event.payload,
        timestamp: event.timestamp,
      })),
});

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
