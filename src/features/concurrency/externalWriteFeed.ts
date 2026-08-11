import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { and, eq, gt, ne, asc, desc } from "drizzle-orm";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import {
  useGlobalHistoryStore,
  setUndoConflictHandler,
  setHistoryReplayGuard,
  type HistoryCommand,
  type HistoryKind,
} from "@/store/globalHistoryStore";
import {
  guardInlineAiPending,
  isInlineAiPending,
} from "@/features/editor/inlineAi/pendingGuard";
import { useExternalWriteStore } from "./externalWriteStore";
import {
  useProseStagingStore,
  type PendingProseProposal,
} from "@/features/agent-writes/proseStagingStore";
import { loadLatestProposedProse } from "@/features/agent-writes/prose";
import { scheduleImeExportRefresh } from "@/features/ime/scheduler";
import type { DocumentKey } from "@/features/editor/document/documentKey";
import { getExternalWriteProjectors } from "@/application/externalWrites/externalWriteProjectors";
import { isIpcLifecycleCancellation } from "@/lib/tauri";
import {
  parseChangePayload,
  payloadString,
  payloadStringArray,
} from "./changeEventPayload";

const POLL_MS = 750;

/**
 * Optional handler for incoming MCP/agent prose proposals (headless auto-apply).
 * Injected via {@link setProseProposalHandler} so this low-level concurrency
 * module need not import the heavy auto-apply graph (persistSceneBody → editor
 * side-effects), mirroring the setUndoConflictHandler decoupling above. Returns
 * true if it consumed the proposal (auto-applied) — then it is NOT enqueued into
 * the human review UI; false falls back to the existing diff-UI enqueue.
 */
type ProseProposalHandler = (
  proposal: PendingProseProposal,
  projectId: string,
  isAuthoritative: () => boolean,
) => boolean | Promise<boolean>;

let proseProposalHandler: ProseProposalHandler | null = null;

export function setProseProposalHandler(fn: ProseProposalHandler | null): void {
  proseProposalHandler = fn;
}

/**
 * Surface a failed (version-conflict) undo/redo to the user. Defined here — not
 * in globalHistoryStore — so the low-level history store need not import
 * tabStore / externalWriteStore (which would form a module-init cycle with
 * projectStore→treeStore; see setUndoConflictHandler in globalHistoryStore).
 * Registered at module load: externalWriteFeed is imported by projectStore, so
 * the handler is wired before any undo can run in the app.
 */
function domainForHistoryKind(kind: HistoryKind): string | null {
  switch (kind) {
    case "codex":
      return "codex";
    case "phase":
      return "codex";
    case "snippets":
      return "snippet";
    case "scenes":
      return "grid";
    case "chronicle":
      return "event";
    default:
      return null;
  }
}

function handleUndoConflict(cmd: HistoryCommand): void {
  const entityId = cmd.entityId;
  const domain = domainForHistoryKind(cmd.kind);
  if (!entityId || !domain) return;
  const extStore = useExternalWriteStore.getState();
  const documentKey: DocumentKey | null =
    cmd.documentKey ??
    (cmd.kind === "codex"
      ? { kind: "codex", id: entityId, phaseId: null }
      : cmd.kind === "snippets"
        ? { kind: "snippet", id: entityId }
        : cmd.kind === "chronicle"
          ? { kind: "chronicle-event", id: entityId }
          : cmd.kind === "scenes"
            ? { kind: "tree", id: entityId, storage: "database" }
            : null);
  if (!documentKey) return;
  const editorState = useEditorSessionStore.getState();
  const dirty =
    typeof editorState.isDocumentDirty === "function"
      ? editorState.isDocumentDirty(documentKey)
      : editorState.dirtyDocumentIds.has(documentKey.id);
  if (dirty || isInlineAiPending()) {
    extStore.pushConflict({
      documentKey,
      sceneId: documentKey.id,
      domain,
      opType: "undo.version_conflict",
      entityId,
    });
  } else {
    extStore.bumpReloadNonce(documentKey);
  }
}

setUndoConflictHandler(handleUndoConflict);

// Veto global undo/redo while an inline-AI diff is pending. Replaying history
// would rebuild the active editor doc out from under the un-accepted generated
// text (data loss). Registered at module load alongside the conflict handler so
// it is wired before any undo can run. Same leaf-DI rationale: globalHistoryStore
// must not import the inline-AI layer directly.
setHistoryReplayGuard(() => guardInlineAiPending());

