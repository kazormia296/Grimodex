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
import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
import { isWorkspaceSwitchingError } from "@/features/concurrency/workspaceSwitching";
import { canCaptureTimelapseChangeEvent } from "@/application/lifecycle/quiescenceLease";
import {
  acquireExclusiveDocumentMutationLease,
  type ExclusiveDocumentMutationLease,
} from "@/features/editor/document/documentSaveCoordinator";
import {
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import type { VerifyResult } from "./hashChain";
import {
  abortTimelapseGenesisBarriers,
  awaitTimelapseGenesisBarrier,
  getTimelapseGenesisCaptureTargetProjectId,
} from "./genesisBarrier";

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
  /** Exact persistence kind for a scene body (database vs external file). */
  documentStorage?: "database" | "file";
  /** Original domain mutation time when a durable retry records it later. */
  timestamp?: number;
}

type PendingEventStatus = "reserved" | "committed";

interface PendingEvent {
  eventUid: string;
  domain: string;
  opType: string;
  projectId: string;
  payload: unknown;
  sceneId: string | null;
  entityType: string | null;
  entityId: string | null;
  timestamp: number;
  status: PendingEventStatus;
  reservationId: string | null;
  /** Non-null only for a renderer coverage sentinel in the global queue. */
  coverageClaimId: string | null;
  /** A materialized sentinel stays in memory until commit/cancel releases it. */
  coverageDurable: boolean;
  /** Scope key for reserved doc.step accounting. */
  documentStateKey: string | null;
}

export interface ChangeEventReservation {
  commit: () => void;
  discard: () => void;
}

interface TimelapseAppendEvent {
  eventUid: string;
  sceneId: string | null;
  domain: string;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  timestamp: number;
}

interface TimelapseAppendResult {
  tailSequence: number;
}

declare const timelapseDocumentRefBrand: unique symbol;
declare const timelapseAcceptedEnqueueBrand: unique symbol;

/** Opaque canonical-document authority minted only by an accepted doc.step. */
export interface TimelapseDocumentRef {
  readonly [timelapseDocumentRefBrand]: never;
}

/**
 * Structural identity of a canonical document. Unlike TimelapseDocumentRef,
 * this is safe to construct for a body whose capture failed: replacement
 * fences must still be able to target that body without minting a capability.
 */
export interface TimelapseDocumentIdentity {
  readonly projectId: string;
  readonly domain: Extract<Domain, "editor" | "codex" | "snippet">;
  readonly entityType: "scene" | "codex_entry" | "snippet";
  readonly entityId: string;
  /** Scene storage is part of the identity; non-scene documents omit it. */
  readonly storage?: "database" | "file";
}

/** Opaque receipt minted only after the event was actually pushed to queue. */
export interface TimelapseAcceptedEnqueueReceipt {
  readonly [timelapseAcceptedEnqueueBrand]: never;
  readonly document?: TimelapseDocumentRef;
}

export interface TimelapseDocStepCaptureReceipt extends TimelapseAcceptedEnqueueReceipt {
  readonly document: TimelapseDocumentRef;
}

export interface TimelapseCoverageProof {
  readonly eventUid: string;
  readonly sessionId: string;
  readonly contentDigest: string;
}

export interface TimelapseDocStepCoverageClaim {
  materialize: (content: string) => Promise<TimelapseCoverageProof>;
  commit: () => void;
  cancel: () => void;
}

export interface TimelapseReplacementFence {
  commit: () => void;
  release: () => void;
}

interface TimelapseDocumentScope {
  readonly projectId: string;
  readonly domain: Extract<Domain, "editor" | "codex" | "snippet">;
  readonly entityType: "scene" | "codex_entry" | "snippet";
  readonly entityId: string;
  readonly storage: "database" | "file";
}

interface TimelapseDocumentCoverageState {
  readonly key: string;
  readonly scope: TimelapseDocumentScope;
  ref: TimelapseDocumentRef;
  sessionId: string;
  acceptedPrefix: number;
  committedPrefix: number;
  durablePrefix: number;
  broken: boolean;
  activeClaim: ActiveCoverageClaim | null;
}

interface ActiveCoverageClaim {
  readonly coverageState: TimelapseDocumentCoverageState;
  readonly eventUid: string;
  readonly reservationId: string;
  readonly endPrefix: number;
  readonly sessionId: string;
  readonly queueEvent: PendingEvent;
  readonly previousClaims: readonly ActiveCoverageClaim[];
  readonly settledPromise: Promise<void>;
  readonly resolveSettled: () => void;
  materializePromise: Promise<TimelapseCoverageProof> | null;
  materialized: boolean;
  durable: boolean;
  settled: boolean;
}

interface ActiveReplacementFence {
  readonly projectId: string;
  readonly documentKey: string | null;
  readonly cutoffs: ReadonlyMap<TimelapseDocumentCoverageState, number>;
  readonly coordinatorLease: ExclusiveDocumentMutationLease | null;
  violated: boolean;
  committed: boolean;
  released: boolean;
}

