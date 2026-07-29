import {
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";

const saveTails = new Map<string, Promise<unknown>>();
const exclusiveDocumentLeaseCounts = new Map<string, number>();
const exclusiveDocumentLeaseListeners = new Map<string, Set<() => void>>();
const documentSaveRevisions = new Map<
  string,
  { revision: number; lastWriter: symbol | null }
>();
const MAX_COORDINATOR_DRAIN_ROUNDS = 50;

interface DocumentSaveSessionState {
  active: boolean;
  readonly identity: symbol;
  readonly retiredAtRevision: Map<string, number>;
}

const documentSaveSessionStates = new WeakMap<
  DocumentSaveSession,
  DocumentSaveSessionState
>();

export interface DocumentSaveSession {
  /**
   * React StrictMode re-runs effect setup after its development-only cleanup.
   * Reactivating the same component session makes that setup authoritative.
   */
  activate: () => void;
  /**
   * Freeze the document revision observed when this component detached.
   * A later save by another component makes retries from the detached editor
   * stale, but already-started/coalesced saves owned by this session remain
   * drainable until a foreign writer wins.
   */
  retire: (documentKey: DocumentKey | null) => void;
}

export interface DocumentSaveOptions<T> {
  session?: DocumentSaveSession;
  didPersist?: (result: T) => boolean;
}

export interface DocumentMutationOptions<T> {
  /**
   * Some exclusive callbacks can discover a newly-published local draft after
   * acquiring the lease and intentionally return without replacing content.
   * Only an actual authoritative replacement advances the foreign revision.
   */
  didMutate?: (result: T) => boolean;
}

export interface DocumentMutationContext {
  /**
   * Publish the foreign revision immediately after the authoritative content
   * write commits. Later non-content side effects may still fail, but a
   * detached editor must already be stale at that point.
   */
  markAuthoritativeMutation: () => void;
}

export class StaleRetiredDocumentSaveError extends Error {
  constructor() {
    super("A detached editor draft was superseded by a newer saved version");
    this.name = "StaleRetiredDocumentSaveError";
  }
}

export class DocumentMutationLeaseActiveError extends Error {
  constructor() {
    super("This document is temporarily read-only while content is replaced");
    this.name = "DocumentMutationLeaseActiveError";
  }
}

function revisionFor(encoded: string): number {
  return documentSaveRevisions.get(encoded)?.revision ?? 0;
}

function notifyExclusiveDocumentLease(encoded: string): void {
  for (const listener of exclusiveDocumentLeaseListeners.get(encoded) ?? []) {
    listener();
  }
}

function acquireExclusiveDocumentLease(documentKey: DocumentKey): () => void {
  const encoded = encodeDocumentKey(documentKey);
  exclusiveDocumentLeaseCounts.set(
    encoded,
    (exclusiveDocumentLeaseCounts.get(encoded) ?? 0) + 1,
  );
  notifyExclusiveDocumentLease(encoded);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (exclusiveDocumentLeaseCounts.get(encoded) ?? 1) - 1;
    if (remaining > 0) exclusiveDocumentLeaseCounts.set(encoded, remaining);
    else exclusiveDocumentLeaseCounts.delete(encoded);
    notifyExclusiveDocumentLease(encoded);
  };
}

export function isExclusiveDocumentLeaseActive(
  documentKey: DocumentKey | null,
): boolean {
  if (!documentKey) return false;
  return (
    (exclusiveDocumentLeaseCounts.get(encodeDocumentKey(documentKey)) ?? 0) > 0
  );
}

export function subscribeExclusiveDocumentLease(
  documentKey: DocumentKey | null,
  listener: () => void,
): () => void {
  if (!documentKey) return () => {};
  const encoded = encodeDocumentKey(documentKey);
  const listeners =
    exclusiveDocumentLeaseListeners.get(encoded) ?? new Set<() => void>();
  listeners.add(listener);
  exclusiveDocumentLeaseListeners.set(encoded, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) exclusiveDocumentLeaseListeners.delete(encoded);
  };
}

export function createDocumentSaveSession(): DocumentSaveSession {
  const state: DocumentSaveSessionState = {
    active: true,
    identity: Symbol("document-save-session"),
    retiredAtRevision: new Map(),
  };
  const session: DocumentSaveSession = {
    activate() {
      state.active = true;
      state.retiredAtRevision.clear();
    },
    retire(documentKey) {
      state.active = false;
      if (!documentKey) return;
      const encoded = encodeDocumentKey(documentKey);
      state.retiredAtRevision.set(encoded, revisionFor(encoded));
    },
  };
  documentSaveSessionStates.set(session, state);
  return session;
}

