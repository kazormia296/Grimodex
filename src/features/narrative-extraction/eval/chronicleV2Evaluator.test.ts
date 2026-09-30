import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  runEventSynthesisTask,
  type RunEventSynthesisTaskInput,
} from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import {
  runObservationExtractionTask,
  type RunObservationExtractionTaskInput,
} from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import { CITATION_ID_OBSERVATION_EVIDENCE_MODE } from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import {
  loadChronicleV2Contract,
  type ChronicleV2Contract,
} from "./chronicleV2Contract";
import {
  chronicleV2CoversAllRanges,
  evaluateChronicleV2Production,
} from "./chronicleV2Evaluator";
import {
  buildChronicleV2Diagnostics,
  validateChronicleV2Diagnostics,
} from "./chronicleV2Diagnostics";
import {
  prepareProductionChronicleEvalCase,
  runProductionChroniclePipeline,
} from "./productionChronicleAdapter";
import type {
  PreparedProductionChronicleEvalCase,
  ProductionChronicleArtifacts,
} from "./productionChronicleTypes";
import { loadNarrativeEvalSuite } from "./narrativeEvalSuite";
import {
  bindEvidenceSpanCatalog,
  type EvidenceSpanCatalogBinding,
} from "../evidence/spanCatalog";
import { buildNarrativeSourceView } from "../source/sourceView";
import type { NarrativeEvalCaseV1 } from "./types";

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: () => ({
    apiVariant: undefined,
    model: "chronicle-v2-fixture-model",
    provider: "chronicle-v2-fixture",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "chronicle-v2-evaluator-test" }),
  },
}));

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

type Mutation =
  | "correct"
  | "empty"
  | "minor-suppressed"
  | "wrong-predicate"
  | "wrong-plus-unknown"
  | "role-swap"
  | "missing-destination"
  | "bell-evacuate-conflation"
  | "combined"
  | "wrong-attribution"
  | "wrong-frame"
  | "wrong-actuality"
  | "unknown-extra"
  | "targeted-extra"
  | "fabricated-extra"
  | "semantic-duplicate"
  | "unsupported-reference"
  | "wrong-sentence-direct"
  | "small-window"
  | "context-only-negative"
  | "wrong-predicate-unknown-attribution"
  | "unknown-attribution-only"
  | "partial-participant-unknown"
  | "missing-agent"
  | "unknown-two-participants"
  | "two-partial-unknown"
  | "three-exact-compatible-unknown"
  | "compatible-unknown-fifth"
  | "temporal-morning"
  | "temporal-unknown"
  | "temporal-empty"
  | "temporal-extra"
  | "temporal-unscored"
  | "temporal-non-string";

interface V2FixtureContext {
  readonly evalCase: Awaited<
    ReturnType<typeof loadNarrativeEvalSuite>
  >["cases"][number];
  readonly contract: ChronicleV2Contract;
}

async function loadFixtureContext(): Promise<V2FixtureContext> {
  const suite = await loadNarrativeEvalSuite({
    repoRoot,
    suiteId: "chronicle-micro-v1",
  });
  const evalCase = suite.cases.find(
    (candidate) => candidate.id === "chronicle.micro.actual-gate-collapse-001",
  );
  if (!evalCase) throw new Error("North Gate v1 case is missing");
  const contractText = await readFile(
    path.join(
      repoRoot,
      "evals/narrative/contracts/chronicle-v2/actual-gate-collapse.json",
    ),
    "utf8",
  );
  const loaded = loadChronicleV2Contract(JSON.parse(contractText) as unknown);
  if (!loaded.ok) {
    throw new Error(
      `Chronicle v2 fixture failed to load: ${loaded.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(", ")}`,
    );
  }
  const contract = loaded.value;
  const sourceDocumentsOnlyEvalCase: NarrativeEvalCaseV1 = {
    ...evalCase,
    coverage: {
      ...evalCase.coverage,
      includedDocumentIds: contract.sourceDocuments.map(
        (document) => document.id,
      ),
      omittedDocumentIds: [],
    },
    documents: contract.sourceDocuments.map((document) => ({ ...document })),
    expected: { observations: { required: [], forbidden: [] } },
    criticalViolationClasses: [],
  };
  return { evalCase: sourceDocumentsOnlyEvalCase, contract };
}

async function prepareWithRuntimeDocumentIds(
  context: V2FixtureContext,
): Promise<PreparedProductionChronicleEvalCase> {
  const runtimeDocuments = context.evalCase.documents.map((document) => ({
    ...document,
    id: `prepared-${document.id}`,
  }));
  const runtimeEvalCase: NarrativeEvalCaseV1 = {
    ...context.evalCase,
    coverage: {
      ...context.evalCase.coverage,
      includedDocumentIds: runtimeDocuments.map((document) => document.id),
      omittedDocumentIds: [],
    },
    documents: runtimeDocuments,
  };
  return prepareProductionChronicleEvalCase(runtimeEvalCase, {
    evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  });
}

const FIXED_SOURCE_QUOTE_A = "夜半、北門の鎖が切れ、重い門扉が街路へ倒れた。";
const FIXED_SOURCE_QUOTE_B = "衛兵は鐘を鳴らし、通行人を広場へ退避させた。";

interface FixedObservationClaim {
  readonly sourceQuote: string;
  readonly predicate: string;
  readonly participants: readonly {
    readonly surface: string;
    readonly role: string;
  }[];
}

const FIXED_OBSERVATION_CLAIMS: readonly FixedObservationClaim[] = [
  {
    sourceQuote: FIXED_SOURCE_QUOTE_A,
    predicate: "鎖が切れた",
    participants: [{ surface: "north-gate-chain", role: "theme" }],
  },
  {
    sourceQuote: FIXED_SOURCE_QUOTE_A,
    predicate: "門扉が倒れた",
    participants: [
      { surface: "gate-leaf", role: "theme" },
      { surface: "street", role: "destination" },
    ],
  },
  {
    sourceQuote: FIXED_SOURCE_QUOTE_B,
    predicate: "鐘を鳴らした",
    participants: [
      { surface: "guard", role: "agent" },
      { surface: "bell", role: "theme" },
    ],
  },
  {
    sourceQuote: FIXED_SOURCE_QUOTE_B,
    predicate: "退避させた",
    participants: [
      { surface: "guard", role: "agent" },
      { surface: "passerby", role: "theme" },
      { surface: "square", role: "destination" },
    ],
  },
];

function sourceEntryForQuote(
  binding: EvidenceSpanCatalogBinding,
  quote: string,
) {
  const entries = binding.catalog.entries
    .filter((entry) => entry.quote === quote)
    .sort(
      (left, right) =>
        left.canonicalRange.end -
          left.canonicalRange.start -
          (right.canonicalRange.end - right.canonicalRange.start) ||
        left.canonicalId.localeCompare(right.canonicalId),
    );
  const entry = entries[0];
  if (!entry)
    throw new Error(`No catalog occurrence contains fixed quote: ${quote}`);
  return entry;
}

function aliasForQuote(
  binding: EvidenceSpanCatalogBinding,
  quote: string,
): string {
  const entry = sourceEntryForQuote(binding, quote);
  const alias = binding.aliases.find(
    (candidate) => candidate.canonicalSourceRef === entry.sourceRef,
  )?.alias;
  if (!alias)
    throw new Error(`No request alias contains fixed quote: ${quote}`);
  return alias;
}