const TIMELAPSE_INTERNAL_DOMAIN = "timelapse-internal";
const TIMELAPSE_COVERAGE_OP = "doc.step.coverage";
const documentCoverageStates = new Map<
  string,
  TimelapseDocumentCoverageState
>();
const documentRefScopes = new WeakMap<
  TimelapseDocumentRef,
  TimelapseDocumentCoverageState
>();
const activeReplacementFences = new Set<ActiveReplacementFence>();
const activeCoverageClaims: ActiveCoverageClaim[] = [];
const replacementFenceListeners = new Set<() => void>();

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
  /**
   * Generation of the in-memory queue authority. Lifecycle teardown advances
   * it before clearing the queue so an older in-flight Native append cannot
   * reinsert its failed batch into a new workspace/session.
   */
  queueGeneration: number;
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
  queueGeneration: 0,
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

/** Reversible renderer pause used only for an admitted lifecycle transition
 * that later proves the exact old LiveBinding Unchanged. A normal workspace
 * replacement uses invalidateWorkspaceBindingForLifecycle instead. */
let lifecyclePauseEpoch: number | null = null;
const lifecycleResumeWaiters = new Set<() => void>();

function resolveLifecycleResumeWaiters(): void {
  const waiters = [...lifecycleResumeWaiters];
  lifecycleResumeWaiters.clear();
  for (const resolve of waiters) resolve();
}

function waitForLifecycleResume(): Promise<void> {
  if (lifecyclePauseEpoch === null) return Promise.resolve();
  return new Promise((resolve) => lifecycleResumeWaiters.add(resolve));
}

function newSessionId(): string {
  return crypto.randomUUID();
}

function createTimelapseDocumentRef(): TimelapseDocumentRef {
  // The runtime value deliberately carries no document id. Callers can only
  // obtain one from a receipt minted after the recorder accepted a doc.step.
  return Object.freeze({}) as TimelapseDocumentRef;
}

function documentScopeKey(scope: TimelapseDocumentScope): string {
  return [
    scope.projectId,
    scope.domain,
    scope.entityType,
    scope.entityId,
    scope.storage,
  ].join("\u0000");
}

function documentScopeFromInput(
  input: Pick<
    RecordEventInput,
    | "domain"
    | "opType"
    | "projectId"
    | "entityType"
    | "entityId"
    | "documentStorage"
  >,
  projectId: string | null,
): TimelapseDocumentScope | null {
  if (input.opType !== "doc.step" || !projectId) return null;
  const entityId = input.entityId?.trim();
  if (!entityId) return null;
  switch (input.domain) {
    case "editor":
      if (input.entityType !== "scene") return null;
      if (
        input.documentStorage !== undefined &&
        input.documentStorage !== "database" &&
        input.documentStorage !== "file"
      ) {
        return null;
      }
      return {
        projectId,
        domain: "editor",
        entityType: "scene",
        entityId,
        storage: input.documentStorage ?? "database",
      };
    case "codex":
      return input.entityType === "codex_entry"
        ? {
            projectId,
            domain: "codex",
            entityType: "codex_entry",
            entityId,
            storage: "database",
          }
        : null;
    case "snippet":
      return input.entityType === "snippet"
        ? {
            projectId,
            domain: "snippet",
            entityType: "snippet",
            entityId,
            storage: "database",
          }
        : null;
    default:
      return null;
  }
}

function stateForDocumentScope(
  scope: TimelapseDocumentScope,
): TimelapseDocumentCoverageState {
  const key = documentScopeKey(scope);
  const existing = documentCoverageStates.get(key);
  if (existing) return existing;
  const stateForScope: TimelapseDocumentCoverageState = {
    key,
    scope,
    ref: createTimelapseDocumentRef(),
    sessionId: state.sessionId,
    acceptedPrefix: 0,
    committedPrefix: 0,
    durablePrefix: 0,
    broken: false,
    activeClaim: null,
  };
  documentCoverageStates.set(key, stateForScope);
  documentRefScopes.set(stateForScope.ref, stateForScope);
  return stateForScope;
}

/**
 * Target-owned steps may be captured while genesis activation still has the
 * previous recorder session in memory. Once the target rebind mints its new
 * session, transfer only that target's in-memory document authorities. Other
 * Project states are stale and must not survive the rebind.
 */
function rebindDocumentCoverageSession(projectId: string): void {
  for (const [key, coverageState] of documentCoverageStates) {
    if (coverageState.scope.projectId === projectId) {
      coverageState.sessionId = state.sessionId;
      continue;
    }
    documentCoverageStates.delete(key);
  }
}

function stateForDocumentRef(
  ref: TimelapseDocumentRef,
): TimelapseDocumentCoverageState | null {
  return documentRefScopes.get(ref) ?? null;
}