interface PollerState {
  projectId: string | null;
  cursor: number;
  timer: ReturnType<typeof setInterval> | null;
  generation: number;
}

const state: PollerState = {
  projectId: null,
  cursor: 0,
  timer: null,
  generation: 0,
};

interface FeedAuthority {
  projectId: string;
  generation: number;
}

let pollInFlightToken: symbol | null = null;

type ChangeEventRow = typeof changeEvents.$inferSelect;

function captureFeedAuthority(): FeedAuthority | null {
  return state.projectId
    ? { projectId: state.projectId, generation: state.generation }
    : null;
}

function isCurrentFeedAuthority(authority: FeedAuthority): boolean {
  return (
    state.projectId === authority.projectId &&
    state.generation === authority.generation
  );
}

async function readTailSequence(projectId: string): Promise<number> {
  const rows = await db
    .select({ sequence: changeEvents.sequence })
    .from(changeEvents)
    .where(eq(changeEvents.projectId, projectId))
    .orderBy(desc(changeEvents.sequence))
    .limit(1);
  return rows[0]?.sequence ?? 0;
}

function invalidateHistoryForEntity(
  entityType: string | null,
  entityId: string | null,
): void {
  if (!entityId) return;
  const history = useGlobalHistoryStore.getState();
  // Best-effort: external write on a tracked entity invalidates fragile closures.
  const kind =
    entityType === "codex_entry"
      ? "codex"
      : entityType === "snippet"
        ? "snippets"
        : entityType === "tree_batch"
          ? "scenes"
          : entityType === "event"
            ? "chronicle"
            : null;
  if (!kind) return;
  history.invalidateForEntity(kind, entityId);
}

type ChronicleBulkEventKind =
  | "eventDelete"
  | "eventClearDate"
  | "eventSetLane"
  | "eventSetDate";

interface ChronicleBulkChangeTargets {
  direction: "initial" | "undo" | "redo";
  events: ReadonlyMap<string, ChronicleBulkEventKind | "eventUpdate">;
  sceneIds: ReadonlySet<string>;
  relatedEventIds: ReadonlySet<string>;
}

/**
 * A Chronicle bulk write owns multiple Event and Scene targets while the
 * change_events row itself is journal-addressed. Decode the explicit target
 * metadata so one row can fan out to every affected projection and history
 * command. The id arrays are retained as a forward-compatible fallback if a
 * newer native operation kind reaches an older renderer.
 */
function parseChronicleBulkChangeTargets(
  event: ChangeEventRow,
): ChronicleBulkChangeTargets | null {
  if (
    event.domain !== "event" ||
    event.opType !== "chronicle.bulk" ||
    event.entityType !== "chronicle_bulk"
  ) {
    return null;
  }
  const payload = parseChangePayload(event.payload);
  if (!payload) return null;

  const directionValue = payload.direction;
  const direction =
    directionValue === "undo" || directionValue === "redo"
      ? directionValue
      : "initial";
  const eventTargets = new Map<
    string,
    ChronicleBulkEventKind | "eventUpdate"
  >();
  const sceneIds = new Set(payloadStringArray(payload, "sceneIds"));
  const operations = payload.operations;
  if (Array.isArray(operations)) {
    for (const value of operations) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const operation = value as Record<string, unknown>;
      const kind = operation.kind;
      const eventId = operation.eventId;
      if (
        (kind === "eventDelete" ||
          kind === "eventClearDate" ||
          kind === "eventSetLane" ||
          kind === "eventSetDate") &&
        typeof eventId === "string" &&
        eventId.length > 0
      ) {
        eventTargets.set(eventId, kind);
      }
      const sceneId = operation.sceneId;
      if (
        (kind === "sceneClearDate" ||
          kind === "sceneSetPov" ||
          kind === "sceneSetDate") &&
        typeof sceneId === "string" &&
        sceneId.length > 0
      ) {
        sceneIds.add(sceneId);
      }
    }
  }
  for (const eventId of payloadStringArray(payload, "eventIds")) {
    if (!eventTargets.has(eventId)) {
      eventTargets.set(eventId, "eventUpdate");
    }
  }

  return {
    direction,
    events: eventTargets,
    sceneIds,
    relatedEventIds: new Set(payloadStringArray(payload, "relatedEventIds")),
  };
}