function assertSessionFresh(
  encoded: string,
  session: DocumentSaveSession | undefined,
): void {
  if (!session) return;
  const state = documentSaveSessionStates.get(session);
  if (!state || state.active) return;
  const retiredAt = state.retiredAtRevision.get(encoded);
  if (retiredAt === undefined) {
    throw new StaleRetiredDocumentSaveError();
  }
  const current = documentSaveRevisions.get(encoded);
  if (
    current &&
    current.revision > retiredAt &&
    current.lastWriter !== state.identity
  ) {
    throw new StaleRetiredDocumentSaveError();
  }
}

function recordSuccessfulSave(
  encoded: string,
  session: DocumentSaveSession | undefined,
): void {
  const nextRevision = revisionFor(encoded) + 1;
  const writer = session
    ? (documentSaveSessionStates.get(session)?.identity ?? null)
    : null;
  documentSaveRevisions.set(encoded, {
    revision: nextRevision,
    lastWriter: writer,
  });
}

function recordAuthoritativeDocumentMutation(encoded: string): void {
  // `undefined` deliberately records a foreign writer identity (`null`) that
  // can never equal a live or retired editor session's private Symbol.
  recordSuccessfulSave(encoded, undefined);
}

/**
 * Renderer-local canonical-document lease. The callback is invoked only when
 * every earlier save for the same document has settled, so it captures the
 * latest editor snapshot and OCC base at execution time. Different documents
 * retain full parallelism.
 */
export async function runCoordinatedDocumentSave<T>(
  documentKey: DocumentKey,
  saveLatest: () => Promise<T>,
  options: DocumentSaveOptions<T> = {},
): Promise<T> {
  const encoded = encodeDocumentKey(documentKey);
  if ((exclusiveDocumentLeaseCounts.get(encoded) ?? 0) > 0) {
    throw new DocumentMutationLeaseActiveError();
  }
  const previous = saveTails.get(encoded);
  const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(
    async () => {
      assertSessionFresh(encoded, options.session);
      const result = await saveLatest();
      if (options.didPersist?.(result) ?? true) {
        recordSuccessfulSave(encoded, options.session);
      }
      return result;
    },
  );
  saveTails.set(encoded, run);
  try {
    return await run;
  } finally {
    if (saveTails.get(encoded) === run) saveTails.delete(encoded);
  }
}

/**
 * Serializes an authoritative document replacement behind every local save
 * that was issued before this call. The lease is published synchronously,
 * before the first await, so mounted editors can become read-only without a
 * React-render gap and later saves cannot queue behind the replacement.
 *
 * This is intentionally document-scoped: importing one external Markdown file
 * must not freeze unrelated editors.
 */
export async function runExclusiveDocumentMutation<T>(
  documentKey: DocumentKey,
  mutation: (context: DocumentMutationContext) => Promise<T>,
  options: DocumentMutationOptions<T> = {},
): Promise<T> {
  const encoded = encodeDocumentKey(documentKey);
  const releaseLease = acquireExclusiveDocumentLease(documentKey);
  const previous = saveTails.get(encoded);
  const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(
    async () => {
      let mutationRecorded = false;
      const markAuthoritativeMutation = () => {
        if (mutationRecorded) return;
        recordAuthoritativeDocumentMutation(encoded);
        mutationRecorded = true;
      };
      const result = await mutation({ markAuthoritativeMutation });
      if (!mutationRecorded && (options.didMutate?.(result) ?? true)) {
        markAuthoritativeMutation();
      }
      return result;
    },
  );
  saveTails.set(encoded, run);
  try {
    return await run;
  } finally {
    if (saveTails.get(encoded) === run) saveTails.delete(encoded);
    releaseLease();
  }
}

export async function awaitAllCoordinatedDocumentMutations(): Promise<void> {
  const failures: unknown[] = [];
  for (let round = 0; round < MAX_COORDINATOR_DRAIN_ROUNDS; round++) {
    if (saveTails.size === 0) {
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "One or more coordinated document mutations failed",
        );
      }
      return;
    }
    const results = await Promise.allSettled([...new Set(saveTails.values())]);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  throw new AggregateError(
    failures,
    "Coordinated document mutations did not reach quiescence",
  );
}

registerQuiescenceProvider({
  id: "coordinated-document-mutations",
  stage: "autosave",
  flush: awaitAllCoordinatedDocumentMutations,
});

export function _resetDocumentSaveCoordinatorForTests(): void {
  saveTails.clear();
  documentSaveRevisions.clear();
  if (exclusiveDocumentLeaseCounts.size > 0) {
    const leasedDocuments = [...exclusiveDocumentLeaseCounts.keys()];
    exclusiveDocumentLeaseCounts.clear();
    for (const encoded of leasedDocuments)
      notifyExclusiveDocumentLease(encoded);
  }
}