function countQueuedDocumentSteps(key: string): number {
  return state.queue.filter(
    (event) =>
      event.documentStateKey === key &&
      event.opType === "doc.step" &&
      event.coverageClaimId === null,
  ).length;
}

function createAcceptedReceipt(
  document: TimelapseDocumentRef | undefined,
): TimelapseAcceptedEnqueueReceipt {
  return Object.freeze(
    document ? { document } : ({} as { document?: TimelapseDocumentRef }),
  ) as TimelapseAcceptedEnqueueReceipt;
}

function createDocumentStepReceipt(
  document: TimelapseDocumentRef,
): TimelapseDocStepCaptureReceipt {
  return Object.freeze({ document }) as TimelapseDocStepCaptureReceipt;
}

function markDocumentScopeBroken(scope: TimelapseDocumentScope): void {
  stateForDocumentScope(scope).broken = true;
}

function markDocumentInputBroken(input: RecordEventInput): void {
  if (input.opType !== "doc.step") return;
  // OFF is a lifecycle reset, not an active capture epoch. Do not recreate a
  // broken state merely because a stale editor emitted one transaction after
  // the reset; its accumulator has already been invalidated independently.
  if (!state.enabled) return;
  const projectId =
    input.projectId ??
    getTimelapseGenesisCaptureTargetProjectId() ??
    state.projectId;
  const scope = documentScopeFromInput(input, projectId);
  // A fence intentionally rejects transactions while preserving the previous
  // epoch for a later replacement retry. This is admission denial, not a
  // capture gap, so do not poison the document state here.
  if (scope && !replacementFenceMatchesScope(scope.projectId, scope)) {
    markDocumentScopeBroken(scope);
  }
}

function documentKeyForScope(scope: TimelapseDocumentScope): DocumentKey {
  switch (scope.domain) {
    case "editor":
      return {
        kind: "tree",
        id: scope.entityId,
        storage: scope.storage,
      };
    case "codex":
      return { kind: "codex", id: scope.entityId, phaseId: null };
    case "snippet":
      return { kind: "snippet", id: scope.entityId };
  }
}

function scopeFromIdentity(
  identity: TimelapseDocumentIdentity,
): TimelapseDocumentScope | null {
  if (
    !identity ||
    typeof identity !== "object" ||
    typeof identity.projectId !== "string" ||
    typeof identity.entityId !== "string"
  ) {
    return null;
  }
  const projectId = identity.projectId.trim();
  const entityId = identity.entityId.trim();
  if (!projectId || !entityId) return null;
  switch (identity.domain) {
    case "editor": {
      if (identity.entityType !== "scene") return null;
      const storage = identity.storage ?? "database";
      if (storage !== "database" && storage !== "file") return null;
      return {
        projectId,
        domain: "editor",
        entityType: "scene",
        entityId,
        storage,
      };
    }
    case "codex":
      if (
        identity.entityType !== "codex_entry" ||
        (identity.storage !== undefined && identity.storage !== "database")
      ) {
        return null;
      }
      return {
        projectId,
        domain: "codex",
        entityType: "codex_entry",
        entityId,
        storage: "database",
      };
    case "snippet":
      if (
        identity.entityType !== "snippet" ||
        (identity.storage !== undefined && identity.storage !== "database")
      ) {
        return null;
      }
      return {
        projectId,
        domain: "snippet",
        entityType: "snippet",
        entityId,
        storage: "database",
      };
    default:
      return null;
  }
}

function scopeMatchesDocumentKey(
  scope: TimelapseDocumentScope,
  documentKey: string,
): boolean {
  return encodeDocumentKey(documentKeyForScope(scope)) === documentKey;
}

function replacementFenceMatchesScope(
  projectId: string,
  scope: TimelapseDocumentScope | null,
): boolean {
  for (const fence of activeReplacementFences) {
    if (fence.released || fence.projectId !== projectId) continue;
    if (fence.documentKey === null) return true;
    if (scope && scopeMatchesDocumentKey(scope, fence.documentKey)) return true;
  }
  return false;
}

function documentCaptureIsBroken(
  scope: TimelapseDocumentScope | null,
): boolean {
  return scope
    ? (documentCoverageStates.get(documentScopeKey(scope))?.broken ?? false)
    : false;
}

function notifyReplacementFenceListeners(): void {
  for (const listener of [...replacementFenceListeners]) {
    try {
      listener();
    } catch {
      // UI observers are advisory; a notification failure must not leave a
      // replacement lease or coordinator count unreleased.
    }
  }
}

function settleCoverageClaim(claim: ActiveCoverageClaim): void {
  if (claim.settled) return;
  claim.settled = true;
  if (claim.coverageState.activeClaim === claim) {
    claim.coverageState.activeClaim = null;
  }
  const index = activeCoverageClaims.indexOf(claim);
  if (index >= 0) activeCoverageClaims.splice(index, 1);
  claim.resolveSettled();
}