function chronicleBulkDocumentOpType(
  kind: ChronicleBulkEventKind | "eventUpdate",
  direction: ChronicleBulkChangeTargets["direction"],
): string {
  if (kind === "eventDelete") {
    return direction === "undo" ? "event.create" : "event.delete";
  }
  return "event.update";
}

/**
 * Relation/stamp change rows represent aggregate metadata, not an editor
 * document-body update. They therefore must not enter notifyEditorDocument,
 * but they still invalidate every local undo closure whose assumptions the
 * metadata write changed.
 *
 * The tracked writers store the cause/event in entity_id and the stamped scene
 * in scene_id. Their JSON payload carries the otherwise-unaddressable relation
 * effect. Prefer those typed columns and use payload only for missing metadata;
 * a malformed payload must never stop the external-write poll.
 */
function invalidateEventMetadataHistory(event: ChangeEventRow): void {
  if (event.domain !== "event") return;

  if (event.opType === "event.create" || event.opType === "event.delete") {
    const payload = parseChangePayload(event.payload);
    const eventIds = new Set([
      event.entityId,
      ...payloadStringArray(payload, "relatedEventIds"),
    ]);
    for (const eventId of eventIds) {
      invalidateHistoryForEntity("event", eventId);
    }
    return;
  }

  if (
    event.opType === "event.relation_add" ||
    event.opType === "event.relation_remove"
  ) {
    const payload = parseChangePayload(event.payload);
    const causeEventId =
      event.entityId ?? payloadString(payload, "causeEventId");
    const effectEventId = payloadString(payload, "effectEventId");
    const eventIds = new Set([causeEventId, effectEventId]);
    for (const eventId of eventIds) {
      invalidateHistoryForEntity("event", eventId);
    }
    return;
  }

  if (event.opType === "event.stamp" || event.opType === "event.unstamp") {
    const payload = parseChangePayload(event.payload);
    const eventId = event.entityId ?? payloadString(payload, "eventId");
    const sceneIds = new Set([
      event.sceneId ?? payloadString(payload, "sceneId"),
      ...payloadStringArray(payload, "sceneIds"),
    ]);
    invalidateHistoryForEntity("event", eventId);
    for (const sceneId of sceneIds) {
      invalidateHistoryForEntity("tree_batch", sceneId);
    }
  }
}

function isDocumentDirty(documentKey: DocumentKey): boolean {
  const state = useEditorSessionStore.getState();
  return typeof state.isDocumentDirty === "function"
    ? state.isDocumentDirty(documentKey)
    : state.dirtyDocumentIds.has(documentKey.id);
}

function notifyEditorDocument(
  documentKey: DocumentKey,
  event: ChangeEventRow,
  inlineAiPending: boolean,
): void {
  const extStore = useExternalWriteStore.getState();
  if (isDocumentDirty(documentKey) || inlineAiPending) {
    extStore.pushConflict({
      documentKey,
      sceneId: documentKey.id,
      domain: event.domain,
      opType: event.opType,
      entityId: event.entityId,
    });
  } else {
    extStore.bumpReloadNonce(documentKey);
  }
}

function eventChangesDocumentAggregate(event: ChangeEventRow): boolean {
  return (
    event.entityType === "event" &&
    (event.opType === "event.create" ||
      event.opType === "event.update" ||
      event.opType === "event.participants" ||
      event.opType === "event.delete")
  );
}