function fixedObservationClaims(
  mutation: Mutation,
): readonly FixedObservationClaim[] {
  const claims = FIXED_OBSERVATION_CLAIMS.map((claim) => ({
    ...claim,
    participants: claim.participants.map((participant) => ({ ...participant })),
  }));
  if (mutation === "role-swap") {
    // The second fixed row is the gate-fall control.
    const gate = claims[1];
    if (gate) {
      claims[1] = {
        ...gate,
        participants: [
          { surface: "gate-leaf", role: "destination" },
          { surface: "street", role: "theme" },
        ],
      };
    }
  }
  if (mutation === "wrong-predicate") {
    const gate = claims[1];
    if (gate) claims[1] = { ...gate, predicate: "門扉を修復した" };
  }
  if (mutation === "wrong-plus-unknown") {
    const gate = claims[1];
    if (gate) claims[1] = { ...gate, predicate: "門扉を修復した" };
  }
  if (mutation === "wrong-predicate-unknown-attribution") {
    const gate = claims[1];
    if (gate) claims[1] = { ...gate, predicate: "門扉を修復した" };
  }
  if (mutation === "partial-participant-unknown") {
    const gate = claims[1];
    if (gate) {
      claims[1] = {
        ...gate,
        participants: [
          { surface: "gate-leaf", role: "destination" },
          { surface: "unrecognized-entity", role: "destination" },
        ],
      };
    }
  }
  if (mutation === "missing-agent") {
    const evacuation = claims[3];
    if (evacuation) {
      claims[3] = {
        ...evacuation,
        participants: evacuation.participants.slice(1),
      };
    }
  }
  if (mutation === "two-partial-unknown") {
    const gate = claims[1];
    if (gate) {
      claims[1] = {
        ...gate,
        predicate: "unrecognized-event",
        participants: [
          { surface: "gate-leaf", role: "theme" },
          { surface: "unrecognized-entity-a", role: "unrecognized-role-a" },
        ],
      };
    }
    const bell = claims[2];
    if (bell) {
      claims[2] = {
        ...bell,
        predicate: "unrecognized-event",
        participants: [
          { surface: "guards", role: "agent" },
          { surface: "unrecognized-entity-b", role: "unrecognized-role-b" },
        ],
      };
    }
  }
  if (mutation === "three-exact-compatible-unknown") {
    const evacuation = claims[3];
    if (evacuation) {
      claims[3] = { ...evacuation, predicate: "unrecognized-event" };
    }
  }
  if (mutation === "wrong-sentence-direct") {
    const evacuation = claims[3];
    if (evacuation) {
      claims[3] = { ...evacuation, sourceQuote: FIXED_SOURCE_QUOTE_A };
    }
  }
  if (mutation === "small-window" || mutation === "context-only-negative") {
    return claims.slice(0, 2);
  }
  if (mutation === "missing-destination") {
    const evacuation = claims[3];
    if (evacuation) {
      claims[3] = {
        ...evacuation,
        participants: evacuation.participants.slice(0, 2),
      };
    }
  }
  if (mutation === "bell-evacuate-conflation") {
    const evacuation = claims[3];
    if (evacuation) claims[3] = { ...evacuation, predicate: "鐘を鳴らした" };
  }
  if (mutation === "combined") {
    const chain = claims[0];
    if (chain) {
      claims[0] = {
        ...chain,
        predicate: "鎖が切れ、門扉が倒れた",
      };
    }
  }
  return claims;
}

function observationResponse(
  binding: EvidenceSpanCatalogBinding,
  mutation: Mutation,
  includeSemanticDuplicate = false,
): string {
  if (mutation === "empty") return JSON.stringify({ observations: [] });
  if (mutation === "unknown-two-participants") {
    return JSON.stringify({
      observations: [
        {
          localId: "model-unknown-two-participants",
          evidenceRefs: [
            aliasForQuote(binding, FIXED_SOURCE_QUOTE_A),
            aliasForQuote(binding, FIXED_SOURCE_QUOTE_B),
          ],
          assertion: {
            attribution: "narrator",
            narrativeFrame: "story-world",
          },
          payload: {
            predicate: "unrecognized-event",
            actuality: "actual",
            participants: [
              { surface: "unrecognized-entity-a", role: "unrecognized-role-a" },
              { surface: "unrecognized-entity-b", role: "unrecognized-role-b" },
            ],
            temporalExpressions: [],
            durationKind: "instant",
          },
        },
      ],
    });
  }
  const observations = fixedObservationClaims(mutation).map((claim, index) => ({
    localId: `model-fixed-${index + 1}`,
    evidenceRefs: [
      mutation === "unsupported-reference" && index === 0
        ? "foreign-evidence-reference"
        : aliasForQuote(binding, claim.sourceQuote),
    ],
    assertion: {
      attribution:
        mutation === "wrong-attribution" && index === 0
          ? "character-said"
          : mutation === "unknown-attribution-only" && index === 0
            ? "unknown"
            : mutation === "wrong-predicate-unknown-attribution" && index === 1
              ? "unknown"
              : "narrator",
      narrativeFrame:
        mutation === "wrong-frame" && index === 0 ? "flashback" : "story-world",
    },
    payload: {
      predicate: claim.predicate,
      actuality:
        mutation === "wrong-actuality" && index === 0 ? "planned" : "actual",
      participants: claim.participants,
      temporalExpressions:
        index < 2
          ? mutation === "temporal-morning"
            ? ["朝"]
            : mutation === "temporal-unknown"
              ? ["見知らぬ時間"]
              : mutation === "temporal-empty"
                ? []
                : mutation === "temporal-extra"
                  ? index === 0
                    ? ["夜半", "朝", "見知らぬ時間"]
                    : ["夜半", "2026年9月6日"]
                  : mutation === "temporal-non-string"
                    ? index === 0
                      ? [123, true, null]
                      : ["夜半", 123]
                    : ["夜半"]
          : mutation === "temporal-unscored"
            ? ["朝", "見知らぬ時間"]
            : [],
      durationKind: "instant",
    },
  }));
  if (
    mutation === "unknown-extra" ||
    mutation === "wrong-plus-unknown" ||
    mutation === "targeted-extra" ||
    mutation === "fabricated-extra" ||
    mutation === "compatible-unknown-fifth"
  ) {
    const compatibleUnknownFifth = mutation === "compatible-unknown-fifth";
    observations.push({
      localId: "model-outside-annotation",
      evidenceRefs: [
        aliasForQuote(
          binding,
          mutation === "targeted-extra" || mutation === "fabricated-extra"
            ? FIXED_SOURCE_QUOTE_B
            : FIXED_SOURCE_QUOTE_A,
        ),
      ],
      assertion: {
        attribution: "narrator",
        narrativeFrame: "story-world",
      },
      payload: {
        predicate: compatibleUnknownFifth
          ? "unrecognized-event"
          : mutation === "targeted-extra" || mutation === "fabricated-extra"
            ? "鐘が壊れた"
            : "自由記述の出来事",
        actuality: "actual",
        participants: compatibleUnknownFifth
          ? [{ surface: "north-gate-chain", role: "theme" }]
          : mutation === "targeted-extra" || mutation === "fabricated-extra"
            ? [{ surface: "bell", role: "theme" }]
            : [],
        temporalExpressions: [],
        durationKind: "instant",
      },
    });
  }
  if (includeSemanticDuplicate) {
    const gate = FIXED_OBSERVATION_CLAIMS[1];
    if (!gate) throw new Error("Gate-fall control is missing");
    observations.push({
      localId: "model-semantic-duplicate",
      evidenceRefs: [aliasForQuote(binding, gate.sourceQuote)],
      assertion: {
        attribution: "narrator",
        narrativeFrame: "story-world",
      },
      payload: {
        predicate: gate.predicate,
        actuality: "actual",
        participants: [...gate.participants].reverse(),
        temporalExpressions: [],
        durationKind: "instant",
      },
    });
  }
  return JSON.stringify({ observations });
}