function removeCoverageSentinel(claim: ActiveCoverageClaim): void {
  state.queue = state.queue.filter((event) => event !== claim.queueEvent);
}

/**
 * Invalidate every renderer-owned coverage/fence authority at a lifecycle
 * boundary. Durable rows remain audit history, but an uncommitted coverage row
 * is deliberately not allowed to authorize a new workspace/session.
 */
function invalidateCoverageAuthorities(): void {
  state.queueGeneration += 1;
  for (const claim of [...activeCoverageClaims]) {
    claim.coverageState.broken = true;
    removeCoverageSentinel(claim);
    settleCoverageClaim(claim);
  }
  activeCoverageClaims.length = 0;

  for (const coverageState of documentCoverageStates.values()) {
    coverageState.broken = true;
    coverageState.activeClaim = null;
  }
  documentCoverageStates.clear();

  for (const fence of [...activeReplacementFences]) {
    fence.released = true;
    fence.coordinatorLease?.release();
    activeReplacementFences.delete(fence);
  }
  notifyReplacementFenceListeners();
}

/** Mark one known document's capture epoch broken without manufacturing a ref. */
export function breakTimelapseDocumentCapture(
  target: TimelapseDocumentIdentity | TimelapseDocumentRef,
): void {
  const refState = stateForDocumentRef(target as TimelapseDocumentRef);
  if (refState) {
    refState.broken = true;
    return;
  }
  const scope = scopeFromIdentity(target as TimelapseDocumentIdentity);
  if (scope) markDocumentScopeBroken(scope);
}

function scopeFromDocumentKey(
  projectId: string,
  documentKey: DocumentKey,
): TimelapseDocumentScope | null {
  switch (documentKey.kind) {
    case "tree":
      return {
        projectId,
        domain: "editor",
        entityType: "scene",
        entityId: documentKey.id,
        storage: documentKey.storage,
      };
    case "codex":
      if (documentKey.phaseId !== null) return null;
      return {
        projectId,
        domain: "codex",
        entityType: "codex_entry",
        entityId: documentKey.id,
        storage: "database",
      };
    case "snippet":
      return {
        projectId,
        domain: "snippet",
        entityType: "snippet",
        entityId: documentKey.id,
        storage: "database",
      };
    case "chronicle-event":
      return null;
  }
}

export function isTimelapseReplacementFenceActive(options: {
  projectId: string;
  document?: TimelapseDocumentIdentity;
}): boolean {
  const scope = options.document ? scopeFromIdentity(options.document) : null;
  return replacementFenceMatchesScope(options.projectId, scope);
}

/** Exact DocumentKey query used by editor admission/UI lease consumers. */
export function isTimelapseReplacementFenceActiveForDocument(
  projectId: string,
  documentKey: DocumentKey | null,
): boolean {
  const scope = documentKey
    ? scopeFromDocumentKey(projectId, documentKey)
    : null;
  return replacementFenceMatchesScope(projectId, scope);
}

export function subscribeTimelapseReplacementFence(
  listener: () => void,
): () => void {
  replacementFenceListeners.add(listener);
  return () => replacementFenceListeners.delete(listener);
}

/**
 * @internal Dormant while public body writers run fail-closed full snapshots.
 *
 * Reserve the exact prefix represented by an accepted doc.step stream. The
 * reservation is inserted into the one recorder queue synchronously; callers
 * may therefore safely start a body write before any later editor transaction
 * can overtake the coverage event. A future sealed Native-owned route may
 * re-enable this optimization; renderer-facing paths must not use it as
 * snapshot authority.
 */
