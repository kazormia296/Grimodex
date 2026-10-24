import type {
  RelatedScenesBeginResponse,
  RelatedScenesGraphPathAttachment,
  RelatedScenesGraphPathEdge,
  RelatedScenesGraphOnlyRow,
  RelatedScenesGraphWaitResponse,
} from "@/../electron/shared/relatedScenesSearchWire";
import { debugLog } from "@/lib/debugLog";
import {
  continueRelatedScenesGraph,
  settleRelatedScenesGraph,
} from "./nir1RelatedScenesApi";
import type {
  Nir1GraphArrival,
  Nir1GraphTicketUse,
} from "./nir1RelatedScenesGraphJoin";
import type { Nir1RelatedScenesGraphPayload } from "./nir1RelatedScenesFetchTypes";

/**
 * Renderer side of one Native Graph ticket (CP-3a). It exists only when begin
 * was given a seed. It starts the wait once Raw R is known, projects the answer
 * to display fields, and declares the ticket's use exactly once.
 */
export interface Nir1RelatedScenesGraphWait {
  /** Start the wait with Raw R. Never rejects; a failure is `unavailable`. */
  arrival(
    rawSceneIds: readonly string[],
  ): Promise<Nir1GraphArrival<Nir1RelatedScenesGraphPayload>>;
  /** The join's `onGraphSettled`: declare the use, never throw. */
  settle(use: Nir1GraphTicketUse): void;
  /**
   * Resolves once the declaration (if any) has reached Native, so a later
   * release of the same operation cannot overtake it. Never rejects.
   */
  settled(): Promise<void>;
}

export function createNir1RelatedScenesGraphWait(input: {
  begin: RelatedScenesBeginResponse;
  operationTicket: string | null;
  queryBinding: string;
  /** Whether the query is still current and its session usable. */
  canWait: () => boolean;
}): Nir1RelatedScenesGraphWait | null {
  const graph = input.begin.graph;
  // No seed was sent: the pre-CP-3a path, no Graph state at all.
  if (graph === undefined) return null;
  const ticket = input.operationTicket;
  let waitStarted = false;
  let declared = false;
  let declaration: Promise<void> = Promise.resolve();

  return {
    arrival(rawSceneIds) {
      if (graph.status === "unavailable")
        return Promise.resolve({
          status: "unavailable",
          reason: graph.reason,
        });
      if (graph.status !== "pending" || !ticket)
        return Promise.resolve({ status: "unavailable", reason: "failed" });
      // A stopped query cancels its operation through the session release;
      // nothing is asked of Native on its behalf.
      if (!input.canWait())
        return Promise.resolve({ status: "unavailable", reason: "cancelled" });
      waitStarted = true;
      return continueRelatedScenesGraph(ticket, rawSceneIds).then(
        (response) => projectGraphArrival(response, input.queryBinding),
        () => ({ status: "unavailable", reason: "failed" }),
      );
    },
    settle(use) {
      // Only a ticket the renderer waited on is declared; one that was never
      // awaited is cancelled by the session's release of the operation.
      if (declared || !waitStarted || !ticket) return;
      declared = true;
      declaration = settleRelatedScenesGraph(ticket, use).then(
        () => undefined,
        () => {
          debugLog.warn("RelatedScenes", "Graph ticket settle failed");
        },
      );
    },
    settled: () => declaration,
  };
}

/** Copy display fields only; anything else in the answer is dropped. */
export function projectGraphArrival(
  response: RelatedScenesGraphWaitResponse | unknown,
  queryBinding: string,
): Nir1GraphArrival<Nir1RelatedScenesGraphPayload> {
  const value = response as Partial<RelatedScenesGraphWaitResponse> | null;
  if (value?.status === "unavailable")
    return {
      status: "unavailable",
      reason: typeof value.reason === "string" ? value.reason : "failed",
    };
  if (
    value?.status !== "available" ||
    value.queryBinding !== queryBinding ||
    !Array.isArray(value.pathAttachments)
  )
    return { status: "unavailable", reason: "failed" };
  const pathAttachments: RelatedScenesGraphPathAttachment[] = [];
  for (const attachment of value.pathAttachments) {
    const edges = copyEdges(attachment?.edges);
    if (
      typeof attachment?.sceneId !== "string" ||
      !attachment.sceneId ||
      !Number.isInteger(attachment.hop) ||
      !edges
    )
      return { status: "unavailable", reason: "failed" };
    pathAttachments.push({
      sceneId: attachment.sceneId,
      hop: attachment.hop,
      edges,
    });
  }
  const graphOnly = copyGraphOnly(value.graphOnly);
  if (graphOnly === undefined)
    return { status: "unavailable", reason: "failed" };
  return {
    status: "available",
    graph: { queryBinding, pathAttachments, graphOnly },
  };
}

function copyEdges(edges: unknown): RelatedScenesGraphPathEdge[] | null {
  if (!Array.isArray(edges)) return null;
  const copied: RelatedScenesGraphPathEdge[] = [];
  for (const edge of edges as Partial<RelatedScenesGraphPathEdge>[]) {
    const evidence = edge?.evidence;
    if (
      typeof edge?.relationType !== "string" ||
      typeof edge.directionality !== "string" ||
      typeof edge.from?.entityId !== "string" ||
      typeof edge.from.label !== "string" ||
      typeof edge.to?.entityId !== "string" ||
      typeof edge.to.label !== "string" ||
      !Array.isArray(evidence)
    )
      return null;
    const quotes: { evidenceId: string; quote: string }[] = [];
    for (const item of evidence) {
      if (
        typeof item?.evidenceId !== "string" ||
        typeof item.quote !== "string"
      )
        return null;
      quotes.push({ evidenceId: item.evidenceId, quote: item.quote });
    }
    copied.push({
      relationType: edge.relationType,
      directionality: edge.directionality,
      from: { entityId: edge.from.entityId, label: edge.from.label },
      to: { entityId: edge.to.entityId, label: edge.to.label },
      evidence: quotes,
    });
  }
  return copied;
}

/** `null` is a valid answer (no Graph-only row); `undefined` is a bad shape. */
function copyGraphOnly(
  row: unknown,
): RelatedScenesGraphOnlyRow | null | undefined {
  if (row === null) return null;
  const value = row as Partial<RelatedScenesGraphOnlyRow> | undefined;
  const edges = copyEdges(value?.path?.edges);
  if (
    typeof value?.sceneId !== "string" ||
    !value.sceneId ||
    typeof value.sceneTitle !== "string" ||
    typeof value.excerpt !== "string" ||
    !Number.isInteger(value.canonicalRange?.start) ||
    !Number.isInteger(value.canonicalRange?.end) ||
    typeof value.navigationIdentity !== "string" ||
    !value.navigationIdentity ||
    !Number.isInteger(value.path?.hop) ||
    typeof value.path?.pinEntityId !== "string" ||
    !edges
  )
    return undefined;
  return {
    sceneId: value.sceneId,
    sceneTitle: value.sceneTitle,
    excerpt: value.excerpt,
    canonicalRange: {
      start: value.canonicalRange!.start,
      end: value.canonicalRange!.end,
    },
    navigationIdentity: value.navigationIdentity,
    path: {
      hop: value.path!.hop,
      pinEntityId: value.path!.pinEntityId,
      edges,
    },
  };
}
