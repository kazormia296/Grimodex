import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import { resolveEvidenceReference } from "@/features/narrative-extraction/evidence/resolveEvidence";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { CHRONICLE_EVENT_PROPOSAL_KIND } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import type {
  CanonicalRange,
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
  Sha256Digest,
} from "@/features/narrative-extraction/source/types";
import {
  buildNarrativeScopeAuthorityBasisV2,
  type NarrativeScopeAuthorityBasisV2,
} from "@/features/narrative-extraction/source/scopeAuthorityBasisV2";
import { clusterEventObservations } from "@/features/chronicle/extraction/eventClustering";
import { chronicleEvidenceTupleKey } from "@/features/chronicle/extraction/evidenceTupleKey";
import { mergeObservationsByEvidence } from "@/features/chronicle/extraction/observationMerger";
import {
  matchExistingChronicleEvent,
  type ChronicleExistingMatch,
  type ExistingChronicleEventCatalogRecord,
} from "@/features/chronicle/extraction/existingEventMatcher";
import { planChronicleEventProposals } from "@/features/chronicle/extraction/proposalPlanner";
import {
  assertUniqueObservationLocalIds,
  rekeyObservationsForWindow,
} from "@/features/chronicle/extraction/windowExtractor";
import {
  planExtractionWindows,
  type ExtractionWindow,
  type WindowPlan,
} from "@/features/chronicle/extraction/windowPlanner";
import type { SavedProposalSeed } from "./nativeApi";
import {
  narrativeExtractionClaimTask,
  narrativeExtractionFailTask,
  narrativeExtractionFinishTask,
} from "./nativeApi";
import {
  buildInlineJsonArtifact,
  loadInlineJsonArtifact,
  rememberInlineJsonArtifact,
} from "./artifactRepository";
import {
  buildSnapshotSourceBasis,
  saveChronicleProposalSet,
} from "./proposalRepository";
import {
  buildProjectNarrativeSnapshot,
  type ProjectSnapshotAdapterServices,
} from "./projectSnapshotAdapter";
import { cancelRun, createRun } from "./runRepository";
import { runObservationExtractionTask } from "./aiTasks/runObservationExtractionTask";
import { runEventSynthesisTask } from "./aiTasks/runEventSynthesisTask";
import {
  createStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "@/features/narrative-extraction/reconciler/stageExecution";

/** Run surface path id (not a stage AI attempt path). */
export const CHRONICLE_EXTRACT_SURFACE_PATH = "chronicle.extract" as const;

export const CHRONICLE_EXTRACT_TASK_KINDS = {
  snapshot: "source.snapshot@1",
  windowPlan: "source.window-plan@1",
  observe: "chronicle.observe-events@1",
  resolveEvidence: "evidence.resolve@1",
  mergeObservations: "chronicle.merge-local-observations@1",
  cluster: "chronicle.cluster-event-observations@1",
  synthesize: "chronicle.synthesize-event@1",
  matchExisting: "chronicle.match-existing-events@1",
  planProposals: "chronicle.plan-proposals@1",
} as const;

export const CHRONICLE_EXTRACT_ARTIFACT_KINDS = {
  snapshot: "source.snapshot@1",
  windowPlan: "source.window-plan@1",
  observations: "chronicle.raw-observations@1",
  resolvedEvidence: "evidence.resolved@1",
  mergedObservations: "chronicle.merged-observations@1",
  clusters: "chronicle.event-clusters@1",
  hypotheses: "chronicle.event-hypotheses@1",
  matches: "chronicle.existing-event-matches@1",
  proposals: "chronicle.proposal-plan@1",
} as const;

const CHRONICLE_EXTRACT_DAG = [
  CHRONICLE_EXTRACT_TASK_KINDS.snapshot,
  CHRONICLE_EXTRACT_TASK_KINDS.windowPlan,
  CHRONICLE_EXTRACT_TASK_KINDS.observe,
  CHRONICLE_EXTRACT_TASK_KINDS.resolveEvidence,
  CHRONICLE_EXTRACT_TASK_KINDS.mergeObservations,
  CHRONICLE_EXTRACT_TASK_KINDS.cluster,
  CHRONICLE_EXTRACT_TASK_KINDS.synthesize,
  CHRONICLE_EXTRACT_TASK_KINDS.matchExisting,
  CHRONICLE_EXTRACT_TASK_KINDS.planProposals,
] as const;

const EVENT_SENTENCE_PATTERN =
  /[^。]*?(?:切れ|倒れた|崩れ落ちた|焼失した|避難した|移動を始めた|倒壊し|発令され|退避させた)[^。]*。/gu;

const NEGATED_EVENT_PATTERN = /(?:倒れていない|増えていなかった|動かず)/u;

const PLANNED_EVENT_PATTERN = /(?:しよう|するつもり|もし.+れば)/u;

export interface ChronicleExtractionRequest {
  readonly projectId: string;
  readonly folderId: string;
  readonly language: string;
  readonly sceneIds: readonly string[];
  readonly authority: MutationAuthority;
  readonly runId?: string;
  readonly specDigest?: string;
  readonly existingEvents?: readonly ExistingChronicleEventCatalogRecord[];
}

export interface ChronicleExtractionResult {
  readonly runId: string;
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly proposals: readonly CreateChronicleEventProposalPayloadV1[];
  readonly savedProposalSetId: string;
  readonly savedProposals: readonly SavedProposalSeed[];
}

export interface ExtractionCoordinatorDeps {
  readonly leaseOwner?: string;
  readonly buildSnapshot?: typeof buildProjectNarrativeSnapshot;
  readonly snapshotServices?: ProjectSnapshotAdapterServices;
  readonly createId?: () => string;
  /** When true, observation/synthesis stages call Stage AI paths. Default: fake regex. */
  readonly useAi?: boolean;
  readonly observeWithAi?: typeof runObservationExtractionTask;
  readonly synthesizeWithAi?: typeof runEventSynthesisTask;
}

interface SnapshotArtifactPayload {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly sourceViews: readonly NarrativeSourceView[];
}

interface WindowPlanArtifactPayload {
  readonly windows: readonly ExtractionWindow[];
}

interface ObservationArtifactPayload {
  readonly observations: readonly RawChronicleEventObservation[];
}

interface ResolvedEvidenceArtifactPayload {
  readonly anchors: readonly ResolvedEvidenceAnchor[];
}

interface ClusterArtifactPayload {
  readonly clusters: readonly {
    readonly clusterRef: string;
    readonly observationRefs: readonly string[];
    readonly blockingKey?: string;
  }[];
}

interface HypothesisArtifactPayload {
  readonly hypotheses: readonly EventHypothesis[];
}

interface MatchArtifactPayload {
  readonly matches: readonly {
    readonly hypothesisId: string;
    readonly match: ChronicleExistingMatch;
  }[];
}

interface ProposalPlanArtifactPayload {
  readonly proposals: readonly CreateChronicleEventProposalPayloadV1[];
  readonly proposalSetId?: string;
  /** Planned rows including match metadata for Review UI (PR4). */
  readonly planned?: readonly {
    readonly proposal: CreateChronicleEventProposalPayloadV1;
    readonly match: ChronicleExistingMatch;
    readonly hypothesisId: string;
  }[];
  readonly alreadySatisfied?: readonly {
    readonly hypothesisId: string;
    readonly title: string;
    readonly existingRef: string;
  }[];
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}

function digestStableString(value: string): Sha256Digest {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return `sha256:${hash.toString(16).padStart(64, "0")}` as Sha256Digest;
}

function mergeRanges(ranges: readonly CanonicalRange[]): CanonicalRange {
  const start = Math.min(...ranges.map((range) => range.start));
  const end = Math.max(...ranges.map((range) => range.end));
  return { start, end };
}

async function buildSourceViewsForPlan(
  snapshot: NarrativeCorpusSnapshot,
  plan: WindowPlan,
): Promise<readonly NarrativeSourceView[]> {
  const documentByRef = new Map(
    snapshot.documents.map((document) => [document.ref, document] as const),
  );
  const views: NarrativeSourceView[] = [];
  for (const window of plan.windows) {
    const document = documentByRef.get(window.documentRef);
    if (!document) continue;
    const covering = mergeRanges([
      ...window.ownedRanges,
      ...window.contextRanges,
    ]);
    views.push(
      await buildNarrativeSourceView({
        ref: window.sourceRef,
        document,
        documentRange: covering,
      }),
    );
  }
  return views;
}

function observationActuality(
  sentence: string,
): RawChronicleEventObservation["payload"]["actuality"] {
  if (PLANNED_EVENT_PATTERN.test(sentence)) return "planned";
  if (/したが、.+動かず/u.test(sentence) || /回そうとしたが/u.test(sentence)) {
    return "attempted";
  }
  return "actual";
}

function extractEventSentences(text: string): readonly string[] {
  const matches = [...text.matchAll(EVENT_SENTENCE_PATTERN)].map(
    (match) => match[0]?.trim() ?? "",
  );
  return matches.filter(
    (sentence) =>
      sentence.length > 0 &&
      !NEGATED_EVENT_PATTERN.test(sentence) &&
      !PLANNED_EVENT_PATTERN.test(sentence),
  );
}

function titleFromSentence(sentence: string): string {
  const trimmed = sentence.replace(/。$/u, "").trim();
  return trimmed.length <= 32 ? trimmed : `${trimmed.slice(0, 29)}...`;
}

export async function observeChronicleEventsFromSnapshot(
  _snapshot: NarrativeCorpusSnapshot,
  sourceViews: readonly NarrativeSourceView[],
  createId: () => string = defaultCreateId,
): Promise<readonly RawChronicleEventObservation[]> {
  const observations: RawChronicleEventObservation[] = [];
  for (const sourceView of sourceViews) {
    for (const sentence of extractEventSentences(sourceView.text)) {
      observations.push({
        localId: createId(),
        evidence: [{ sourceRef: sourceView.ref, quote: sentence }],
        assertion: {
          attribution: "narrator",
          narrativeFrame: "story-world",
        },
        payload: {
          predicate: sentence.replace(/。$/u, ""),
          actuality: observationActuality(sentence),
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      });
    }
  }
  return observations;
}

function evidenceFingerprint(sourceRef: string, quote: string): string {
  return chronicleEvidenceTupleKey(sourceRef, quote);
}

async function resolveObservationEvidence(
  snapshot: NarrativeCorpusSnapshot,
  sourceViews: readonly NarrativeSourceView[],
  observations: readonly RawChronicleEventObservation[],
): Promise<readonly ResolvedEvidenceAnchor[]> {
  let anchorIndex = 0;
  const anchors: ResolvedEvidenceAnchor[] = [];
  for (const observation of observations) {
    for (const evidence of observation.evidence) {
      const resolution = await resolveEvidenceReference(evidence, {
        snapshot,
        sourceViews,
        createAnchorId: () =>
          `anchor-${String(++anchorIndex).padStart(4, "0")}`,
      });
      if (resolution.status === "resolved") {
        anchors.push(resolution.anchor);
      }
    }
  }
  return anchors;
}

function synthesizeHypothesesFromClusters(
  clusters: ClusterArtifactPayload["clusters"],
  observations: readonly RawChronicleEventObservation[],
  createId: () => string,
): readonly EventHypothesis[] {
  const observationById = new Map(
    observations.map((observation) => [observation.localId, observation]),
  );
  return clusters.flatMap((cluster) => {
    const clusterObservations = cluster.observationRefs
      .map((ref) => observationById.get(ref))
      .filter(
        (observation): observation is RawChronicleEventObservation =>
          observation !== undefined,
      );
    if (clusterObservations.length === 0) return [];
    const primary = clusterObservations[0];
    const actuality = primary.payload.actuality;
    if (
      actuality !== "actual" &&
      actuality !== "attempted" &&
      actuality !== "prevented"
    ) {
      return [];
    }
    return [
      {
        hypothesisId: createId(),
        clusterRef: cluster.clusterRef,
        observationRefs: cluster.observationRefs,
        titleSuggestion: titleFromSentence(primary.payload.predicate),
        summary: primary.payload.predicate,
        actuality,
        significance: "major" as const,
      },
    ];
  });
}

function documentSourceKeyForRef(
  snapshot: NarrativeCorpusSnapshot,
  documentRef: string,
): string | null {
  return (
    snapshot.documents.find((document) => document.ref === documentRef)
      ?.sourceKey ?? null
  );
}

async function executeTask(
  taskKind: string,
  runId: string,
  taskExecution: {
    readonly projectId: string;
    readonly taskId: string;
    readonly attemptId: string;
  },
  request: ChronicleExtractionRequest,
  deps: ExtractionCoordinatorDeps,
  createId: () => string,
): Promise<{
  outputJson: Readonly<Record<string, unknown>>;
  artifacts: ReturnType<typeof buildInlineJsonArtifact>[];
}> {
  switch (taskKind) {
    case CHRONICLE_EXTRACT_TASK_KINDS.snapshot: {
      throw new Error(
        "source.snapshot@1 must be seeded before the coordinator loop",
      );
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.windowPlan: {
      const snapshotPayload =
        await loadInlineJsonArtifact<SnapshotArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
        );
      if (!snapshotPayload) {
        throw new Error("Missing source.snapshot@1 artifact");
      }
      const plan = planExtractionWindows(snapshotPayload.snapshot);
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.windowPlan,
        { windows: plan.windows },
      );
      return {
        outputJson: { windowCount: plan.windows.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.observe: {
      const snapshotPayload =
        await loadInlineJsonArtifact<SnapshotArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
        );
      const windowPayload =
        await loadInlineJsonArtifact<WindowPlanArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.windowPlan,
        );
      if (!snapshotPayload || !windowPayload) {
        throw new Error("Missing snapshot or window-plan artifacts");
      }

      let observations: readonly RawChronicleEventObservation[];
      if (deps.useAi) {
        const observe = deps.observeWithAi ?? runObservationExtractionTask;
        const sourceByRef = new Map(
          snapshotPayload.sourceViews.map((view) => [view.ref, view] as const),
        );
        const collected: RawChronicleEventObservation[] = [];
        for (const window of windowPayload.windows) {
          const view = sourceByRef.get(window.sourceRef);
          if (!view) continue;
          const batch = await observe({
            windows: [{ sourceRef: window.sourceRef, text: view.text }],
            projectId: request.projectId,
            createId,
            stageExecution: createStageExecutionContext({
              projectId: taskExecution.projectId,
              runId,
              taskId: taskExecution.taskId,
              attemptId: taskExecution.attemptId,
              stageId: NARRATIVE_STAGE_IDS.observationExtraction,
              stageExecutionId: createId(),
            }),
            createStageExecutionId: createId,
          });
          collected.push(...rekeyObservationsForWindow(window.windowId, batch));
        }
        observations = collected;
      } else {
        observations = await observeChronicleEventsFromSnapshot(
          snapshotPayload.snapshot,
          snapshotPayload.sourceViews,
          createId,
        );
      }
      assertUniqueObservationLocalIds(observations);

      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
        { observations },
      );
      return {
        outputJson: { observationCount: observations.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.resolveEvidence: {
      const snapshotPayload =
        await loadInlineJsonArtifact<SnapshotArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
        );
      const observationPayload =
        await loadInlineJsonArtifact<ObservationArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
        );
      if (!snapshotPayload || !observationPayload) {
        throw new Error("Missing snapshot or observation artifacts");
      }
      const anchors = await resolveObservationEvidence(
        snapshotPayload.snapshot,
        snapshotPayload.sourceViews,
        observationPayload.observations,
      );
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
        { anchors },
      );
      return {
        outputJson: { anchorCount: anchors.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.mergeObservations: {
      const observationPayload =
        await loadInlineJsonArtifact<ObservationArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
        );
      if (!observationPayload) {
        throw new Error("Missing observation artifact");
      }
      const observations = mergeObservationsByEvidence(
        observationPayload.observations,
      );
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
        { observations },
      );
      return {
        outputJson: { observationCount: observations.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.cluster: {
      const mergedPayload =
        await loadInlineJsonArtifact<ObservationArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
        );
      if (!mergedPayload) {
        throw new Error("Missing merged observation artifact");
      }
      const clusters = clusterEventObservations(mergedPayload.observations);
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.clusters,
        { clusters },
      );
      return {
        outputJson: { clusterCount: clusters.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.synthesize: {
      const mergedPayload =
        await loadInlineJsonArtifact<ObservationArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
        );
      const clusterPayload =
        await loadInlineJsonArtifact<ClusterArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.clusters,
        );
      if (!mergedPayload || !clusterPayload) {
        throw new Error("Missing merge/cluster artifacts");
      }

      let hypotheses: readonly EventHypothesis[];
      if (deps.useAi) {
        const synthesize = deps.synthesizeWithAi ?? runEventSynthesisTask;
        const observationById = new Map(
          mergedPayload.observations.map(
            (observation) => [observation.localId, observation] as const,
          ),
        );
        const collected: EventHypothesis[] = [];
        for (const cluster of clusterPayload.clusters) {
          const clusterObservations = cluster.observationRefs
            .map((ref) => observationById.get(ref))
            .filter(
              (observation): observation is RawChronicleEventObservation =>
                observation !== undefined,
            );
          const batch = await synthesize({
            clusterRef: cluster.clusterRef,
            observations: clusterObservations,
            projectId: request.projectId,
            createId,
            stageExecution: createStageExecutionContext({
              projectId: taskExecution.projectId,
              runId,
              taskId: taskExecution.taskId,
              attemptId: taskExecution.attemptId,
              stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
              stageExecutionId: createId(),
            }),
            createStageExecutionId: createId,
          });
          collected.push(...batch);
        }
        hypotheses = collected;
      } else {
        hypotheses = synthesizeHypothesesFromClusters(
          clusterPayload.clusters,
          mergedPayload.observations,
          createId,
        );
      }

      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
        { hypotheses },
      );
      return {
        outputJson: { hypothesisCount: hypotheses.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.matchExisting: {
      const snapshotPayload =
        await loadInlineJsonArtifact<SnapshotArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
        );
      const observationPayload =
        await loadInlineJsonArtifact<ObservationArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
        );
      const evidencePayload =
        await loadInlineJsonArtifact<ResolvedEvidenceArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
        );
      const hypothesisPayload =
        await loadInlineJsonArtifact<HypothesisArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
        );
      if (
        !snapshotPayload ||
        !observationPayload ||
        !evidencePayload ||
        !hypothesisPayload
      ) {
        throw new Error("Missing artifacts for existing-event match");
      }

      const observationById = new Map(
        observationPayload.observations.map(
          (observation) => [observation.localId, observation] as const,
        ),
      );
      const anchorsByQuote = new Map<
        string,
        Map<string, ResolvedEvidenceAnchor | null>
      >();
      for (const anchor of evidencePayload.anchors) {
        const anchorsBySource =
          anchorsByQuote.get(anchor.sourceRef) ?? new Map();
        const existing = anchorsBySource.get(anchor.quote);
        if (!anchorsBySource.has(anchor.quote)) {
          anchorsBySource.set(anchor.quote, anchor);
        } else if (
          existing === null ||
          existing?.documentRef !== anchor.documentRef
        ) {
          anchorsBySource.set(anchor.quote, null);
        }
        anchorsByQuote.set(anchor.sourceRef, anchorsBySource);
      }

      const matches = hypothesisPayload.hypotheses.map((hypothesis) => {
        const provenanceKeys: string[] = [];
        const documentSourceKeys: string[] = [];
        for (const observationRef of hypothesis.observationRefs) {
          const observation = observationById.get(observationRef);
          if (!observation) continue;
          for (const evidence of observation.evidence) {
            const anchor = anchorsByQuote
              .get(evidence.sourceRef)
              ?.get(evidence.quote);
            if (!anchor) continue;
            provenanceKeys.push(
              evidenceFingerprint(evidence.sourceRef, evidence.quote),
            );
            const sourceKey = documentSourceKeyForRef(
              snapshotPayload.snapshot,
              anchor.documentRef,
            );
            if (sourceKey) documentSourceKeys.push(sourceKey);
          }
        }
        const match = matchExistingChronicleEvent(
          {
            hypothesis,
            evidenceDocumentSourceKeys: [...new Set(documentSourceKeys)],
            provenanceKeys,
          },
          request.existingEvents ?? [],
        );
        return { hypothesisId: hypothesis.hypothesisId, match };
      });

      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.matches,
        { matches },
      );
      return {
        outputJson: { matchCount: matches.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.planProposals: {
      const observationPayload =
        await loadInlineJsonArtifact<ObservationArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
        );
      const evidencePayload =
        await loadInlineJsonArtifact<ResolvedEvidenceArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
        );
      const hypothesisPayload =
        await loadInlineJsonArtifact<HypothesisArtifactPayload>(
          runId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
        );
      const matchPayload = await loadInlineJsonArtifact<MatchArtifactPayload>(
        runId,
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.matches,
      );
      if (
        !observationPayload ||
        !evidencePayload ||
        !hypothesisPayload ||
        !matchPayload
      ) {
        throw new Error("Missing synthesis inputs for proposal planning");
      }
      const matchesByHypothesisId = new Map(
        matchPayload.matches.map(
          (entry) => [entry.hypothesisId, entry.match] as const,
        ),
      );
      const planned = planChronicleEventProposals({
        hypotheses: hypothesisPayload.hypotheses,
        observations: observationPayload.observations,
        anchors: evidencePayload.anchors,
        matchesByHypothesisId,
        createId,
      });
      const proposals = planned.map((entry) => entry.proposal);
      const hypothesisById = new Map(
        hypothesisPayload.hypotheses.map(
          (hypothesis) => [hypothesis.hypothesisId, hypothesis] as const,
        ),
      );
      const alreadySatisfied = matchPayload.matches.flatMap((entry) => {
        if (entry.match.status !== "already-satisfied") return [];
        const hypothesis = hypothesisById.get(entry.hypothesisId);
        if (!hypothesis) return [];
        return [
          {
            hypothesisId: entry.hypothesisId,
            title: hypothesis.titleSuggestion,
            existingRef: entry.match.existingRef,
          },
        ];
      });
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
        {
          proposals,
          planned: planned.map((entry) => ({
            proposal: entry.proposal,
            match: entry.match,
            hypothesisId: entry.hypothesisId,
          })),
          alreadySatisfied,
        },
      );
      return {
        outputJson: {
          proposalCount: proposals.length,
          alreadySatisfiedCount: alreadySatisfied.length,
        },
        artifacts: [draft],
      };
    }
    default:
      throw new Error(
        `Unsupported narrative extraction task kind: ${taskKind}`,
      );
  }
}

export async function runChronicleExtractionCoordinator(
  request: ChronicleExtractionRequest,
  deps: ExtractionCoordinatorDeps = {},
): Promise<ChronicleExtractionResult> {
  const createId = deps.createId ?? defaultCreateId;
  const leaseOwner = deps.leaseOwner ?? "narrative-extraction-coordinator";
  const buildSnapshot = deps.buildSnapshot ?? buildProjectNarrativeSnapshot;

  const snapshotResult = await buildSnapshot(
    {
      projectId: request.projectId,
      folderId: request.folderId,
      language: request.language,
      sceneIds: request.sceneIds,
      authority: request.authority,
    },
    deps.snapshotServices,
  );
  if (!snapshotResult.ok) {
    throw new Error(
      `Snapshot build failed: ${snapshotResult.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(", ")}`,
    );
  }

  const windowPlan = planExtractionWindows(snapshotResult.snapshot);
  const sourceViews = await buildSourceViewsForPlan(
    snapshotResult.snapshot,
    windowPlan,
  );

  const snapshotDraft = buildInlineJsonArtifact(
    CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
    {
      snapshot: snapshotResult.snapshot,
      sourceViews,
    },
  );

  const createdRun = await createRun({
    runId: request.runId,
    projectId: request.projectId,
    surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
    scopeJson: {
      folderId: request.folderId,
      sceneIds: [...request.sceneIds],
    },
    specJson: {
      domain: "chronicle",
      version: 1,
      taskChain: [...CHRONICLE_EXTRACT_DAG],
    },
    specDigest:
      request.specDigest ?? digestStableString("chronicle.extract.v1"),
    snapshotDigest: snapshotResult.snapshot.digest,
    coverageJson: {
      mode: "complete",
      documentCount: snapshotResult.snapshot.documents.length,
      windowCount: windowPlan.windows.length,
    },
    tasks: CHRONICLE_EXTRACT_DAG.map((taskKind, index) => ({
      taskKind,
      priority: CHRONICLE_EXTRACT_DAG.length - index,
      inputJson: { stage: index + 1 },
    })),
  });

  const runId = createdRun.runId;
  let historicalScopeAuthorityBasis: NarrativeScopeAuthorityBasisV2 | undefined;
  try {
    historicalScopeAuthorityBasis =
      snapshotResult.scopeAuthorityDocuments.length === 0
        ? undefined
        : await buildNarrativeScopeAuthorityBasisV2({
            projectId: request.projectId,
            runId,
            corpusDigest: snapshotResult.snapshot.digest,
            documents: snapshotResult.scopeAuthorityDocuments,
          });
  } catch (error) {
    try {
      await cancelRun(runId, request.projectId);
    } catch {
      // Prefer the invalid historical authority failure; cancel is best-effort.
    }
    throw error;
  }
  let savedProposalSetId: string | undefined;
  let savedProposals: readonly SavedProposalSeed[] = [];

  for (const taskKind of CHRONICLE_EXTRACT_DAG) {
    let claim;
    try {
      claim = await narrativeExtractionClaimTask({
        runId,
        projectId: request.projectId,
        leaseOwner,
        taskKinds: [taskKind],
      });
    } catch (error) {
      try {
        await cancelRun(runId, request.projectId);
      } catch {
        // Prefer original claim failure; cancel is best-effort.
      }
      throw error;
    }
    if (!claim.claimed || !claim.task) {
      try {
        await cancelRun(runId, request.projectId);
      } catch {
        // Prefer original claim failure; cancel is best-effort.
      }
      throw new Error(`Failed to claim task ${taskKind}`);
    }

    try {
      if (taskKind === CHRONICLE_EXTRACT_TASK_KINDS.snapshot) {
        rememberInlineJsonArtifact({
          runId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          draft: snapshotDraft,
        });
        await narrativeExtractionFinishTask({
          runId,
          projectId: request.projectId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          leaseOwner,
          outputJson: {
            snapshotDigest: snapshotResult.snapshot.digest,
            documentCount: snapshotResult.snapshot.documents.length,
          },
          artifacts: [snapshotDraft.artifactInput],
          ...(historicalScopeAuthorityBasis
            ? { historicalScopeAuthorityBasis }
            : {}),
        });
        continue;
      }

      const executed = await executeTask(
        taskKind,
        runId,
        {
          projectId: request.projectId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
        },
        request,
        deps,
        createId,
      );

      let artifacts = executed.artifacts;
      let outputJson = executed.outputJson;

      // Persist ProposalSet before finishing the last task so Run cannot become
      // `completed` without a durable review ledger.
      if (taskKind === CHRONICLE_EXTRACT_TASK_KINDS.planProposals) {
        const proposalDraft = artifacts.find(
          (draft) =>
            draft.artifactKind === CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
        );
        const proposalPayload =
          (proposalDraft?.payloadJson as
            | ProposalPlanArtifactPayload
            | undefined) ?? null;
        const proposals = proposalPayload?.proposals ?? [];
        const evidencePayload =
          await loadInlineJsonArtifact<ResolvedEvidenceArtifactPayload>(
            runId,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
          );
        if (!evidencePayload) {
          throw new Error("Missing resolved evidence for proposal persistence");
        }
        const saved = await saveChronicleProposalSet({
          runId,
          projectId: request.projectId,
          taskId: claim.task.taskId,
          sourceRevisionToken: snapshotResult.snapshot.digest,
          sourceBasis: buildSnapshotSourceBasis(runId, snapshotResult.snapshot),
          summaryJson: {
            proposalCount: proposals.length,
            surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
          },
          evidenceById: new Map(
            evidencePayload.anchors.map((anchor) => [
              anchor.id,
              {
                documentRef: anchor.documentRef,
                quote: anchor.quote,
                quoteDigest: anchor.quoteDigest,
                sourceKey:
                  snapshotResult.snapshot.documents.find(
                    (document) => document.ref === anchor.documentRef,
                  )?.origin.kind === "project-node"
                    ? `project:scene:${snapshotResult.snapshot.documents.find((document) => document.ref === anchor.documentRef)?.origin.nodeId}`
                    : undefined,
                revisionToken: (() => {
                  const document = snapshotResult.snapshot.documents.find(
                    (item) => item.ref === anchor.documentRef,
                  );
                  return document?.origin.kind === "project-node"
                    ? `v${document.origin.sourceVersion}@${document.origin.sourceUpdatedAt}`
                    : undefined;
                })(),
              },
            ]),
          ),
          proposals: proposals.map((proposal, index) => ({
            proposalKey: `${proposal.eventId}:${index}`,
            payload: proposal,
          })),
        });
        savedProposalSetId = saved.proposalSetId;
        savedProposals = saved.proposals;
        if (proposalDraft && proposalPayload) {
          const bound = buildInlineJsonArtifact(
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
            {
              ...proposalPayload,
              proposalSetId: saved.proposalSetId,
            },
            proposalDraft.artifactId,
          );
          artifacts = artifacts.map((draft) =>
            draft.artifactKind === CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals
              ? bound
              : draft,
          );
          outputJson = {
            ...outputJson,
            proposalSetId: saved.proposalSetId,
            proposalCount: proposals.length,
          };
        }
      }

      for (const draft of artifacts) {
        rememberInlineJsonArtifact({
          runId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          draft,
        });
      }
      await narrativeExtractionFinishTask({
        runId,
        projectId: request.projectId,
        taskId: claim.task.taskId,
        attemptId: claim.task.attemptId,
        leaseOwner,
        outputJson,
        artifacts: artifacts.map((draft) => draft.artifactInput),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "chronicle extraction task failed";
      try {
        await narrativeExtractionFailTask({
          runId,
          projectId: request.projectId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          leaseOwner,
          errorMessage: message,
          requeue: false,
        });
      } catch {
        // Prefer original task failure; ledger fail is best-effort after primary error.
      }
      throw error;
    }
  }

  const proposalPayload =
    await loadInlineJsonArtifact<ProposalPlanArtifactPayload>(
      runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
    );
  const proposals = proposalPayload?.proposals ?? [];
  if (!savedProposalSetId) {
    throw new Error("Missing proposalSetId after chronicle extraction");
  }

  return {
    runId,
    snapshot: snapshotResult.snapshot,
    proposals,
    savedProposalSetId,
    savedProposals,
  };
}

export { CHRONICLE_EVENT_PROPOSAL_KIND };