export function claimTimelapseDocStepCoverage(
  ref: TimelapseDocumentRef,
): TimelapseDocStepCoverageClaim | null {
  const coverageState = stateForDocumentRef(ref);
  if (!coverageState) return null;
  if (
    coverageState.broken ||
    coverageState.activeClaim ||
    coverageState.acceptedPrefix <= coverageState.committedPrefix ||
    state.switchInProgress ||
    state.bindingInvalidated ||
    !state.enabled ||
    state.projectId !== coverageState.scope.projectId ||
    replacementFenceMatchesScope(
      coverageState.scope.projectId,
      coverageState.scope,
    )
  ) {
    return null;
  }

  // A flush removes its batch from the in-memory queue while Native is
  // awaiting. Claiming in that interval would make the prefix accounting
  // ambiguous, so let the central runner retry after the flush settles.
  if (state.flushPromise) return null;
  // A reserved event is an unsealed gap. This includes chat reservations and
  // prevents a coverage sentinel from being placed behind an unresolved turn.
  if (
    state.queue.some(
      (event) => event.status === "reserved" && event.coverageClaimId === null,
    )
  ) {
    return null;
  }
  if (coverageState.durablePrefix < coverageState.committedPrefix) return null;
  const unflushedSteps = Math.max(
    0,
    coverageState.acceptedPrefix - coverageState.durablePrefix,
  );
  if (countQueuedDocumentSteps(coverageState.key) < unflushedSteps) {
    return null;
  }

  const eventUid = crypto.randomUUID();
  const reservationId = crypto.randomUUID();
  let resolveSettled!: () => void;
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const queueEvent: PendingEvent = {
    eventUid,
    domain: TIMELAPSE_INTERNAL_DOMAIN,
    opType: TIMELAPSE_COVERAGE_OP,
    projectId: coverageState.scope.projectId,
    payload: null,
    sceneId:
      coverageState.scope.domain === "editor"
        ? coverageState.scope.entityId
        : null,
    entityType: coverageState.scope.entityType,
    entityId: coverageState.scope.entityId,
    timestamp: Date.now(),
    status: "reserved",
    reservationId,
    coverageClaimId: eventUid,
    coverageDurable: false,
    documentStateKey: coverageState.key,
  };
  const claim: ActiveCoverageClaim = {
    coverageState,
    eventUid,
    reservationId,
    endPrefix: coverageState.acceptedPrefix,
    sessionId: coverageState.sessionId,
    queueEvent,
    previousClaims: [...activeCoverageClaims],
    settledPromise,
    resolveSettled,
    materializePromise: null,
    materialized: false,
    durable: false,
    settled: false,
  };
  coverageState.activeClaim = claim;
  activeCoverageClaims.push(claim);
  state.queue.push(queueEvent);

  const materialize = (content: string): Promise<TimelapseCoverageProof> => {
    if (claim.materializePromise) return claim.materializePromise;
    claim.materializePromise = (async () => {
      if (
        claim.settled ||
        claim.coverageState.activeClaim !== claim ||
        claim.coverageState.broken ||
        state.sessionId !== claim.sessionId ||
        state.projectId !== claim.coverageState.scope.projectId
      ) {
        throw new Error("Timelapse coverage claim is no longer active");
      }
      // The global chain waits for every earlier document claim, not just a
      // claim for this document. This closes the A/B cross-document bypass.
      await Promise.all(
        claim.previousClaims.map((previous) => previous.settledPromise),
      );
      if (claim.coverageState.broken || claim.settled) {
        throw new Error("Timelapse coverage claim was invalidated");
      }
      const digestBuffer = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(content),
      );
      const digest = `sha256:${Array.from(new Uint8Array(digestBuffer))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`;
      queueEvent.payload = { resultContentDigest: digest };
      queueEvent.status = "committed";
      queueEvent.reservationId = null;
      claim.materialized = true;
      await flushNow();
      if (!claim.durable || claim.coverageState.activeClaim !== claim) {
        throw new Error("Timelapse coverage event was not durably flushed");
      }
      return Object.freeze({
        eventUid: claim.eventUid,
        sessionId: claim.sessionId,
        contentDigest: digest,
      });
    })().catch((error: unknown) => {
      // A failed append leaves the accepted prefix untouched. The caller's
      // finally/cancel path removes the reservation; a later claim can retry
      // with a fresh event UID and the exact same prefix.
      claim.materializePromise = null;
      throw error;
    });
    return claim.materializePromise;
  };

  const commit = (): void => {
    if (claim.settled || !claim.materialized || !claim.durable) return;
    claim.coverageState.committedPrefix = Math.max(
      claim.coverageState.committedPrefix,
      claim.endPrefix,
    );
    removeCoverageSentinel(claim);
    settleCoverageClaim(claim);
    if (state.queue.some((event) => event.status === "committed")) {
      scheduleFlush();
    }
  };

  const cancel = (): void => {
    if (claim.settled) return;
    removeCoverageSentinel(claim);
    settleCoverageClaim(claim);
    if (state.queue.some((event) => event.status === "committed")) {
      scheduleFlush();
    }
  };

  return { materialize, commit, cancel };
}

/**
 * Publish a replacement admission fence before the first await. The optional
 * document is structural on purpose; a failed capture still has a known
 * document identity and must be fenceable without a capability.
 */