async function runFixturePipeline(
  context: V2FixtureContext,
  mutation: Mutation,
  preparedOverride?: PreparedProductionChronicleEvalCase,
): Promise<{
  readonly prepared: PreparedProductionChronicleEvalCase;
  readonly artifacts: ProductionChronicleArtifacts;
}> {
  const prepared =
    preparedOverride ??
    (await prepareProductionChronicleEvalCase(context.evalCase, {
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    }));
  let duplicateEmitted = false;
  const artifacts = await runProductionChroniclePipeline(prepared, {
    createId: (() => {
      let index = 0;
      return () => `chronicle-v2-test-${++index}`;
    })(),
    observeWithAi: (input: RunObservationExtractionTaskInput) => {
      const binding = input.evidenceSpanCatalogBinding;
      if (!binding) throw new Error("Production observation lost its binding");
      const canEmitDuplicate =
        mutation === "semantic-duplicate" &&
        !duplicateEmitted &&
        binding.aliases.some((alias) => {
          const entry = binding.catalog.entries.find(
            (candidate) => candidate.quote === FIXED_SOURCE_QUOTE_A,
          );
          const windowId = binding.windows[0]?.windowId;
          return (
            entry !== undefined &&
            alias.canonicalSourceRef === entry.sourceRef &&
            (windowId === undefined || alias.windowIds.includes(windowId))
          );
        });
      if (canEmitDuplicate) duplicateEmitted = true;
      return runObservationExtractionTask({
        ...input,
        send: async () => ({
          text: observationResponse(binding, mutation, canEmitDuplicate),
          inputTokens: 1,
          outputTokens: 1,
        }),
      });
    },
    synthesizeWithAi: (input: RunEventSynthesisTaskInput) =>
      runEventSynthesisTask({
        ...input,
        send: async () => ({
          text: JSON.stringify({
            clusterRef: input.clusterRef,
            resolution: "single-event",
            events: [
              {
                observationRefs: input.observations.map(
                  (observation) => observation.localId,
                ),
                titleSuggestion: "北門の出来事",
                summary: "北門周辺で起きた出来事",
                actuality: "actual",
                significance:
                  mutation === "minor-suppressed" ? "minor" : "major",
              },
            ],
          }),
          inputTokens: 1,
          outputTokens: 1,
        }),
      }),
  });
  return { prepared, artifacts };
}

async function evaluateFixture(
  context: V2FixtureContext,
  mutation: Mutation,
  contract: ChronicleV2Contract = context.contract,
  preparedOverride?: PreparedProductionChronicleEvalCase,
) {
  const { prepared, artifacts } = await runFixturePipeline(
    context,
    mutation,
    preparedOverride,
  );
  const evaluation = await evaluateChronicleV2Production(
    prepared,
    artifacts,
    contract,
  );
  await assertDiagnosticRoundTrip(evaluation, contract);
  return { prepared, artifacts, evaluation };
}

async function assertDiagnosticRoundTrip(
  evaluation: Awaited<ReturnType<typeof evaluateChronicleV2Production>>,
  contract: ChronicleV2Contract,
) {
  const projection = await buildChronicleV2Diagnostics({
    evaluation,
    contract,
  });
  const validation = await validateChronicleV2Diagnostics(projection, {
    evaluation,
    contract,
  });
  expect(validation.ok).toBe(true);
  if (!validation.ok) {
    throw new Error(
      `Chronicle v2 diagnostic integration failed: ${validation.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(", ")}`,
    );
  }
  return projection;
}

async function prepareFullSourceWindow(
  context: V2FixtureContext,
): Promise<PreparedProductionChronicleEvalCase> {
  const prepared = await prepareProductionChronicleEvalCase(context.evalCase, {
    evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  });
  const firstWindow = prepared.windows[0];
  const firstBinding = firstWindow?.windowId
    ? prepared.evidenceSpanCatalogBindingsByWindowId?.get(firstWindow.windowId)
    : undefined;
  const firstBindingWindow = firstBinding?.windows[0];
  const document = firstBindingWindow
    ? prepared.fixture.snapshot.documents.find(
        (candidate) => candidate.ref === firstBindingWindow.documentRef,
      )
    : undefined;
  if (
    !firstWindow?.windowId ||
    !firstBinding ||
    !firstBindingWindow ||
    !document ||
    !prepared.evidenceSpanCatalog
  ) {
    throw new Error("Prepared full-source citation binding is missing");
  }
  const fullRange = { start: 0, end: document.canonical.text.length };
  const fullSourceView = await buildNarrativeSourceView({
    ref: firstBindingWindow.sourceView.ref,
    document,
    documentRange: fullRange,
  });
  const fullBinding = await bindEvidenceSpanCatalog(
    prepared.fixture.snapshot,
    prepared.evidenceSpanCatalog,
    {
      requestIdentity: "chronicle-v2-test:full-source-window",
      windows: [
        {
          windowId: firstWindow.windowId,
          documentRef: firstBindingWindow.documentRef,
          sourceView: fullSourceView,
          ownedRanges: [fullRange],
          contextRanges: [],
        },
      ],
    },
  );
  return {
    ...prepared,
    windows: [{ ...firstWindow, text: fullSourceView.text }],
    sourceViews: [fullSourceView],
    evidenceSpanCatalogBindingsByWindowId: new Map([
      [firstWindow.windowId, fullBinding],
    ]),
    evidenceSpanCatalogBinding: fullBinding,
    textBySourceRef: new Map(prepared.textBySourceRef).set(
      fullSourceView.ref,
      fullSourceView.text,
    ),
  };
}