async function fanOut(
  events: ChangeEventRow[],
  projectId: string,
  isAuthoritative: () => boolean,
): Promise<void> {
  if (!isAuthoritative()) return;
  const projectors = getExternalWriteProjectors();
  const domains = new Set(events.map((e) => e.domain));
  const bulkTargets = new Map<ChangeEventRow, ChronicleBulkChangeTargets>();
  for (const event of events) {
    const targets = parseChronicleBulkChangeTargets(event);
    if (targets) bulkTargets.set(event, targets);
  }

  if (
    domains.has("grid") ||
    [...bulkTargets.values()].some((targets) => targets.sceneIds.size > 0)
  ) {
    await useTreeStore.getState().reloadTreeOrThrow(projectId);
    if (!isAuthoritative()) return;
  }
  if (domains.has("codex")) {
    await useCodexStore.getState().loadEntries();
    if (!isAuthoritative()) return;
    scheduleImeExportRefresh(projectId);
  }
  if (domains.has("snippet")) {
    await useSnippetStore.getState().loadEntries();
    if (!isAuthoritative()) return;
  }
  if (domains.has("foreshadow")) {
    if (!isAuthoritative()) return;
    await projectors.reloadForeshadows(projectId);
    if (!isAuthoritative()) return;
  }
  // 以下 3 ドメインは metadata 系（Rust agent_writes / MCP が記録する）。
  // 従来 fanOut は grid/codex/snippet/foreshadow の 4 ドメインしか反映せず、
  // 別プロセス（MCP 等）が年表(event)・プロット・ラベルを書いても UI が stale
  // なままだった。各ドメインの再ロード権威に合わせて反映する。再ロードは
  // application-owned projector boundary に委譲し、この transport が各 feature
  // store を直接 import しないようにする。
  if (domains.has("event")) {
    // Chronicle は revisionCounter を購読して listEvents を再クエリするため
    // bumpRevision が再ロードのトリガ（ChroniclePanel useEffect deps）。
    if (!isAuthoritative()) return;
    projectors.bumpChronicleRevision();
  }
  if (domains.has("plot")) {
    if (!isAuthoritative()) return;
    useGlobalHistoryStore.getState().invalidateKind("plot");
    await projectors.reloadPlotThreads(projectId);
    if (!isAuthoritative()) return;
  }
  if (domains.has("labels")) {
    if (!isAuthoritative()) return;
    await projectors.reloadLabels(projectId);
    if (!isAuthoritative()) return;
  }

  if (!isAuthoritative()) return;
  const editorEvents = events.filter(
    (e) => e.domain === "editor" && e.sceneId != null,
  );
  const inlineAiPending = isInlineAiPending();

  for (const ev of editorEvents) {
    if (!isAuthoritative()) return;
    const sceneId = ev.sceneId!;
    invalidateHistoryForEntity(ev.entityType, ev.entityId);
    notifyEditorDocument(
      { kind: "tree", id: sceneId, storage: "database" },
      ev,
      inlineAiPending,
    );
  }

  const proseProposals = events.filter(
    (e) => e.domain === "prose" && e.opType === "prose.propose" && e.sceneId,
  );
  const proseSceneIds = [...new Set(proseProposals.map((e) => e.sceneId!))];
  for (const sceneId of proseSceneIds) {
    if (!isAuthoritative()) return;
    try {
      const proposal = await loadLatestProposedProse(sceneId);
      if (!isAuthoritative()) return;
      if (!proposal) continue;
      if (proseProposalHandler) {
        let consumed = false;
        try {
          consumed = await proseProposalHandler(
            proposal,
            projectId,
            isAuthoritative,
          );
          if (!isAuthoritative()) return;
        } catch (err) {
          console.warn("[externalWriteFeed] prose auto-apply failed", err);
        }
        if (!isAuthoritative()) return;
        if (consumed) continue;
      }
      if (!isAuthoritative()) return;
      useProseStagingStore.getState().enqueue(proposal);
    } catch {
      // ignore load failures; user can reopen scene to retry
    }
  }

  for (const ev of events) {
    if (!isAuthoritative()) return;
    const chronicleBulk = bulkTargets.get(ev);
    if (chronicleBulk) {
      for (const [eventId, kind] of chronicleBulk.events) {
        invalidateHistoryForEntity("event", eventId);
        notifyEditorDocument(
          { kind: "chronicle-event", id: eventId },
          {
            ...ev,
            entityType: "event",
            entityId: eventId,
            opType: chronicleBulkDocumentOpType(kind, chronicleBulk.direction),
          },
          inlineAiPending,
        );
      }
      for (const eventId of chronicleBulk.relatedEventIds) {
        invalidateHistoryForEntity("event", eventId);
      }
      for (const sceneId of chronicleBulk.sceneIds) {
        invalidateHistoryForEntity("tree_batch", sceneId);
      }
    }
    invalidateEventMetadataHistory(ev);
    if (ev.entityType === "codex_entry" && ev.entityId) {
      invalidateHistoryForEntity(ev.entityType, ev.entityId);
      notifyEditorDocument(
        { kind: "codex", id: ev.entityId, phaseId: null },
        ev,
        inlineAiPending,
      );
    }
    if (ev.entityType === "snippet" && ev.entityId) {
      invalidateHistoryForEntity(ev.entityType, ev.entityId);
      notifyEditorDocument(
        { kind: "snippet", id: ev.entityId },
        ev,
        inlineAiPending,
      );
    }
    if (eventChangesDocumentAggregate(ev) && ev.entityId) {
      invalidateHistoryForEntity(ev.entityType, ev.entityId);
      notifyEditorDocument(
        { kind: "chronicle-event", id: ev.entityId },
        ev,
        inlineAiPending,
      );
    }
  }
}