export function acquireTimelapseReplacementFence(options: {
  projectId: string;
  document?: TimelapseDocumentIdentity;
}): TimelapseReplacementFence {
  const projectId = options.projectId.trim();
  if (!projectId)
    throw new Error("Timelapse replacement fence needs a project");
  const scope = options.document ? scopeFromIdentity(options.document) : null;
  if (options.document && (!scope || scope.projectId !== projectId)) {
    throw new Error(
      "Timelapse replacement fence has mismatched document authority",
    );
  }
  const documentKey = scope
    ? encodeDocumentKey(documentKeyForScope(scope))
    : null;
  const cutoffs = new Map<TimelapseDocumentCoverageState, number>();
  for (const coverageState of documentCoverageStates.values()) {
    if (
      coverageState.scope.projectId === projectId &&
      (documentKey === null ||
        encodeDocumentKey(documentKeyForScope(coverageState.scope)) ===
          documentKey)
    ) {
      cutoffs.set(coverageState, coverageState.acceptedPrefix);
    }
  }
  const coordinatorLease = scope
    ? acquireExclusiveDocumentMutationLease(documentKeyForScope(scope))
    : null;
  const fence: ActiveReplacementFence = {
    projectId,
    documentKey,
    cutoffs,
    coordinatorLease,
    violated: false,
    committed: false,
    released: false,
  };
  // This insertion and coordinator lease notification are intentionally
  // synchronous: transaction admission can observe the fence immediately.
  activeReplacementFences.add(fence);
  notifyReplacementFenceListeners();

  return {
    commit() {
      if (fence.released || fence.committed) return;
      fence.committed = true;
      fence.coordinatorLease?.commit();
      for (const [coverageState, cutoff] of fence.cutoffs) {
        coverageState.broken = false;
        coverageState.durablePrefix = Math.max(
          coverageState.durablePrefix,
          cutoff,
        );
        coverageState.committedPrefix = Math.max(
          coverageState.committedPrefix,
          cutoff,
        );
      }
    },
    release() {
      if (fence.released) return;
      fence.released = true;
      activeReplacementFences.delete(fence);
      fence.coordinatorLease?.release();
      notifyReplacementFenceListeners();
      if (state.queue.some((event) => event.status === "committed")) {
        scheduleFlush();
      }
    },
  };
}

function claimForQueueEvent(event: PendingEvent): ActiveCoverageClaim | null {
  if (!event.coverageClaimId) return null;
  return (
    activeCoverageClaims.find((claim) => claim.eventUid === event.eventUid) ??
    null
  );
}

