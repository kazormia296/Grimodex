import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";

export interface AttachmentCandidateContext {
  readonly expressionFrom: number;
  readonly expressionTo: number;
  /** Nodes mentioned in the same sentence (offsets overlapping sentence). */
  readonly sameSentenceNodeIds: readonly TemporalNodeId[];
  readonly sameParagraphNodeIds: readonly TemporalNodeId[];
  readonly sameWindowNodeIds: readonly TemporalNodeId[];
  readonly namedEventNodeIds: readonly TemporalNodeId[];
  readonly sceneFrameNodeId: TemporalNodeId | null;
  readonly previousSceneLastNodeId: TemporalNodeId | null;
  readonly nearbyChronicleNodeIds: readonly TemporalNodeId[];
}

export type AttachmentCandidateResult =
  | { readonly status: "resolved"; readonly nodeId: TemporalNodeId }
  | { readonly status: "ambiguous"; readonly candidates: readonly TemporalNodeId[] }
  | { readonly status: "unresolved" };

/**
 * Deterministic candidate generator. Never auto-picks the first among many.
 */
export function buildAttachmentCandidates(
  ctx: AttachmentCandidateContext,
): AttachmentCandidateResult {
  const tiers: readonly (readonly TemporalNodeId[])[] = [
    ctx.sameSentenceNodeIds,
    ctx.sameParagraphNodeIds,
    ctx.sameWindowNodeIds,
    ctx.namedEventNodeIds,
    ctx.sceneFrameNodeId ? [ctx.sceneFrameNodeId] : [],
    ctx.previousSceneLastNodeId ? [ctx.previousSceneLastNodeId] : [],
    ctx.nearbyChronicleNodeIds,
  ];

  for (const tier of tiers) {
    const unique = [...new Set(tier)].sort((a, b) => a.localeCompare(b));
    if (unique.length === 1) {
      return { status: "resolved", nodeId: unique[0]! };
    }
    if (unique.length > 1) {
      return { status: "ambiguous", candidates: unique };
    }
  }
  return { status: "unresolved" };
}

export function validateAttachmentNodeRefs(
  returnedRefs: readonly string[],
  catalog: ReadonlySet<string>,
): { readonly ok: true; readonly refs: readonly TemporalNodeId[] } | {
  readonly ok: false;
  readonly reason: "unknown-ref";
  readonly invalid: readonly string[];
} {
  const invalid = returnedRefs.filter((ref) => !catalog.has(ref));
  if (invalid.length > 0) {
    return { ok: false, reason: "unknown-ref", invalid };
  }
  return {
    ok: true,
    refs: returnedRefs as TemporalNodeId[],
  };
}