async function fetchExternalRows(
  projectId: string,
  cursor: number,
  sessionId: string,
): Promise<ChangeEventRow[]> {
  return db
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.projectId, projectId),
        gt(changeEvents.sequence, cursor),
        ne(changeEvents.sessionId, sessionId),
      ),
    )
    .orderBy(asc(changeEvents.sequence));
}

async function pollTick(
  requestedAuthority: FeedAuthority | null = captureFeedAuthority(),
): Promise<void> {
  if (
    !requestedAuthority ||
    !isCurrentFeedAuthority(requestedAuthority) ||
    pollInFlightToken
  ) {
    return;
  }

  const authority = requestedAuthority;
  const { projectId } = authority;
  const cursor = state.cursor;
  const inFlightToken = Symbol("external-write-poll");
  pollInFlightToken = inFlightToken;
  const isAuthoritative = (): boolean =>
    pollInFlightToken === inFlightToken && isCurrentFeedAuthority(authority);

  // Everything below runs inside one try/catch. pollTick is fired via
  // `void pollTick()` in setInterval, so ANY throw here (including the DB reads,
  // not just fan-out) escapes as a [Global] unhandled rejection. In particular
  // db_execute can hit ipcQueue's 10s timeout when a native modal dialog blocks
  // IPC dispatch — e.g. the save dialog at the end of a timelapse export. Swallow
  // + log and retain state.cursor (only advanced on success) so the next tick
  // retries the same range instead of crashing the poll or dropping events.
  try {
    const sessionId = getRecorderSessionId();
    let rows = await fetchExternalRows(projectId, cursor, sessionId);
    if (!isAuthoritative()) return;

    if (rows.length === 0) {
      const tail = await readTailSequence(projectId);
      if (!isAuthoritative()) return;
      if (tail > cursor) {
        // Re-fetch once: events may have landed between the first query and tail read.
        rows = await fetchExternalRows(projectId, cursor, sessionId);
        if (!isAuthoritative()) return;
        if (rows.length === 0) {
          if (!isAuthoritative()) return;
          state.cursor = tail;
        }
      }
      if (rows.length === 0) return;
    }

    await fanOut(rows, projectId, isAuthoritative);
    if (!isAuthoritative()) return;
    state.cursor = rows[rows.length - 1].sequence;
  } catch (err) {
    if (!isIpcLifecycleCancellation(err)) {
      console.warn("[externalWriteFeed] poll failed; cursor retained", err);
    }
  } finally {
    if (pollInFlightToken === inFlightToken) {
      pollInFlightToken = null;
    }
  }
}

/** Start polling external change_events for the given project. */
export async function startExternalWriteFeed(projectId: string): Promise<void> {
  stopExternalWriteFeed();
  const authority: FeedAuthority = {
    projectId,
    generation: state.generation,
  };
  state.projectId = projectId;
  const cursor = await readTailSequence(projectId);
  if (!isCurrentFeedAuthority(authority)) return;
  state.cursor = cursor;
  useExternalWriteStore.getState().clear();
  state.timer = setInterval(() => {
    void pollTick(authority);
  }, POLL_MS);
}

/** Stop polling (project switch / workspace close). */
export function stopExternalWriteFeed(): void {
  state.generation += 1;
  // The transport read cannot be aborted, but relinquishing this ownership
  // token lets the replacement feed poll immediately. The old tick's finally
  // block cannot clear a newer tick's token.
  pollInFlightToken = null;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.projectId = null;
  state.cursor = 0;
  useExternalWriteStore.getState().clear();
}

/** Test hook: run fan-out for explicit events (no DB). */
export async function processExternalEventsForTest(
  events: ChangeEventRow[],
  projectId: string,
): Promise<void> {
  state.projectId = projectId;
  const authority = captureFeedAuthority();
  if (!authority) return;
  await fanOut(events, projectId, () => isCurrentFeedAuthority(authority));
}

/** Test hook: run one poll cycle synchronously. */
export async function pollExternalWritesForTest(): Promise<void> {
  await pollTick();
}

/** Test hook: read poller cursor. */
export function getExternalWriteCursorForTest(): number {
  return state.cursor;
}
