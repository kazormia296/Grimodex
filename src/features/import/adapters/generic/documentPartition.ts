import { importDiagnostic } from "../../core/importDiagnostics";

export interface ImportDocumentPartitionSegment {
  readonly segmentId: string;
  readonly title: string;
  readonly blockIds: readonly string[];
}

export interface ImportDocumentPartitionProposal {
  readonly resourceKey: string;
  readonly relativePath: string;
  readonly segments: readonly ImportDocumentPartitionSegment[];
}

export interface PartitionValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly ReturnType<typeof importDiagnostic>[];
}

export function validateBoundaries(
  proposal: ImportDocumentPartitionProposal,
  allBlockIds: readonly string[],
): PartitionValidationResult {
  const diagnostics = [];
  const seen = new Set<string>();
  const available = new Set(allBlockIds);
  const assigned = new Set<string>();

  for (const segment of proposal.segments) {
    for (const blockId of segment.blockIds) {
      if (seen.has(blockId)) {
        diagnostics.push(
          importDiagnostic(
            "error",
            "partition-duplicate-block",
            `Block assigned to multiple segments: ${blockId}`,
            proposal.relativePath,
          ),
        );
      }
      seen.add(blockId);
      assigned.add(blockId);
      if (!available.has(blockId)) {
        diagnostics.push(
          importDiagnostic(
            "error",
            "partition-unknown-block",
            `Unknown block id in partition: ${blockId}`,
            proposal.relativePath,
          ),
        );
      }
    }
  }

  for (const blockId of allBlockIds) {
    if (!assigned.has(blockId)) {
      diagnostics.push(
        importDiagnostic(
          "error",
          "partition-missing-block",
          `Block not assigned to any segment: ${blockId}`,
          proposal.relativePath,
        ),
      );
    }
  }

  return {
    ok: diagnostics.every((d) => d.severity !== "error"),
    diagnostics,
  };
}

export function singleSegmentPartition(
  resourceKey: string,
  relativePath: string,
  title: string,
  blockIds: readonly string[],
): ImportDocumentPartitionProposal {
  return {
    resourceKey,
    relativePath,
    segments: [
      { segmentId: `${resourceKey}:whole`, title, blockIds: [...blockIds] },
    ],
  };
}
