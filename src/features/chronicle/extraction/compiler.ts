import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";

export type DomainOperationKind = "chronicle.event.create";

export interface DomainOperationBase<TKind extends string, TPayload> {
  readonly kind: TKind;
  readonly payload: TPayload;
}

export interface FractionalPlacement {
  readonly mode: "append-tail";
  readonly afterOrdinal: string | null;
}

export interface CreateChronicleEventOperationPayloadV1 {
  readonly eventId: string;
  readonly title: string;
  readonly note: string | null;
  readonly kind: "generic";
  readonly precision: "unknown";
  readonly placement: FractionalPlacement;
  readonly secret: boolean;
  readonly revealSceneId: string;
  readonly evidenceSceneLinks: readonly {
    readonly sceneId: string;
    readonly expectedSceneVersion: number;
    readonly evidenceAnchorIds: readonly string[];
  }[];
  readonly detail: null;
  readonly primaryCodexId: null;
  readonly locationCodexId: null;
  readonly participants: readonly [];
  readonly startTime: null;
  readonly endTime: null;
  readonly startGranularity: "none";
  readonly endGranularity: "none";
  readonly semanticType?: string;
}

export type CreateChronicleEventOperationV1 = DomainOperationBase<
  "chronicle.event.create",
  CreateChronicleEventOperationPayloadV1
>;

export interface CompileChronicleProposalOptions {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly afterOrdinal?: string | null;
  /** documentRef → resolved evidence anchor ids (already on the proposal). */
  readonly anchorsByDocumentRef?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Compile an approved Chronicle create proposal into a Domain Operation.
 * v1 fixes kind/precision/time fields and maps document refs → scene ids
 * via Snapshot origin.
 */
export function compileCreateChronicleEventOperation(
  proposal: CreateChronicleEventProposalPayloadV1,
  options: CompileChronicleProposalOptions,
): CreateChronicleEventOperationV1 {
  const documentByRef = new Map(
    options.snapshot.documents.map((document) => [document.ref, document]),
  );

  const linksByScene = new Map<
    string,
    { sceneId: string; expectedSceneVersion: number; anchorIds: string[] }
  >();

  for (const documentRef of proposal.evidenceDocumentRefs) {
    const document = documentByRef.get(documentRef);
    if (!document || document.origin.kind !== "project-node") {
      throw new Error(`Unknown evidence document ref: ${documentRef}`);
    }
    const sceneId = document.origin.nodeId;
    const existing = linksByScene.get(sceneId) ?? {
      sceneId,
      expectedSceneVersion: document.origin.sourceVersion,
      anchorIds: [],
    };
    const extra =
      options.anchorsByDocumentRef?.get(documentRef) ??
      proposal.evidenceAnchorIds.filter((_, index) => {
        return proposal.evidenceDocumentRefs[index] === documentRef;
      });
    for (const anchorId of extra) {
      if (!existing.anchorIds.includes(anchorId)) {
        existing.anchorIds.push(anchorId);
      }
    }
    // Prefer anchors already listed on the proposal when no map is provided.
    if (existing.anchorIds.length === 0) {
      for (const anchorId of proposal.evidenceAnchorIds) {
        if (!existing.anchorIds.includes(anchorId)) {
          existing.anchorIds.push(anchorId);
        }
      }
    }
    linksByScene.set(sceneId, existing);
  }

  const revealDocument = documentByRef.get(
    proposal.disclosure.revealDocumentRef,
  );
  if (!revealDocument || revealDocument.origin.kind !== "project-node") {
    throw new Error(
      `Unknown reveal document ref: ${proposal.disclosure.revealDocumentRef}`,
    );
  }

  return {
    kind: "chronicle.event.create",
    payload: {
      eventId: proposal.eventId,
      title: proposal.title,
      note: proposal.note,
      kind: "generic",
      precision: "unknown",
      placement: {
        mode: "append-tail",
        afterOrdinal: options.afterOrdinal ?? null,
      },
      secret: proposal.disclosure.secret,
      revealSceneId: revealDocument.origin.nodeId,
      evidenceSceneLinks: [...linksByScene.values()].map((link) => ({
        sceneId: link.sceneId,
        expectedSceneVersion: link.expectedSceneVersion,
        evidenceAnchorIds: link.anchorIds,
      })),
      detail: null,
      primaryCodexId: null,
      locationCodexId: null,
      participants: [],
      startTime: null,
      endTime: null,
      startGranularity: "none",
      endGranularity: "none",
      ...(proposal.semanticType ? { semanticType: proposal.semanticType } : {}),
    },
  };
}
