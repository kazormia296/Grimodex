import { getRecorderSessionId } from "@/features/timelapse/recorder";
import {
  assertMutationAuthorityContext,
  authorityRouteForOrigin,
  requiredControlsForRoute,
  type MutationAuthorityRoute,
  type MutationControl,
  type MutationOrigin,
  type MutationProvenance,
} from "@/features/narrative-semantic-core/contracts/mutationAuthority";

export type CanonicalWriteOrigin = MutationOrigin;

export interface CanonicalWriteLineage {
  originalTransactionId: string;
  undoJournalId: string;
}

export interface CanonicalWriteContext {
  requestId: string;
  sessionId: string;
  eventUid: string;
  origin: CanonicalWriteOrigin;
  authorityRoute: MutationAuthorityRoute;
  caller: string;
  controls: readonly MutationControl[];
  provenance: MutationProvenance | null;
  writesAuthorityProtectedField: boolean;
  originalTransactionId: string | null;
  undoJournalId: string | null;
}

export interface CanonicalWriteAuthorityOptions {
  authorityRoute?: MutationAuthorityRoute;
  caller?: string;
  controls?: readonly MutationControl[];
  provenance?: MutationProvenance;
  writesAuthorityProtectedField?: boolean;
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
  authorityOptions?: CanonicalWriteAuthorityOptions,
): CanonicalWriteContext {
  if ((origin === "undo" || origin === "redo") && !lineage) {
    throw new Error(`${origin} write requires canonical transaction lineage`);
  }
  if (origin !== "undo" && origin !== "redo" && lineage) {
    throw new Error(`${origin} write cannot carry undo/redo lineage`);
  }
  const requestId = stableRequestId ?? crypto.randomUUID();
  const authorityRoute =
    authorityOptions?.authorityRoute ?? authorityRouteForOrigin(origin);
  const writesAuthorityProtectedField =
    authorityOptions?.writesAuthorityProtectedField === true;
  const controls = new Set(
    authorityOptions?.controls ?? requiredControlsForRoute(authorityRoute),
  );
  const provenance =
    authorityOptions?.provenance ??
    (origin === "ai-apply" ? { requestId, traceId: requestId } : null);
  const context = {
    requestId,
    sessionId: getRecorderSessionId(),
    // Agent operations already expose a stable logical request ID. Reusing it
    // as the canonical event identity makes a native retry an exact replay;
    // ad-hoc human writes retain independent request/event UUIDs.
    eventUid: stableRequestId ?? crypto.randomUUID(),
    origin,
    authorityRoute,
    caller:
      authorityOptions?.caller ?? defaultCallerForRoute(authorityRoute, origin),
    controls: [...controls],
    provenance,
    writesAuthorityProtectedField,
    originalTransactionId: lineage?.originalTransactionId ?? null,
    undoJournalId: lineage?.undoJournalId ?? null,
  };
  assertMutationAuthorityContext({
    ...context,
    provenance: context.provenance ?? undefined,
  });
  return context;
}

function defaultCallerForRoute(
  route: MutationAuthorityRoute,
  origin: CanonicalWriteOrigin,
): string {
  switch (route) {
    case "human-direct":
      return "human-ui";
    case "interactive-agent-command":
      return "chat-tool-executor";
    case "interpreter-projection":
      return "interpreter";
    case "import-apply":
      return "import-session";
    case "history-replay":
      return "history-controller";
    case "restore-or-migration":
      return origin === "migration" ? "migration-runner" : "restore-controller";
  }
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