describe("Chronicle evaluation contract v2 production evaluator", () => {
  it("runs four real citation-ID observations and synthesis through a passing semantic evaluation", async () => {
    const context = await loadFixtureContext();
    const { artifacts, evaluation } = await evaluateFixture(context, "correct");

    expect(context.evalCase.documents).toEqual(
      context.contract.sourceDocuments,
    );
    expect(context.evalCase.expected.observations).toEqual({
      required: [],
      forbidden: [],
    });
    expect(context.evalCase.criticalViolationClasses).toEqual([]);
    expect(artifacts.observations).toHaveLength(4);
    expect(artifacts.hypotheses.length).toBeGreaterThan(0);
    expect(artifacts.parseFailureCount).toBe(0);
    expect(evaluation.semanticStatus).toBe("PASS");
    expect(evaluation.observation.passed).toBe(true);
    expect(evaluation.proposal).toMatchObject({
      status: "unscored",
      passed: false,
    });
    expect(evaluation.observation.goldJudgedCount).toBe(4);
    expect(evaluation.observation.actualJudgedCount).toBe(4);
    expect(evaluation.observation.judgedCount).toBe(8);
    expect(evaluation.observation.denominator).toBe(8);
    expect(evaluation.accepted).toBe(false);
    expect(evaluation.evaluationScope).toBe("observation-and-temporal");
    expect(
      evaluation.evidenceCandidates
        .filter(
          (candidate) => candidate.actualRef === "eval-window-001:obs-004",
        )
        .find((candidate) => candidate.goldRef === "guards-evacuate-passersby"),
    ).toMatchObject({
      evidenceValid: true,
      overlap: true,
      directSupport: true,
      contextSupport: true,
    });
    const goldWithoutContext = context.contract.observationGold.claims.filter(
      (claim) => claim.allowedContextRegions.length === 0,
    );
    expect(goldWithoutContext).toHaveLength(3);
    for (const goldClaim of goldWithoutContext) {
      const assignment = evaluation.alignment.assignments.find(
        (candidate) =>
          candidate.goldRef === goldClaim.id && candidate.status === "match",
      );
      if (!assignment) {
        throw new Error(`Missing exact assignment for Gold ${goldClaim.id}`);
      }
      expect(
        evaluation.evidenceCandidates.find(
          (candidate) =>
            candidate.actualRef === assignment.actualRef &&
            candidate.goldRef === goldClaim.id,
        ),
      ).toMatchObject({
        evidenceValid: true,
        overlap: true,
        directSupport: true,
        contextSupport: true,
      });
    }
    for (const dimension of Object.values(evaluation.dimensions)) {
      expect(dimension).toMatchObject({
        truePositive: 4,
        falsePositive: 0,
        falseNegative: 0,
        pairedComparisonDenominator: 4,
        status: "scored",
      });
    }
  });

  it("uses explicit source document bindings when prepared runtime IDs differ from contract IDs", async () => {
    const context = await loadFixtureContext();
    const prepared = await prepareWithRuntimeDocumentIds(context);
    const { evaluation } = await evaluateFixture(
      context,
      "correct",
      context.contract,
      prepared,
    );

    const northBinding = evaluation.sourceDocumentBindings.find(
      (binding) => binding.contractDocumentId === "scene-north-gate",
    );
    if (!northBinding) throw new Error("North Gate source binding is missing");
    expect(northBinding.preparedDocumentId).toBe("prepared-scene-north-gate");

    const preparedNorthRefs = [...prepared.documentIdBySourceRef.entries()]
      .filter(([, documentId]) => documentId === "prepared-scene-north-gate")
      .map(([sourceRef]) => sourceRef)
      .sort();
    const preparedNorthEvidenceRefs = preparedNorthRefs.filter((sourceRef) =>
      sourceRef.startsWith("E"),
    );
    expect(preparedNorthRefs.length).toBeGreaterThan(1);
    expect(preparedNorthEvidenceRefs.length).toBeGreaterThan(1);
    expect(northBinding.sourceRef).not.toBe(preparedNorthEvidenceRefs[0]);
    expect(northBinding.evidenceSourceRefs).toEqual(preparedNorthRefs);
    expect(northBinding.evidenceSourceRefs).toEqual(
      expect.arrayContaining(preparedNorthEvidenceRefs),
    );

    const resolvedEvidenceRefs = new Set(
      evaluation.evidence.flatMap((item) =>
        item.ranges.map((range) => range.sourceRef),
      ),
    );
    expect(resolvedEvidenceRefs.size).toBeGreaterThan(1);
    expect(
      [...resolvedEvidenceRefs].every((sourceRef) =>
        preparedNorthEvidenceRefs.includes(sourceRef),
      ),
    ).toBe(true);
    expect(
      evaluation.temporal.relationRows.every(
        (relation) => relation.result === "matched",
      ),
    ).toBe(true);
    expect(evaluation.temporal.status).toBe("PASS");
  });

  it("requires full direct interval coverage instead of a small overlap", () => {
    expect(
      chronicleV2CoversAllRanges(
        [{ documentId: "scene", start: 0, end: 4 }],
        [{ documentId: "scene", start: 3, end: 7 }],
      ),
    ).toBe(false);
    expect(
      chronicleV2CoversAllRanges(
        [
          { documentId: "scene", start: 0, end: 3 },
          { documentId: "scene", start: 3, end: 7 },
        ],
        [{ documentId: "scene", start: 1, end: 7 }],
      ),
    ).toBe(true);
    expect(
      chronicleV2CoversAllRanges(
        [
          { documentId: "scene", start: 0, end: 3 },
          { documentId: "scene", start: 4, end: 7 },
        ],
        [{ documentId: "scene", start: 1, end: 7 }],
      ),
    ).toBe(false);
  });

  it("keeps a valid wrong-sentence citation from satisfying direct support", async () => {
    const context = await loadFixtureContext();
    const { prepared, artifacts } = await runFixturePipeline(
      context,
      "wrong-sentence-direct",
    );
    const contract: ChronicleV2Contract = {
      ...context.contract,
      observationGold: {
        claims: context.contract.observationGold.claims.map((claim) =>
          claim.id === "guards-evacuate-passersby"
            ? {
                ...claim,
                requiredDirectRegions: [
                  {
                    documentId: "scene-north-gate",
                    start: 20,
                    end: 26,
                  },
                ],
                allowedContextRegions: [],
              }
            : claim,
        ),
      },
    };
    const evaluation = await evaluateChronicleV2Production(
      prepared,
      artifacts,
      contract,
    );
    const candidate = evaluation.evidenceCandidates.find(
      (edge) =>
        edge.actualRef === "eval-window-001:obs-004" &&
        edge.goldRef === "guards-evacuate-passersby",
    );
    expect(candidate).toMatchObject({
      evidenceValid: true,
      overlap: true,
      directSupport: false,
      contextSupport: true,
    });
    expect(evaluation.semanticStatus).toBe("FAIL");
  });

  it("requires allowed context to be visible in the same validated request window", async () => {
    const context = await loadFixtureContext();
    const prepared = await prepareProductionChronicleEvalCase(
      context.evalCase,
      {
        evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      },
    );
    const window = prepared.windows[0];
    const originalBinding = window?.windowId
      ? prepared.evidenceSpanCatalogBindingsByWindowId?.get(window.windowId)
      : undefined;
    const originalBindingWindow = originalBinding?.windows[0];
    const document = originalBindingWindow
      ? prepared.fixture.snapshot.documents.find(
          (candidate) => candidate.ref === originalBindingWindow.documentRef,
        )
      : undefined;
    if (
      !window?.windowId ||
      !originalBinding ||
      !originalBindingWindow ||
      !document ||
      !prepared.evidenceSpanCatalog
    ) {
      throw new Error("Prepared citation binding is missing");
    }
    const smallSourceView = await buildNarrativeSourceView({
      ref: originalBindingWindow.sourceView.ref,
      document,
      documentRange: { start: 0, end: 23 },
    });
    const smallBinding = await bindEvidenceSpanCatalog(
      prepared.fixture.snapshot,
      prepared.evidenceSpanCatalog,
      {
        requestIdentity: "chronicle-v2-test:small-first-window",
        windows: [
          {
            windowId: window.windowId,
            documentRef: originalBindingWindow.documentRef,
            sourceView: smallSourceView,
            ownedRanges: [{ start: 0, end: 23 }],
            contextRanges: [],
          },
        ],
      },
    );
    const narrowedPrepared: PreparedProductionChronicleEvalCase = {
      ...prepared,
      windows: [{ ...window, text: smallSourceView.text }],
      sourceViews: [smallSourceView],
      evidenceSpanCatalogBindingsByWindowId: new Map([
        [window.windowId, smallBinding],
      ]),
      evidenceSpanCatalogBinding: smallBinding,
      textBySourceRef: new Map(prepared.textBySourceRef).set(
        smallSourceView.ref,
        smallSourceView.text,
      ),
    };
    const contract: ChronicleV2Contract = {
      ...context.contract,
      observationGold: {
        claims: context.contract.observationGold.claims.map((claim) =>
          claim.id === "gate-fall"
            ? {
                ...claim,
                allowedContextRegions: [
                  {
                    documentId: "scene-north-gate",
                    start: 23,
                    end: 26,
                  },
                ],
              }
            : claim,
        ),
      },
    };
    const { artifacts, evaluation } = await evaluateFixture(
      context,
      "context-only-negative",
      contract,
      narrowedPrepared,
    );
    const candidate = evaluation.evidenceCandidates.find(
      (edge) =>
        edge.actualRef === "eval-window-001:obs-002" &&
        edge.goldRef === "gate-fall",
    );
    expect(candidate).toMatchObject({
      evidenceValid: true,
      overlap: true,
      directSupport: true,
      contextSupport: false,
    });
    expect(artifacts.observations).toHaveLength(2);
    expect(evaluation.semanticStatus).toBe("FAIL");
    await expect(
      assertDiagnosticRoundTrip(evaluation, contract),
    ).resolves.toBeDefined();
  });

  it("does not supplement a missing guard agent from contextual prose", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "missing-agent");

    const candidate = evaluation.evidenceCandidates.find(
      (edge) =>
        edge.actualRef === "eval-window-001:obs-004" &&
        edge.goldRef === "guards-evacuate-passersby",
    );
    expect(candidate).toMatchObject({
      evidenceValid: true,
      overlap: true,
      directSupport: true,
      contextSupport: true,
    });
    expect(evaluation.alignment.assignments).toContainEqual(
      expect.objectContaining({
        goldRef: "guards-evacuate-passersby",
        status: "mismatch",
        reason: "participant-missing",
      }),
    );
    expect(evaluation.semanticStatus).toBe("FAIL");
    const projection = await assertDiagnosticRoundTrip(
      evaluation,
      context.contract,
    );
    expect(projection.accepted).toBe(false);
  });

  it("keeps all four Observation true positives when minor synthesis suppresses scoped Proposals", async () => {
    const context = await loadFixtureContext();
    const scoredContract: ChronicleV2Contract = {
      ...context.contract,
      proposalPolicy: {
        mode: "scored",
        scoredClaimIds: [
          "chain-break",
          "gate-fall",
          "guards-ring-bell",
          "guards-evacuate-passersby",
        ],
        expectedDecisions: {
          "chain-break": "suppress",
          "gate-fall": "suppress",
          "guards-ring-bell": "suppress",
          "guards-evacuate-passersby": "suppress",
        },
        reason: "explicit-fixture-policy",
      },
    };
    const { artifacts, evaluation } = await evaluateFixture(
      context,
      "minor-suppressed",
      scoredContract,
    );

    expect(artifacts.hypotheses.length).toBeGreaterThan(0);
    expect(
      artifacts.hypotheses.every(
        (hypothesis) => hypothesis.significance === "minor",
      ),
    ).toBe(true);
    expect(artifacts.plannedProposals).toHaveLength(0);
    expect(evaluation.observation).toMatchObject({
      matchedCount: 4,
      mismatchCount: 0,
      missingCount: 0,
      extraCount: 0,
      duplicateCount: 0,
      unobservableCount: 0,
    });
    expect(evaluation.proposal).toMatchObject({
      mode: "scored",
      status: "pass",
      passed: true,
      eligibleGoldCount: 4,
      proposedCorrectCount: 0,
      suppressedCorrectCount: 4,
      proposedIncorrectCount: 0,
      suppressedIncorrectCount: 0,
      unobservableCount: 0,
    });
    expect(evaluation.semanticStatus).toBe("PASS");
    expect(evaluation.semanticPassed).toBe(true);
    for (const dimension of Object.values(evaluation.dimensions)) {
      expect(dimension).toMatchObject({
        truePositive: 4,
        falsePositive: 0,
        falseNegative: 0,
        pairedComparisonDenominator: 4,
        status: "scored",
      });
    }
  });

  it("keeps actual normalization fixed when only source-authored Gold changes", async () => {
    const context = await loadFixtureContext();
    const { prepared, artifacts } = await runFixturePipeline(
      context,
      "correct",
    );
    const original = await evaluateChronicleV2Production(
      prepared,
      artifacts,
      context.contract,
    );
    const mutations = [
      {
        name: "predicate",
        claims: context.contract.observationGold.claims.map((claim, index) =>
          index === 0 ? { ...claim, predicate: "gate-fall" as const } : claim,
        ),
      },
      {
        name: "role",
        claims: context.contract.observationGold.claims.map((claim, index) =>
          index === 0
            ? {
                ...claim,
                participants: claim.participants.map(
                  (participant, participantIndex) =>
                    participantIndex === 0
                      ? { ...participant, role: "agent" as const }
                      : participant,
                ),
              }
            : claim,
        ),
      },
      {
        name: "attribution",
        claims: context.contract.observationGold.claims.map((claim, index) =>
          index === 0 ? { ...claim, attribution: "character" as const } : claim,
        ),
      },
    ] as const;

    for (const mutation of mutations) {
      const mutatedContract: ChronicleV2Contract = {
        ...context.contract,
        observationGold: { claims: mutation.claims },
      };
      const mutated = await evaluateChronicleV2Production(
        prepared,
        artifacts,
        mutatedContract,
      );
      const originalProjection = await assertDiagnosticRoundTrip(
        original,
        context.contract,
      );
      const mutatedProjection = await assertDiagnosticRoundTrip(
        mutated,
        mutatedContract,
      );

      expect(mutated.rawActualClaims).toEqual(original.rawActualClaims);
      expect(mutated.normalizedActualClaims).toEqual(
        original.normalizedActualClaims,
      );
      expect(mutatedProjection.rawActualDigest).toBe(
        originalProjection.rawActualDigest,
      );
      expect(mutatedProjection.normalizedActualDigest).toBe(
        originalProjection.normalizedActualDigest,
      );
      expect(mutatedProjection.goldDigest).not.toBe(
        originalProjection.goldDigest,
      );
      expect(mutatedProjection.assignmentDigest).not.toBe(
        originalProjection.assignmentDigest,
      );
      expect(mutated.alignment.matchedCount).toBe(3);
      expect(mutated.alignment.mismatchCount).toBe(1);
      expect(mutated.alignment.missingCount).toBe(1);
      expect(mutated.semanticStatus).toBe("FAIL");
      expect(mutation.name).toMatch(/predicate|role|attribution/);
    }
  });

  it("scores a known wrong predicate only in the paired predicate dimension", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "wrong-predicate");

    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.alignment.mismatchCount).toBe(1);
    expect(evaluation.alignment.extraCount).toBe(0);
    expect(evaluation.dimensions.predicate).toMatchObject({
      truePositive: 3,
      falsePositive: 1,
      falseNegative: 1,
      pairedComparisonDenominator: 4,
      status: "scored",
    });
    expect(evaluation.dimensions.roles).toMatchObject({
      truePositive: 4,
      falsePositive: 0,
      falseNegative: 0,
      pairedComparisonDenominator: 4,
    });
  });

  it("keeps a known gate-repair predicate failure when attribution is unknown", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(
      context,
      "wrong-predicate-unknown-attribution",
    );

    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.alignment.mismatchCount).toBe(1);
    expect(evaluation.alignment.assignments).toContainEqual(
      expect.objectContaining({
        actualRef: "eval-window-001:obs-002",
        goldRef: "gate-fall",
        status: "mismatch",
        reason: "predicate-mismatch",
      }),
    );
    expect(evaluation.dimensions.predicate).toMatchObject({
      truePositive: 3,
      falsePositive: 1,
      falseNegative: 1,
      unobservable: 0,
      pairedComparisonDenominator: 4,
    });
    expect(evaluation.dimensions.attribution).toMatchObject({
      truePositive: 3,
      falsePositive: 0,
      falseNegative: 0,
      unobservable: 1,
      pairedComparisonDenominator: 3,
    });
  });

  it("keeps a compatible unknown attribution explicitly undetermined", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(
      context,
      "unknown-attribution-only",
    );

    expect(evaluation.semanticStatus).toBe("UNDETERMINED");
    expect(evaluation.alignment.matchedCount).toBe(3);
    expect(evaluation.alignment.unobservableCount).toBe(1);
    expect(evaluation.alignment.undeterminedGoldRefs).toEqual(["chain-break"]);
    expect(evaluation.alignment.unknownMatchCapacity).toBe(1);
    expect(evaluation.alignment.missingCountLowerBound).toBe(0);
    expect(evaluation.alignment.missingCount).toBe(0);
    expect(evaluation.dimensions.attribution).toMatchObject({
      truePositive: 3,
      falsePositive: 0,
      falseNegative: 0,
      unobservable: 1,
      pairedComparisonDenominator: 3,
    });
    expect(evaluation.accepted).toBe(false);
  });

  it("retains a participant contradiction alongside an unknown participant field", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(
      context,
      "partial-participant-unknown",
    );

    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.alignment.mismatchCount).toBe(1);
    expect(evaluation.alignment.assignments).toContainEqual(
      expect.objectContaining({
        goldRef: "gate-fall",
        status: "mismatch",
        reason: "role-mismatch",
      }),
    );
    expect(evaluation.dimensions.participants).toMatchObject({
      truePositive: 3,
      falsePositive: 0,
      falseNegative: 0,
      unobservable: 1,
      pairedComparisonDenominator: 3,
    });
    expect(evaluation.dimensions.roles).toMatchObject({
      truePositive: 3,
      falsePositive: 1,
      falseNegative: 1,
      unobservable: 1,
      pairedComparisonDenominator: 4,
    });
  });

  it("scores a participant role reversal as role error while preserving entity participants", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "role-swap");

    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.alignment.assignments).toContainEqual(
      expect.objectContaining({
        status: "mismatch",
        reason: "role-mismatch",
      }),
    );
    expect(evaluation.dimensions.participants).toMatchObject({
      truePositive: 4,
      falsePositive: 0,
      falseNegative: 0,
      pairedComparisonDenominator: 4,
    });
    expect(evaluation.dimensions.roles).toMatchObject({
      truePositive: 3,
      falsePositive: 1,
      falseNegative: 1,
      pairedComparisonDenominator: 4,
    });
  });

  it("treats an empty production response as four required Gold misses", async () => {
    const context = await loadFixtureContext();
    const { artifacts, evaluation } = await evaluateFixture(context, "empty");

    expect(artifacts.observations).toHaveLength(0);
    expect(artifacts.parseFailureCount).toBe(0);
    expect(evaluation.observation.actualCount).toBe(0);
    expect(evaluation.observation.matchedCount).toBe(0);
    expect(evaluation.observation.missingCount).toBe(4);
    expect(evaluation.observation.undeterminedGoldCount).toBe(0);
    expect(evaluation.semanticStatus).toBe("FAIL");
  });

  it("keeps a missing destination as a semantic participant failure", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(
      context,
      "missing-destination",
    );

    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.alignment.matchedCount).toBe(3);
    expect(evaluation.alignment.mismatchCount).toBe(1);
    expect(evaluation.alignment.missingCount).toBe(1);
    expect(evaluation.alignment.assignments).toContainEqual(
      expect.objectContaining({
        status: "mismatch",
        reason: "participant-missing",
      }),
    );
  });

  it("retains a semantic duplicate through the merger and keeps Proposal lookup on the exact row", async () => {
    const context = await loadFixtureContext();
    const scoredContract: ChronicleV2Contract = {
      ...context.contract,
      proposalPolicy: {
        mode: "scored",
        scoredClaimIds: ["gate-fall"],
        expectedDecisions: { "gate-fall": "propose" },
        reason: "explicit-fixture-policy",
      },
    };
    const { artifacts, evaluation } = await evaluateFixture(
      context,
      "semantic-duplicate",
      scoredContract,
    );

    expect(artifacts.observations).toHaveLength(5);
    expect(evaluation.alignment.matchedCount).toBe(4);
    expect(evaluation.alignment.duplicateCount).toBe(1);
    expect(evaluation.proposal).toMatchObject({
      status: "pass",
      passed: true,
      unobservableCount: 0,
      proposedCorrectCount: 1,
    });
    expect(evaluation.semanticStatus).toBe("FAIL");
  });

  it("retains a definite Proposal failure when an unknown extra has a participant-count contradiction", async () => {
    const context = await loadFixtureContext();
    const scoredContract: ChronicleV2Contract = {
      ...context.contract,
      proposalPolicy: {
        mode: "scored",
        scoredClaimIds: ["chain-break"],
        expectedDecisions: { "chain-break": "suppress" },
        reason: "explicit-fixture-policy",
      },
    };
    const { evaluation } = await evaluateFixture(
      context,
      "wrong-plus-unknown",
      scoredContract,
    );

    expect(evaluation.alignment.mismatchCount).toBe(1);
    expect(evaluation.alignment.unobservableCount).toBe(0);
    expect(evaluation.alignment.undeterminedGoldCount).toBe(0);
    expect(evaluation.alignment.extraCount).toBe(1);
    expect(evaluation.alignment.missingCount).toBe(1);
    expect(evaluation.alignment.missingCountLowerBound).toBe(1);
    expect(evaluation.proposal).toMatchObject({
      status: "fail",
      passed: false,
      proposedIncorrectCount: 1,
      unobservableCount: 0,
    });
    expect(evaluation.semanticStatus).toBe("FAIL");
  });

  it.each([
    ["wrong-frame", "frame-mismatch"],
    ["wrong-actuality", "actuality-mismatch"],
  ] as const)(
    "fails a %s while preserving the explicit reason",
    async (mutation, reason) => {
      const context = await loadFixtureContext();
      const { evaluation } = await evaluateFixture(context, mutation);

      expect(evaluation.semanticStatus).toBe("FAIL");
      expect(evaluation.alignment.mismatchCount).toBe(1);
      expect(evaluation.alignment.assignments).toContainEqual(
        expect.objectContaining({ status: "mismatch", reason }),
      );
    },
  );

  it("does not conflate a bell observation with evacuation", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(
      context,
      "bell-evacuate-conflation",
    );

    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.alignment.matchedCount).toBe(3);
    expect(evaluation.alignment.mismatchCount).toBe(1);
    expect(evaluation.alignment.missingCount).toBe(1);
  });

  it("keeps one combined out-of-vocabulary object uncertain", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "combined");

    expect(evaluation.semanticStatus).toBe("UNDETERMINED");
    expect(evaluation.alignment.matchedCount).toBe(3);
    expect(evaluation.alignment.unobservableCount).toBe(1);
    expect(evaluation.alignment.undeterminedGoldCount).toBe(1);
    expect(evaluation.alignment.missingCount).toBe(0);
  });

  it("keeps a two-participant unknown atomic actual bounded to two of four Gold claims", async () => {
    const context = await loadFixtureContext();
    const fullSourcePrepared = await prepareFullSourceWindow(context);
    const { artifacts, evaluation } = await evaluateFixture(
      context,
      "unknown-two-participants",
      context.contract,
      fullSourcePrepared,
    );

    expect(artifacts.observations).toHaveLength(1);
    expect(evaluation.rawActualClaims).toHaveLength(1);
    expect(evaluation.rawActualClaims[0]?.evidenceRefs).toHaveLength(2);
    expect(evaluation.normalizedActualClaims[0]).toMatchObject({
      predicate: { status: "unknown" },
      participants: [
        {
          entity: { status: "unknown" },
          role: { status: "unknown" },
        },
        {
          entity: { status: "unknown" },
          role: { status: "unknown" },
        },
      ],
    });
    expect(evaluation.alignment.matchedGoldRefs).toEqual([]);
    expect(evaluation.alignment.undeterminedGoldRefs).toEqual([
      "gate-fall",
      "guards-ring-bell",
    ]);
    expect(evaluation.alignment.missingGoldRefs).toEqual([
      "chain-break",
      "guards-evacuate-passersby",
    ]);
    expect(evaluation.alignment.undeterminedGoldCount).toBe(2);
    expect(evaluation.alignment.missingCount).toBe(2);
    expect(evaluation.alignment.unknownMatchCapacity).toBe(1);
    expect(evaluation.alignment.missingCountLowerBound).toBe(3);
    expect(evaluation.observation).toMatchObject({
      goldCount: 4,
      actualCount: 1,
      undeterminedGoldCount: 2,
      missingCount: 2,
      unknownMatchCapacity: 1,
      missingCountLowerBound: 3,
    });
    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.accepted).toBe(false);
    const projection = await assertDiagnosticRoundTrip(
      evaluation,
      context.contract,
    );
    expect(projection.observation).toMatchObject({
      goldCount: 4,
      actualCount: 1,
      undeterminedGoldCount: 2,
      missingCount: 2,
      unknownMatchCapacity: 1,
      missingCountLowerBound: 3,
    });
    expect(projection.accepted).toBe(false);
  });

  it("keeps two partially unknown production observations undetermined", async () => {
    const context = await loadFixtureContext();
    const fullSourcePrepared = await prepareFullSourceWindow(context);
    const { artifacts, evaluation } = await evaluateFixture(
      context,
      "two-partial-unknown",
      context.contract,
      fullSourcePrepared,
    );

    expect(artifacts.observations).toHaveLength(4);
    expect(artifacts.parseFailureCount).toBe(0);
    expect(evaluation.alignment.matchedGoldRefs).toEqual([
      "chain-break",
      "guards-evacuate-passersby",
    ]);
    expect(evaluation.alignment.undeterminedGoldRefs).toEqual([
      "gate-fall",
      "guards-ring-bell",
    ]);
    expect(evaluation.alignment.undeterminedGoldCount).toBe(2);
    expect(evaluation.alignment.unknownMatchCapacity).toBe(2);
    expect(evaluation.alignment.missingCountLowerBound).toBe(0);
    expect(evaluation.alignment.cardinalityExcessLowerBound).toBe(0);
    expect(evaluation.alignment.mismatchCount).toBe(0);
    expect(evaluation.alignment.extraCount).toBe(0);
    expect(evaluation.semanticStatus).toBe("UNDETERMINED");
    expect(evaluation.accepted).toBe(false);
    const projection = await assertDiagnosticRoundTrip(
      evaluation,
      context.contract,
    );
    expect(projection.observation).toMatchObject({
      undeterminedGoldCount: 2,
      unknownMatchCapacity: 2,
      missingCountLowerBound: 0,
      cardinalityExcessLowerBound: 0,
    });
    expect(projection.accepted).toBe(false);
  });

  it("fails a compatible unknown fifth only through exhaustive cardinality", async () => {
    const context = await loadFixtureContext();
    const fullSourcePrepared = await prepareFullSourceWindow(context);
    const { artifacts, evaluation } = await evaluateFixture(
      context,
      "compatible-unknown-fifth",
      context.contract,
      fullSourcePrepared,
    );

    expect(artifacts.observations).toHaveLength(5);
    expect(evaluation.alignment.unobservableCount).toBe(1);
    expect(evaluation.alignment.undeterminedGoldCount).toBe(0);
    expect(evaluation.alignment.unknownMatchCapacity).toBe(0);
    expect(evaluation.alignment.mismatchCount).toBe(0);
    expect(evaluation.alignment.extraCount).toBe(0);
    expect(evaluation.alignment.missingCount).toBe(0);
    expect(evaluation.alignment.missingCountLowerBound).toBe(0);
    expect(evaluation.alignment.cardinalityExcessLowerBound).toBe(1);
    expect(evaluation.alignment.falsePositiveCount).toBe(0);
    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.accepted).toBe(false);
    const projection = await assertDiagnosticRoundTrip(
      evaluation,
      context.contract,
    );
    expect(projection.observation).toMatchObject({
      actualCount: 5,
      cardinalityExcessLowerBound: 1,
      extraCount: 0,
      mismatchCount: 0,
      unobservableCount: 1,
    });
    expect(projection.accepted).toBe(false);
  });

  it("keeps three exact production observations plus one compatible unknown without cardinality excess", async () => {
    const context = await loadFixtureContext();
    const fullSourcePrepared = await prepareFullSourceWindow(context);
    const { artifacts, evaluation } = await evaluateFixture(
      context,
      "three-exact-compatible-unknown",
      context.contract,
      fullSourcePrepared,
    );

    expect(artifacts.observations).toHaveLength(4);
    expect(evaluation.alignment.matchedCount).toBe(3);
    expect(evaluation.alignment.unobservableCount).toBe(1);
    expect(evaluation.alignment.undeterminedGoldCount).toBe(1);
    expect(evaluation.alignment.unknownMatchCapacity).toBe(1);
    expect(evaluation.alignment.missingCountLowerBound).toBe(0);
    expect(evaluation.alignment.cardinalityExcessLowerBound).toBe(0);
    expect(evaluation.alignment.mismatchCount).toBe(0);
    expect(evaluation.alignment.extraCount).toBe(0);
    expect(evaluation.semanticStatus).toBe("UNDETERMINED");
    expect(evaluation.accepted).toBe(false);
  });

  it("reports a known fabricated fifth event as an exhaustive extra", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "fabricated-extra");

    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.alignment.matchedCount).toBe(4);
    expect(evaluation.alignment.extraCount).toBe(1);
    expect(evaluation.alignment.falsePositiveCount).toBe(1);
  });

  it("fails an unknown extra as a definite exhaustive extra", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "unknown-extra");

    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.alignment.unobservableCount).toBe(0);
    expect(evaluation.alignment.unscoredCount).toBe(0);
    expect(evaluation.alignment.mismatchCount).toBe(0);
    expect(evaluation.alignment.extraCount).toBe(1);
    expect(evaluation.alignment.missingCount).toBe(0);
    expect(evaluation.alignment.missingCountLowerBound).toBe(0);
    expect(evaluation.alignment.falsePositiveCount).toBe(1);
    expect(evaluation.observation.actualJudgedCount).toBe(5);
    expect(evaluation.observation.denominator).toBe(9);
  });

  it("marks a scoped fabricated observation unscored and keeps semantic status undetermined", async () => {
    const context = await loadFixtureContext();
    const targetedContract: ChronicleV2Contract = {
      ...context.contract,
      coverage: { ...context.contract.coverage, observation: "targeted" },
    };
    const { evaluation } = await evaluateFixture(
      context,
      "targeted-extra",
      targetedContract,
    );

    expect(evaluation.semanticStatus).toBe("UNDETERMINED");
    expect(evaluation.alignment.unscoredCount).toBe(1);
    expect(evaluation.alignment.extraCount).toBe(0);
    expect(evaluation.alignment.cardinalityExcessLowerBound).toBe(0);
    expect(evaluation.alignment.falsePositiveCount).toBe(0);
    expect(evaluation.observation.actualJudgedCount).toBe(4);
    expect(evaluation.observation.goldJudgedCount).toBe(4);
    expect(evaluation.observation.judgedCount).toBe(8);
    expect(evaluation.observation.denominator).toBe(9);
  });

  it("turns a scoped proposal policy failure into a semantic failure", async () => {
    const context = await loadFixtureContext();
    const scoredContract: ChronicleV2Contract = {
      ...context.contract,
      proposalPolicy: {
        mode: "scored",
        scoredClaimIds: ["chain-break"],
        expectedDecisions: { "chain-break": "suppress" },
        reason: "explicit-fixture-policy",
      },
    };
    const { evaluation } = await evaluateFixture(
      context,
      "correct",
      scoredContract,
    );

    expect(evaluation.proposal.status).toBe("fail");
    expect(evaluation.proposal.proposedIncorrectCount).toBe(1);
    expect(evaluation.semanticStatus).toBe("FAIL");
    expect(evaluation.semanticPassed).toBe(false);
  });

  it("rejects a foreign request binding through the canonical validator", async () => {
    const context = await loadFixtureContext();
    const { prepared, artifacts } = await runFixturePipeline(
      context,
      "correct",
    );
    const windowId = prepared.windows[0]?.windowId;
    const binding = windowId
      ? prepared.evidenceSpanCatalogBindingsByWindowId?.get(windowId)
      : undefined;
    if (!windowId || !binding) throw new Error("Prepared binding is missing");
    const foreignBinding = {
      ...binding,
      requestIdentity: "foreign-request-identity",
    };
    const badPrepared: PreparedProductionChronicleEvalCase = {
      ...prepared,
      evidenceSpanCatalogBindingsByWindowId: new Map([
        [windowId, foreignBinding],
      ]),
    };

    await expect(
      evaluateChronicleV2Production(badPrepared, artifacts, context.contract),
    ).rejects.toThrow(/stale|foreign|binding/i);
  });

  it("rejects a stale artifact anchor instead of accepting a source-range match", async () => {
    const context = await loadFixtureContext();
    const { prepared, artifacts } = await runFixturePipeline(
      context,
      "correct",
    );
    const firstAnchor = artifacts.anchors[0];
    if (!firstAnchor) throw new Error("Production anchor is missing");
    const staleArtifacts: ProductionChronicleArtifacts = {
      ...artifacts,
      anchors: artifacts.anchors.map((anchor, index) =>
        index === 0
          ? {
              ...anchor,
              contentDigest:
                "sha256-stale-anchor" as typeof anchor.contentDigest,
            }
          : anchor,
      ),
    };
    const evaluation = await evaluateChronicleV2Production(
      prepared,
      staleArtifacts,
      context.contract,
    );

    expect(evaluation.evidence[0]).toMatchObject({
      valid: false,
      reason: "anchor-mismatch",
    });
    expect(evaluation.semanticStatus).toBe("FAIL");
  });

  it("keeps the temporal projection independent from event normalization and alignment", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "correct");

    expect(evaluation.temporal).toMatchObject({
      version: "chronicle-evaluation-v2-temporal/1",
      requiredRelationCount: 2,
      matchedCount: 2,
      missingCount: 0,
      invalidEvidenceCount: 0,
      unobservableCount: 0,
      blockedByEventIdentityCount: 0,
      unscoredGoldCount: 2,
      judgedCount: 2,
      denominator: 2,
      status: "PASS",
      passed: true,
    });
    expect(evaluation.temporal.rawRows).toHaveLength(4);
    expect(evaluation.temporal.normalizedRows).toHaveLength(4);
    expect(evaluation.temporal.relationRows).toHaveLength(2);
    expect(
      evaluation.normalizedActualClaims.some(
        (claim) => "temporalExpressions" in claim,
      ),
    ).toBe(false);
    expect(evaluation.alignment.version).toBe(
      "chronicle-evaluation-v2-alignment/3",
    );
    expect(evaluation.evaluationScope).toBe("observation-and-temporal");
  });

  it("fails targeted temporal scoring for known morning-only metadata without adding a temporal false positive", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "temporal-morning");

    expect(evaluation.observation.passed).toBe(true);
    expect(evaluation.temporal).toMatchObject({
      matchedCount: 0,
      missingCount: 2,
      invalidEvidenceCount: 0,
      unobservableCount: 0,
      status: "FAIL",
      passed: false,
    });
    expect(evaluation.semanticStatus).toBe("FAIL");
  });

  it("keeps targeted temporal scoring undetermined for unknown metadata", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "temporal-unknown");

    expect(evaluation.observation.passed).toBe(true);
    expect(evaluation.temporal).toMatchObject({
      matchedCount: 0,
      missingCount: 0,
      invalidEvidenceCount: 0,
      unobservableCount: 2,
      blockedByEventIdentityCount: 0,
      status: "UNDETERMINED",
      passed: false,
    });
    expect(evaluation.semanticStatus).toBe("UNDETERMINED");
  });

  it("treats materialized explicit empty temporal metadata as missing", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "temporal-empty");

    expect(evaluation.temporal).toMatchObject({
      matchedCount: 0,
      missingCount: 2,
      invalidEvidenceCount: 0,
      unobservableCount: 0,
      status: "FAIL",
      passed: false,
    });
    expect(evaluation.semanticStatus).toBe("FAIL");
  });

  it("accepts night-half when extra temporal literals share the same actual", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "temporal-extra");

    expect(evaluation.temporal).toMatchObject({
      matchedCount: 2,
      missingCount: 0,
      invalidEvidenceCount: 0,
      unobservableCount: 0,
      status: "PASS",
      passed: true,
    });
    expect(evaluation.semanticStatus).toBe("PASS");
  });

  it("lets the production parser discard non-string temporal literals without changing the scored characterization", async () => {
    const context = await loadFixtureContext();
    const { artifacts, evaluation } = await evaluateFixture(
      context,
      "temporal-non-string",
    );

    expect(artifacts.observations[0]?.payload.temporalExpressions).toEqual([]);
    expect(artifacts.observations[1]?.payload.temporalExpressions).toEqual([
      "夜半",
    ]);
    expect(evaluation.temporal).toMatchObject({
      matchedCount: 1,
      missingCount: 1,
      unobservableCount: 0,
      status: "FAIL",
      passed: false,
    });
    expect(evaluation.semanticStatus).toBe("FAIL");
  });

  it("does not score temporal metadata on the two explicitly unscored later events", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(context, "temporal-unscored");

    expect(evaluation.temporal).toMatchObject({
      requiredRelationCount: 2,
      matchedCount: 2,
      missingCount: 0,
      invalidEvidenceCount: 0,
      unobservableCount: 0,
      unscoredGoldCount: 2,
      status: "PASS",
      passed: true,
    });
    expect(evaluation.temporal.relationRows).toHaveLength(2);
    expect(evaluation.semanticStatus).toBe("PASS");
  });

  it("blocks temporal scoring for the event whose identity remains unknown", async () => {
    const context = await loadFixtureContext();
    const { evaluation } = await evaluateFixture(
      context,
      "unknown-attribution-only",
    );

    expect(evaluation.temporal).toMatchObject({
      requiredRelationCount: 2,
      matchedCount: 1,
      missingCount: 0,
      invalidEvidenceCount: 0,
      unobservableCount: 1,
      blockedByEventIdentityCount: 1,
      judgedCount: 1,
      denominator: 2,
      status: "UNDETERMINED",
      passed: false,
    });
    expect(evaluation.semanticStatus).toBe("UNDETERMINED");
  });
});