function coveragePrefixBoundary(): number | null {
  const firstCoverageIndex = state.queue.findIndex(
    (event) => event.coverageClaimId !== null,
  );
  if (firstCoverageIndex < 0) return null;
  const event = state.queue[firstCoverageIndex]!;
  if (event.status === "reserved" || !event.coverageDurable) {
    return firstCoverageIndex + (event.status === "committed" ? 1 : 0);
  }
  // A durable sentinel is deliberately retained as the queue head while its
  // body write is in flight. It is not a reason to flush the suffix.
  return 0;
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

/** Read the durable Native/DB chain tail after renderer queues are flushed. */
export async function readAuthoritativeChainTail(
  projectId: string,
): Promise<number> {
  return (await readChainTail(projectId))?.sequence ?? 0;
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
  if (!enabled) {
    invalidateCoverageAuthorities();
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    // OFF is authoritative even when a caller toggles it without first
    // awaiting the normal strict disable path. An old in-flight append is
    // guarded by queueGeneration and cannot repopulate this queue on failure.
    state.queue = [];
    state.flushRetries = 0;
  }
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
  resolveLifecycleResumeWaiters();
  lifecyclePauseEpoch = null;
  abortTimelapseGenesisBarriers("Workspace switch started");
  invalidateCoverageAuthorities();
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
 * Invalidate the current binding after a Native lifecycle transition that did
 * not originate from the foreground open flow (for example maintenance
 * recovery). This deliberately does not acquire or release a workspace
 * switch lease and never resumes the old binding; the next explicit open and
 * normal recorder initialization must establish a new session.
 */
export function invalidateWorkspaceBindingForLifecycle(): void {
  resolveLifecycleResumeWaiters();
  lifecyclePauseEpoch = null;
  abortTimelapseGenesisBarriers("Workspace lifecycle binding invalidated");
  invalidateCoverageAuthorities();
  state.switchEpoch += 1;
  state.switchInProgress = false;
  state.bindingInvalidated = true;
  state.droppedWhileInvalidated = 0;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.flushRetries = 0;
  state.queue = [];
}

/**
 * Pause capture for a lifecycle Transition without destroying the current
 * queue, coverage authorities, or genesis barriers. Native may still prove
 * that the exact old authority survived (Unchanged); in that case the saved
 * scope can resume without pretending that a Ready event alone re-bound it.
 */
export function pauseWorkspaceBindingForLifecycle(): void {
  if (lifecyclePauseEpoch !== null) return;
  lifecyclePauseEpoch = state.switchEpoch;
  state.switchInProgress = true;
  state.bindingInvalidated = true;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
}

/** Resume the exact paused recorder scope after a proven Unchanged result. */
export function resumeWorkspaceBindingAfterLifecycleUnchanged(): boolean {
  if (lifecyclePauseEpoch === null || lifecyclePauseEpoch !== state.switchEpoch) {
    return false;
  }
  lifecyclePauseEpoch = null;
  resolveLifecycleResumeWaiters();
  state.switchInProgress = false;
  state.bindingInvalidated = false;
  if (state.queue.some((event) => event.status === "committed")) {
    scheduleFlush();
  }
  return true;
}

/**
 * Resume the recorder after an explicit Open has published the operation's
 * exact Native lifecycle proof and the replacement scope has been hydrated.
 *
 * This is deliberately separate from the Unchanged path: a successful Open
 * may publish a new authority instance, so it must never be described as a
 * proof that the old binding survived.  The operation-specific proof and the
 * normal recorder rebind have already established the new scope; this helper
 * only retires a reversible Transition pause that raced that Open.
 */
export function resumeWorkspaceBindingAfterExplicitOpen(): boolean {
  if (lifecyclePauseEpoch === null) return true;
  if (lifecyclePauseEpoch !== state.switchEpoch) return false;
  lifecyclePauseEpoch = null;
  resolveLifecycleResumeWaiters();
  state.switchInProgress = false;
  state.bindingInvalidated = false;
  if (state.queue.some((event) => event.status === "committed")) {
    scheduleFlush();
  }
  return true;
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

  const queueBelongsToTarget = state.queue.every(
    (event) => event.projectId === projectId,
  );
  if (state.queue.length > 0 && !queueBelongsToTarget) {
    throw new Error(
      `Timelapse recorder refused to rebind to Project ${projectId} with queued events from another authority`,
    );
  }

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
    // OFF is authoritative: explicitly discard target events captured while
    // the setting was still unknown during background activation.
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
    const bound = await state.initPromise;
    // A failed genesis leaves the target queue intact, but its debounce timer
    // has already observed the failed barrier and stopped. Same-Project retry
    // intentionally reuses this resolved binding, so wake the retained queue
    // here instead of waiting for an unrelated future edit or strict close.
    if (bound && state.queue.some((event) => event.status === "committed")) {
      scheduleFlush();
    }
    return bound;
  }
  const entryEpoch = state.switchEpoch;
  state.projectId = projectId;
  state.initEpoch = state.switchEpoch;
  state.sessionId = newSessionId();
  rebindDocumentCoverageSession(projectId);

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
    if (state.queue.some((event) => event.status === "committed")) {
      scheduleFlush();
    }
    return true;
  })().catch((error: unknown) => {
    if (state.initPromise === self) state.initPromise = null;
    throw error;
  });
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
  invalidateCoverageAuthorities();
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
  resolveLifecycleResumeWaiters();
  lifecyclePauseEpoch = null;
  abortTimelapseGenesisBarriers("recorder test reset");
  invalidateCoverageAuthorities();
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
  if (!canCaptureTimelapseChangeEvent()) return false;
  const captureTarget = getTimelapseGenesisCaptureTargetProjectId();
  if (captureTarget) {
    if (
      !state.enabled ||
      state.switchInProgress ||
      (input.projectId !== undefined && input.projectId !== captureTarget)
    ) {
      return false;
    }
    if (!state.queue.every((event) => event.projectId === captureTarget)) {
      return false;
    }
    const scope = documentScopeFromInput(input, captureTarget);
    return (
      !documentCaptureIsBroken(scope) &&
      !replacementFenceMatchesScope(captureTarget, scope)
    );
  }
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
  if (!state.enabled || state.projectId === null) return false;
  const scope = documentScopeFromInput(input, state.projectId);
  return (
    !documentCaptureIsBroken(scope) &&
    !replacementFenceMatchesScope(state.projectId, scope)
  );
}

function createPendingEvent(
  input: RecordEventInput,
  status: PendingEventStatus,
  reservationId: string | null,
): PendingEvent {
  const projectId =
    input.projectId ??
    getTimelapseGenesisCaptureTargetProjectId() ??
    state.projectId;
  if (!projectId) {
    throw new Error("Timelapse recorder is not bound to a Project");
  }
  const scope = documentScopeFromInput(input, projectId);
  const documentStateKey = scope ? stateForDocumentScope(scope).key : null;
  return {
    eventUid: crypto.randomUUID(),
    domain: input.domain,
    opType: input.opType,
    projectId,
    payload: input.payload,
    sceneId: input.sceneId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    timestamp: input.timestamp ?? Date.now(),
    status,
    reservationId,
    coverageClaimId: null,
    coverageDurable: false,
    documentStateKey,
  };
}

