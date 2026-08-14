import { getRecorderSessionId } from "@/features/timelapse/recorder";

export type CanonicalWriteOrigin =
  | "human"
  | "ai-apply"
  | "import"
  | "undo"
  | "redo"
  | "restore"
  | "migration";

export interface CanonicalWriteLineage {
  originalTransactionId: string;
  undoJournalId: string;
}

export interface CanonicalWriteContext {
  requestId: string;
  sessionId: string;
  eventUid: string;
  origin: CanonicalWriteOrigin;
  originalTransactionId: string | null;
  undoJournalId: string | null;
}

export interface CanonicalWriteReceipt {
  changeEventUid: string;
  maintenanceTransactionId: string;
  undoJournalId?: string | null;
}

export interface CanonicalHistoryWriteLease {
  acquire(): CanonicalWriteContext;
  committed(): void;
}

export function createCanonicalWriteContext(
  origin: CanonicalWriteOrigin = "human",
  lineage?: CanonicalWriteLineage,
  stableRequestId?: string,
): CanonicalWriteContext {
  const requestId = stableRequestId ?? crypto.randomUUID();
  if ((origin === "undo" || origin === "redo") && !lineage) {
    throw new Error(`${origin} write requires canonical transaction lineage`);
  }
  if (origin !== "undo" && origin !== "redo" && lineage) {
    throw new Error(`${origin} write cannot carry undo/redo lineage`);
  }
  return {
    requestId,
    sessionId: getRecorderSessionId(),
    // Agent operations already expose a stable logical request ID. Reusing it
    // as the canonical event identity makes a native retry an exact replay;
    // ad-hoc human writes retain independent request/event UUIDs.
    eventUid: stableRequestId ?? crypto.randomUUID(),
    origin,
    originalTransactionId: lineage?.originalTransactionId ?? null,
    undoJournalId: lineage?.undoJournalId ?? null,
  };
}

/**
 * Keep the same request/event identity while an undo/redo has an unknown
 * outcome. Once a call is confirmed committed, the next history cycle gets a
 * fresh identity instead of replaying the previous receipt.
 */
export function createCanonicalHistoryWriteLease(
  origin: "undo" | "redo",
  lineage: CanonicalWriteLineage,
): CanonicalHistoryWriteLease {
  let pending: CanonicalWriteContext | undefined;
  return {
    acquire() {
      pending ??= createCanonicalWriteContext(origin, lineage);
      return pending;
    },
    committed() {
      pending = undefined;
    },
  };
}
