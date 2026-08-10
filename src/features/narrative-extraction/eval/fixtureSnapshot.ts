import { resolveEvidenceReference } from "../evidence/resolveEvidence";
import type { EvidenceResolutionResult } from "../evidence/types";
import { buildNarrativeCorpusSnapshot } from "../source/buildSnapshot";
import { buildNarrativeSourceView } from "../source/sourceView";
import type {
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
} from "../source/types";
import type { NarrativeEvalCaseV1 } from "./types";

export interface NarrativeEvalGoldEvidenceResult {
  readonly expectationId: string;
  readonly sourceRef: string;
  readonly quote: string;
  readonly status: EvidenceResolutionResult["status"];
}

export interface NarrativeEvalFixture {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly sourceViews: readonly NarrativeSourceView[];
  readonly goldEvidence: readonly NarrativeEvalGoldEvidenceResult[];
}

function plainTextToProseMirrorJson(text: string): string {
  const paragraphs = text.split(/\r\n|\r|\n/).map((line) => ({
    type: "paragraph",
    ...(line.length > 0 ? { content: [{ type: "text", text: line }] } : {}),
  }));
  return JSON.stringify({ type: "doc", content: paragraphs });
}

/**
 * Adapt synthetic plain-text Gold fixtures through the same canonical
 * serializer, snapshot seals, Source Views, and Evidence resolver as product
 * extraction. Evaluation code never invents offsets.
 */
export async function buildNarrativeEvalFixture(
  evalCase: NarrativeEvalCaseV1,
): Promise<NarrativeEvalFixture> {
  const projectId = `narrative-eval:${evalCase.id}`;
  const included = new Set(evalCase.coverage.includedDocumentIds);
  const result = await buildNarrativeCorpusSnapshot({
    snapshotId: `narrative-eval:${evalCase.id}`,
    language: evalCase.locale,
    origin: { kind: "grimodex-project", projectId },
    documents: evalCase.documents
      .filter((document) => included.has(document.id))
      .map((document, orderIndex) => ({
        sourceKey: document.id,
        parentSourceKey: null,
        title: document.title,
        orderIndex,
        proseMirrorJson: plainTextToProseMirrorJson(document.text),
        origin: {
          kind: "project-node",
          projectId,
          nodeId: document.id,
          sourceVersion: 1,
          sourceUpdatedAt: evalCase.frozenTime,
          sourceUri: null,
        },
      })),
    omissions: evalCase.coverage.omittedDocumentIds.map((sourceKey) => ({
      sourceKey,
      reason: "eval-coverage-omission",
    })),
    createdAt: evalCase.frozenTime,
  });
  if (!result.ok) {
    throw new Error(
      `Narrative eval snapshot failed: ${result.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(", ")}`,
    );
  }

  const sourceViews = await Promise.all(
    result.snapshot.documents.map((document) =>
      buildNarrativeSourceView({
        ref: document.sourceKey,
        document,
        documentRange: { start: 0, end: document.canonical.text.length },
      }),
    ),
  );
  let anchorIndex = 0;
  const goldEvidence: NarrativeEvalGoldEvidenceResult[] = [];
  const expectations = [
    ...evalCase.expected.observations.required,
    ...evalCase.expected.observations.forbidden,
  ];
  for (const expectation of expectations) {
    for (const evidence of expectation.dimensions.evidence ?? []) {
      const resolution = await resolveEvidenceReference(
        {
          sourceRef: evidence.documentId,
          quote: evidence.quote,
          ...(evidence.prefix ? { prefix: evidence.prefix } : {}),
          ...(evidence.suffix ? { suffix: evidence.suffix } : {}),
        },
        {
          snapshot: result.snapshot,
          sourceViews,
          createAnchorId: () =>
            `eval-anchor-${String(++anchorIndex).padStart(4, "0")}`,
        },
      );
      goldEvidence.push({
        expectationId: expectation.id,
        sourceRef: evidence.documentId,
        quote: evidence.quote,
        status: resolution.status,
      });
      if (resolution.status !== "resolved") {
        throw new Error(
          `Narrative Gold evidence did not resolve: ${expectation.id} (${resolution.status})`,
        );
      }
    }
  }
  return { snapshot: result.snapshot, sourceViews, goldEvidence };
}
