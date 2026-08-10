import type { BindCodexEntityPayload } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import type { CreateCodexRelationProposalPayload } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { CodexCompiledDomainOperation } from "../codexStructureExtractionStore";

export const CODEX_REVIEW_REVISION_ENVELOPE_VERSION = 1 as const;

/**
 * Native revision payload envelope so cold-start restore always has the
 * Review Gate payload, and approved rows keep the locked Domain Operation.
 */
export interface CodexReviewRevisionEnvelope {
  readonly version: typeof CODEX_REVIEW_REVISION_ENVELOPE_VERSION;
  readonly reviewPayload:
    | BindCodexEntityPayload
    | CreateCodexRelationProposalPayload;
  readonly compiledOperation: CodexCompiledDomainOperation | null;
}

export function buildCodexReviewRevisionEnvelope(args: {
  readonly reviewPayload:
    | BindCodexEntityPayload
    | CreateCodexRelationProposalPayload;
  readonly compiledOperation?: CodexCompiledDomainOperation | null;
}): CodexReviewRevisionEnvelope {
  return {
    version: CODEX_REVIEW_REVISION_ENVELOPE_VERSION,
    reviewPayload: args.reviewPayload,
    compiledOperation: args.compiledOperation ?? null,
  };
}

export function isCodexReviewRevisionEnvelope(
  value: unknown,
): value is CodexReviewRevisionEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === CODEX_REVIEW_REVISION_ENVELOPE_VERSION &&
    record.reviewPayload !== null &&
    typeof record.reviewPayload === "object"
  );
}

export function parseCodexReviewRevisionEnvelope(
  value: unknown,
): CodexReviewRevisionEnvelope | null {
  return isCodexReviewRevisionEnvelope(value) ? value : null;
}