function acceptPendingDocumentStep(event: PendingEvent): void {
  if (!event.documentStateKey || event.opType !== "doc.step") return;
  const coverageState = documentCoverageStates.get(event.documentStateKey);
  if (!coverageState) return;
  coverageState.acceptedPrefix += 1;
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
        acceptPendingDocumentStep(event);
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

export function recordChangeEvent(
  input: RecordEventInput,
): TimelapseAcceptedEnqueueReceipt | null {
  if (!canCaptureChangeEvent(input)) {
    markDocumentInputBroken(input);
    return null;
  }
  const event = createPendingEvent(input, "committed", null);
  state.queue.push(event);
  acceptPendingDocumentStep(event);
  scheduleFlush();
  const coverageState = event.documentStateKey
    ? documentCoverageStates.get(event.documentStateKey)
    : undefined;
  return coverageState
    ? createDocumentStepReceipt(coverageState.ref)
    : createAcceptedReceipt(undefined);
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
    const queueGeneration = state.queueGeneration;
    if (state.switchInProgress && lifecyclePauseEpoch !== null) {
      // A reversible lifecycle pause owns the current binding until Native
      // proves Unchanged. Preserve the queued old-scope events; clearing them
      // here would turn a temporary Transition into data loss.
      return;
    }
    if (state.switchInProgress) {
      state.queue = [];
      return;
    }
    const projectId = state.queue[0]?.projectId;
    if (!projectId) return;
    if (state.queue.some((event) => event.projectId !== projectId)) {
      throw new Error(
        "Timelapse recorder queue contains mixed Project authority",
      );
    }

    // The queue's captured Project is the authority. During activation it can
    // intentionally differ from the old recorder binding; only genesis release
    // may let it proceed to the new binding.
    await awaitTimelapseGenesisBarrier(projectId);
    if (state.initPromise) await state.initPromise;
    if (state.queueGeneration !== queueGeneration) return;
    if (
      state.bindingInvalidated ||
      state.projectId !== projectId ||
      !state.enabled
    ) {
      const captureTarget = getTimelapseGenesisCaptureTargetProjectId();
      if (!state.enabled && captureTarget !== projectId) {
        state.queue = [];
        return;
      }
      throw new Error(
        `Timelapse recorder binding is not authoritative for Project ${projectId}`,
      );
    }

    const firstReservedIndex = state.queue.findIndex(
      (event) => event.status === "reserved",
    );
    const coverageBoundary = coveragePrefixBoundary();
    const ordinaryBoundary =
      firstReservedIndex === -1 ? state.queue.length : firstReservedIndex;
    const batchEnd =
      coverageBoundary === null
        ? ordinaryBoundary
        : Math.min(ordinaryBoundary, coverageBoundary);
    if (batchEnd === 0) return;
    const batch = state.queue.slice(0, batchEnd);
    state.queue = state.queue.slice(batchEnd);

    let events: TimelapseAppendEvent[];
    try {
      events = batch.map((ev) => ({
        eventUid: ev.eventUid,
        sceneId: ev.sceneId,
        domain: ev.domain,
        opType: ev.opType,
        entityType: ev.entityType,
        entityId: ev.entityId,
        payload: canonicalisePayload(ev.payload),
        timestamp: ev.timestamp,
      }));
    } catch (error) {
      state.queue = batch.concat(state.queue);
      for (const event of batch) {
        if (!event.documentStateKey) continue;
        documentCoverageStates.get(event.documentStateKey)!.broken = true;
      }
      throw error;
    }

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
      if (state.queueGeneration !== queueGeneration) return;
      state.flushRetries = 0;
      const durableCoverage = batch.find(
        (event) => event.coverageClaimId !== null,
      );
      for (const event of batch) {
        if (event.opType !== "doc.step" || !event.documentStateKey) continue;
        const coverageState = documentCoverageStates.get(
          event.documentStateKey,
        );
        if (coverageState) coverageState.durablePrefix += 1;
      }
      if (durableCoverage) {
        durableCoverage.coverageDurable = true;
        const claim = claimForQueueEvent(durableCoverage);
        if (claim) {
          claim.durable = true;
          state.queue = [durableCoverage, ...state.queue];
        }
      }
    } catch (err) {
      // A lifecycle reset may have cleared this batch while Native was in
      // flight. Never reinsert that old-authority batch into the new queue;
      // the append itself, if it completed, remains durable audit history.
      if (state.queueGeneration !== queueGeneration) return;
      if (isWorkspaceSwitchingError(err)) {
        // The lifecycle may have paused the binding after this flush removed
        // its batch from the queue. Keep that in-flight batch until the exact
        // old binding is proven Unchanged; only an irreversible invalidation
        // (which clears `lifecyclePauseEpoch` and advances queueGeneration)
        // may discard it.
        if (state.strictFlushWaiters > 0 || lifecyclePauseEpoch !== null) {
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
      if (lifecyclePauseEpoch !== null) {
        await waitForLifecycleResume();
        continue;
      }
      await flushNow();
      if (lifecyclePauseEpoch !== null) continue;
      if (state.queue.length === 0 && state.flushPromise === null) {
        completed = true;
        return;
      }
      if (state.queue.some((event) => event.coverageClaimId !== null)) {
        throw new Error(
          "Timelapse recorder has an active document coverage barrier",
        );
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
  invalidateCoverageAuthorities();
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = null;
  state.queue = [];
  state.flushRetries = 0;
}

registerQuiescenceProvider({
  id: createQuiescenceProviderId("timelapse-recorder"),
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
