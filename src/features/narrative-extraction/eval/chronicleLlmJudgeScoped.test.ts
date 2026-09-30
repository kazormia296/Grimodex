import { describe, expect, it, vi } from "vitest";
import actualFixture from "../../../../evals/narrative/contracts/chronicle-transfer-v1/transfer-actual-001.json";
import dreamFixture from "../../../../evals/narrative/contracts/chronicle-transfer-v1/transfer-dream-001.json";
import hearsayFixture from "../../../../evals/narrative/contracts/chronicle-transfer-v1/transfer-hearsay-001.json";
import planFixture from "../../../../evals/narrative/contracts/chronicle-transfer-v1/transfer-plan-001.json";
import { CITATION_ID_OBSERVATION_EVIDENCE_MODE } from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { loadChronicleJudgeCaseContract } from "./chronicleJudgeCaseContract";
import { digestStableJson } from "../source/digest";
import {
  buildChronicleLlmJudgeMessages,
  buildChronicleLlmJudgeResponse,
  CHRONICLE_LLM_JUDGE_DIMENSIONS,
  CHRONICLE_LLM_JUDGE_RUBRIC,
  CHRONICLE_LLM_JUDGE_RUBRIC_VERSION,
  CHRONICLE_LLM_JUDGE_SCOPE_REFERENCE_POLICY,
  prepareChronicleLlmJudgeOfflineRun,
  type ChronicleLlmJudgeInput,
  type ChronicleLlmJudgePreparedRun,
  type ChronicleLlmJudgeResponse,
} from "./chronicleLlmJudgeOffline";
import { prepareProductionChronicleEvalCase } from "./productionChronicleAdapter";
import type { PreparedProductionChronicleEvalCase } from "./productionChronicleTypes";
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
    model: "chronicle-llm-judge-scoped-fixture-model",
    provider: "chronicle-llm-judge-scoped-fixture",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "chronicle-llm-judge-scoped-test" }),
  },
}));

const SOURCE_DOCUMENT_ID_PREFIX = "prepared-transfer-source";

type ContractFixture =
  | typeof actualFixture
  | typeof planFixture
  | typeof hearsayFixture
  | typeof dreamFixture;

interface FixedObservation {
  readonly localId: string;
  readonly quote: string;
  readonly predicate: string;
  readonly actuality: RawChronicleEventObservation["payload"]["actuality"];
  readonly participants: readonly {
    readonly surface: string;
    readonly role: string;
  }[];
  readonly attribution: RawChronicleEventObservation["assertion"]["attribution"];
  readonly narrativeFrame: RawChronicleEventObservation["assertion"]["narrativeFrame"];
  readonly durationKind: RawChronicleEventObservation["payload"]["durationKind"];
}

interface PreparedScopedCase {
  readonly contract: ReturnType<typeof loadCase>;
  readonly prepared: PreparedProductionChronicleEvalCase;
}

function loadCase(fixture: ContractFixture) {
  const result = loadChronicleJudgeCaseContract(fixture);
  if (!result.ok) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    );
  }
  return result.value;
}

function evalCaseForContract(
  contract: ReturnType<typeof loadCase>,
): NarrativeEvalCaseV1 {
  const source = contract.sourceDocuments[0];
  if (!source) throw new Error(`Missing source for ${contract.caseId}`);
  const runtimeDocumentId = `${SOURCE_DOCUMENT_ID_PREFIX}-${contract.caseId}`;
  return {
    schemaVersion: 1,
    id: `scoped-${contract.caseId}`,
    scope: { slice: "chronicle-transfer-v1", tier: "micro" },
    locale: "ja-JP",
    timezone: "UTC",
    frozenTime: "2026-01-01T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: [runtimeDocumentId],
      omittedDocumentIds: [],
    },
    documents: [
      {
        id: runtimeDocumentId,
        title: source.title,
        text: source.text,
      },
    ],
    expected: { observations: { required: [], forbidden: [] } },
    criticalViolationClasses: [],
  };
}

async function preparedCase(
  fixture: ContractFixture,
): Promise<PreparedScopedCase> {
  const contract = loadCase(fixture);
  const prepared = await prepareProductionChronicleEvalCase(
    evalCaseForContract(contract),
    {
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      requestIdentity: `chronicle-transfer-scoped:${contract.caseId}`,
    },
  );
  return { contract, prepared };
}

function sentenceQuotes(text: string): readonly [string, string] {
  const firstTerminal = text.indexOf("。");
  if (firstTerminal < 0)
    throw new Error("Fixture source has no sentence terminal");
  return [text.slice(0, firstTerminal + 1), text.slice(firstTerminal + 1)];
}

function aliasForQuote(
  prepared: PreparedProductionChronicleEvalCase,
  quote: string,
): string {
  const entry = prepared.evidenceSpanCatalog?.entries.find(
    (candidate) => candidate.quote === quote,
  );
  if (!entry) throw new Error(`Missing catalog entry for quote: ${quote}`);
  const bindings = prepared.evidenceSpanCatalogBindingsByWindowId
    ? [...prepared.evidenceSpanCatalogBindingsByWindowId.values()]
    : [];
  const alias = bindings
    .flatMap((binding) => binding.aliases)
    .find((candidate) => candidate.canonicalSourceRef === entry.sourceRef);
  if (!alias) throw new Error(`Missing citation alias for quote: ${quote}`);
  return alias.alias;
}

function observationResponse(
  prepared: PreparedProductionChronicleEvalCase,
  observations: readonly FixedObservation[],
): ReadonlyMap<string, string> {
  const firstWindow = prepared.windows[0];
  if (!firstWindow?.windowId) throw new Error("Prepared case has no window id");
  const response = JSON.stringify({
    observations: observations.map((observation) => ({
      localId: observation.localId,
      evidenceRefs: [aliasForQuote(prepared, observation.quote)],
      assertion: {
        attribution: observation.attribution,
        narrativeFrame: observation.narrativeFrame,
      },
      payload: {
        predicate: observation.predicate,
        actuality: observation.actuality,
        participants: observation.participants,
        temporalExpressions: [],
        durationKind: observation.durationKind,
      },
    })),
  });
  return new Map(
    prepared.windows.map((window, index) => [
      window.windowId!,
      index === 0 ? response : JSON.stringify({ observations: [] }),
    ]),
  );
}

function createIdFactory(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function pObservations(
  prepared: PreparedProductionChronicleEvalCase,
  options: {
    readonly includeSpeech?: boolean;
    readonly speechQuote?: string;
    readonly missingTheme?: boolean;
  } = {},
): readonly FixedObservation[] {
  const source = prepared.evalCase.documents[0]?.text;
  if (!source) throw new Error("P source is missing");
  const [plannedSentence, residualSentence] = sentenceQuotes(source);
  return [
    {
      localId: "p-target",
      quote: plannedSentence,
      predicate: "運ぶ",
      actuality: "planned",
      participants: options.missingTheme
        ? [{ surface: "私", role: "agent" }]
        : [
            { surface: "私", role: "agent" },
            { surface: "薬箱", role: "theme" },
          ],
      attribution: "character:リナ",
      narrativeFrame: "reported",
      durationKind: "unknown",
    },
    ...(options.includeSpeech
      ? [
          {
            localId: "p-speech",
            quote: options.speechQuote ?? plannedSentence,
            predicate: "話す",
            actuality: "actual" as const,
            participants: [
              { surface: "リナ", role: "agent" },
              { surface: "ソウ", role: "destination" },
            ],
            attribution: "narrator" as const,
            narrativeFrame: "story-world" as const,
            durationKind: "instant" as const,
          },
        ]
      : []),
    ...(residualSentence.length === 0 ? [] : []),
  ];
}

function actualObservations(
  prepared: PreparedProductionChronicleEvalCase,
): readonly FixedObservation[] {
  const source = prepared.evalCase.documents[0]?.text;
  if (!source) throw new Error("A source is missing");
  const [firstSentence, secondSentence] = sentenceQuotes(source);
  return [
    {
      localId: "a-put",
      quote: firstSentence,
      predicate: "入れる",
      actuality: "actual",
      participants: [
        { surface: "ナギ", role: "agent" },
        { surface: "布", role: "theme" },
        { surface: "箱", role: "destination" },
      ],
      attribution: "narrator",
      narrativeFrame: "story-world",
      durationKind: "instant",
    },
    {
      localId: "a-close",
      quote: secondSentence,
      predicate: "閉める",
      actuality: "actual",
      participants: [
        { surface: "トウマ", role: "agent" },
        { surface: "箱の蓋", role: "theme" },
      ],
      attribution: "narrator",
      narrativeFrame: "story-world",
      durationKind: "instant",
    },
  ];
}

function dreamObservations(
  prepared: PreparedProductionChronicleEvalCase,
): readonly FixedObservation[] {
  const source = prepared.evalCase.documents[0]?.text;
  if (!source) throw new Error("D source is missing");
  const [dreamSentence, wakingSentence] = sentenceQuotes(source);
  return [
    {
      localId: "d-swim",
      quote: dreamSentence,
      predicate: "泳ぐ",
      actuality: "dreamed",
      participants: [{ surface: "魚", role: "agent" }],
      attribution: "narrator",
      narrativeFrame: "dream",
      durationKind: "ongoing-process",
    },
    {
      localId: "d-fold",
      quote: wakingSentence,
      predicate: "畳む",
      actuality: "actual",
      participants: [
        { surface: "ユイ", role: "agent" },
        { surface: "毛布", role: "theme" },
      ],
      attribution: "narrator",
      narrativeFrame: "story-world",
      durationKind: "instant",
    },
  ];
}

async function prepareRun(
  fixture: ContractFixture,
  observations: readonly FixedObservation[],
  opaquePrefix: string,
): Promise<{
  readonly prepared: PreparedScopedCase;
  readonly run: ChronicleLlmJudgePreparedRun;
}> {
  const prepared = await preparedCase(fixture);
  const run = await prepareChronicleLlmJudgeOfflineRun({
    prepared: prepared.prepared,
    contract: prepared.contract,
    observationResponsesByWindowId: observationResponse(
      prepared.prepared,
      observations,
    ),
    createId: createIdFactory(`${opaquePrefix}-production`),
    createOpaqueId: createIdFactory(`${opaquePrefix}-opaque`),
  });
  return { prepared, run };
}

function allMatchResponse(
  input: ChronicleLlmJudgeInput,
): ChronicleLlmJudgeResponse {
  return buildChronicleLlmJudgeResponse(input, {
    primaryAssignments: input.actualClaims.map((actual, index) => ({
      actualRef: actual.ref,
      goldRef: input.goldClaims[index]!.ref,
      axes: {
        predicate: "match",
        participants: "match",
        roles: "match",
        actuality: "match",
        attribution: "match",
        narrativeFrame: "match",
        sourceSupport: "match",
      },
    })),
    unmatchedActuals: [],
    unmatchedGolds: [],
    temporalRelations: [],
  });
}

function pResponseWithScopeExclusion(
  input: ChronicleLlmJudgeInput,
): ChronicleLlmJudgeResponse {
  const scope = input.scope;
  if (!scope) throw new Error("P input is not scoped");
  const target = input.actualClaims.find((claim) => claim.predicate === "運ぶ");
  const speech = input.actualClaims.find((claim) => claim.predicate === "話す");
  const gold = input.goldClaims[0];
  const speechScope = scope.exclusions.find((exclusion) =>
    exclusion.meaning.includes("発話行為"),
  );
  if (!target || !speech || !gold || !speechScope) {
    throw new Error("P scoped response identities are missing");
  }
  return buildChronicleLlmJudgeResponse(input, {
    primaryAssignments: [
      {
        actualRef: target.ref,
        goldRef: gold.ref,
        axes: {
          predicate: "match",
          participants: "match",
          roles: "match",
          actuality: "match",
          attribution: "match",
          narrativeFrame: "match",
          sourceSupport: "match",
        },
      },
    ],
    unmatchedActuals: [
      {
        actualRef: speech.ref,
        status: "unscored",
        scopeRef: speechScope.ref,
        scopeMatch: "match",
        sourceSupport: "match",
      },
    ],
    unmatchedGolds: [],
    temporalRelations: [],
  });
}

function pResponseWithUndeterminedSpeech(
  input: ChronicleLlmJudgeInput,
): ChronicleLlmJudgeResponse {
  if (!("scope" in input)) throw new Error("P input is not scoped");
  const target = input.actualClaims.find((claim) => claim.predicate === "運ぶ");
  const speech = input.actualClaims.find((claim) => claim.predicate === "話す");
  const gold = input.goldClaims[0];
  if (!target || !speech || !gold) throw new Error("P identities are missing");
  return buildChronicleLlmJudgeResponse(input, {
    primaryAssignments: [
      {
        actualRef: target.ref,
        goldRef: gold.ref,
        axes: {
          predicate: "match",
          participants: "match",
          roles: "match",
          actuality: "match",
          attribution: "match",
          narrativeFrame: "match",
          sourceSupport: "match",
        },
      },
    ],
    unmatchedActuals: [{ actualRef: speech.ref, status: "undetermined" }],
    unmatchedGolds: [],
    temporalRelations: [],
  });
}

function responseWithAxes(
  input: ChronicleLlmJudgeInput,
  axes: ChronicleLlmJudgeResponse["primaryAssignments"][number]["axes"],
): ChronicleLlmJudgeResponse {
  const actual = input.actualClaims[0];
  const gold = input.goldClaims[0];
  if (!actual || !gold) throw new Error("Missing primary input row");
  return buildChronicleLlmJudgeResponse(input, {
    primaryAssignments: [{ actualRef: actual.ref, goldRef: gold.ref, axes }],
    unmatchedActuals: [],
    unmatchedGolds: [],
    temporalRelations: [],
  });
}

function scopeRefForSpeech(input: ChronicleLlmJudgeInput): string {
  const scope = input.scope;
  if (!scope) throw new Error("Input is not scoped");
  const exclusion = scope.exclusions.find((item) =>
    item.meaning.includes("発話行為"),
  );
  if (!exclusion) throw new Error("Speech scope exclusion is missing");
  return exclusion.ref;
}

describe("scoped Chronicle LLM judge transfer cases", () => {
  it("keeps the seven-axis rubric and scoped policy in the fixed judge input", async () => {
    const { prepared, run } = await prepareRun(
      planFixture,
      pObservations((await preparedCase(planFixture)).prepared),
      "policy",
    );
    expect(run.input.schemaVersion).toBe(2);
    expect(run.input.rubricVersion).toBe(CHRONICLE_LLM_JUDGE_RUBRIC_VERSION);
    expect(run.input.rubric).toEqual(CHRONICLE_LLM_JUDGE_RUBRIC);
    expect(run.input.rubric.dimensions).toEqual([
      ...CHRONICLE_LLM_JUDGE_DIMENSIONS,
    ]);
    expect(run.input.rubric.dimensions).toHaveLength(7);
    const scope = run.input.scope;
    if (!scope) throw new Error("Scoped input is missing its scope");
    expect(scope.observation).toBe("targeted");
    expect(scope.exclusions.length).toBeGreaterThan(0);
    expect(scope.referencePolicy).toEqual(
      CHRONICLE_LLM_JUDGE_SCOPE_REFERENCE_POLICY,
    );
    expect(run.input.scopeDigest).toBe(
      await digestStableJson({
        scopeVersion: run.input.scopeVersion,
        scope,
      }),
    );
    const { inputDigest: _inputDigest, ...inputWithoutDigest } = run.input;
    expect(run.input.inputDigest).toBe(
      await digestStableJson(inputWithoutDigest),
    );
    expect(run.input.rubric.sourceSupportRule).toBe(
      "Judge whether the permitted source text and evidence context support the complete explicitly asserted event, including its participant-role bindings, negation, actuality, attribution, and narrative frame. Predicate or entity presence alone is insufficient. An omission alone does not negate a supported known assertion; judge missing required information on the applicable completeness axes. Do not fill explicit unknowns from the source or Gold. Report source support independently when another axis mismatches. The same underlying error may make more than one independent axis mismatch; reporting it on one axis does not neutralize another. Keep temporal relations separate; a temporal mismatch does not change event source support. Treat evidenceCandidates.evidenceValid, overlap, directSupport, and contextSupport as citation-validity, reference-resolution, and range-coverage flags only; they never establish semantic entailment. A valid quote that covers the required range does not guarantee that the source supports the actual participant-role assertion.",
    );
    const messages = buildChronicleLlmJudgeMessages(run.input);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain(
      "an exclusion may share a quoted range with a Gold claim",
    );
    expect(messages[1]?.content).toContain("character:リナ");
    const userJson = JSON.parse(messages[1]?.content ?? "null") as {
      scope?: { referencePolicy?: unknown };
    };
    expect(userJson.scope?.referencePolicy).toEqual(
      CHRONICLE_LLM_JUDGE_SCOPE_REFERENCE_POLICY,
    );
    expect(prepared.contract.caseId).toBe("transfer-plan-001");
  });

  it("runs P through the production parser and accepts a valid speech scope exclusion", async () => {
    const sourcePrepared = await preparedCase(planFixture);
    const observations = pObservations(sourcePrepared.prepared, {
      includeSpeech: true,
    });
    const { run } = await prepareRun(planFixture, observations, "p-pass");
    const actual = run.input.actualClaims.find(
      (claim) => claim.predicate === "運ぶ",
    );
    if (!actual) throw new Error("P target actual is missing");
    expect(actual.participants).toContainEqual({
      surface: "私",
      role: "agent",
    });
    expect(actual.participants).not.toContainEqual({
      surface: "リナ",
      role: "agent",
    });
    const result = await run.validate(
      JSON.stringify(pResponseWithScopeExclusion(run.input)),
    );
    expect(result.projection.semanticStatus).toBe("PASS");
    expect(result.projection.actualCount).toBe(2);
    expect(result.projection.goldCount).toBe(1);
    expect(result.projection.unscoredActualCount).toBe(1);
    expect(result.projection.unresolvedEvidenceCount).toBe(0);
    expect(result.projection.parseFailureCount).toBe(0);
    const scope = run.input.scope;
    if (!scope) throw new Error("P input is not scoped");
    const speechScope = scope.exclusions.find((item) =>
      item.meaning.includes("発話行為"),
    );
    const goldRange = run.input.goldClaims[0]?.requiredDirectRegions[0];
    const scopeRange = speechScope?.allowedContextRegions.find(
      (region) =>
        region.start === goldRange?.start && region.end === goldRange?.end,
    );
    expect(scopeRange).toBeDefined();
  });

  it("keeps planned-to-actual promotion as an in-scope actuality and source-support failure", async () => {
    const sourcePrepared = await preparedCase(planFixture);
    const { run } = await prepareRun(
      planFixture,
      pObservations(sourcePrepared.prepared),
      "p-promotion",
    );
    const result = await run.validate(
      JSON.stringify(
        responseWithAxes(run.input, {
          predicate: "match",
          participants: "match",
          roles: "match",
          actuality: "mismatch",
          attribution: "match",
          narrativeFrame: "match",
          sourceSupport: "mismatch",
        }),
      ),
    );
    expect(result.projection.dimensions.actuality).toEqual({
      match: 0,
      mismatch: 1,
      undetermined: 0,
    });
    expect(result.projection.dimensions.sourceSupport).toEqual({
      match: 0,
      mismatch: 1,
      undetermined: 0,
    });
    expect(result.projection.unscoredActualCount).toBe(0);
    expect(result.projection.semanticStatus).toBe("FAIL");
  });

  it("keeps an unknown targeted scope claim undetermined and rejects an unknown scope ref", async () => {
    const sourcePrepared = await preparedCase(planFixture);
    const { run } = await prepareRun(
      planFixture,
      pObservations(sourcePrepared.prepared, { includeSpeech: true }),
      "p-unknown-scope",
    );
    const undetermined = await run.validate(
      JSON.stringify(pResponseWithUndeterminedSpeech(run.input)),
    );
    expect(undetermined.projection.semanticStatus).toBe("UNDETERMINED");
    expect(undetermined.projection.unscoredActualCount).toBe(0);

    const response = pResponseWithScopeExclusion(run.input);
    const unknownScope = {
      ...response,
      unmatchedActuals: response.unmatchedActuals.map((item) => ({
        ...item,
        scopeRef: "stale-scope-ref",
      })),
    };
    await expect(
      run.validate(JSON.stringify(unknownScope)),
    ).rejects.toMatchObject({
      code: "JUDGE_REFERENCE_INVALID",
    });
  });

  it("does not exempt fabricated claims or unsupported citation ranges as unscored", async () => {
    const sourcePrepared = await preparedCase(planFixture);
    const { run } = await prepareRun(
      planFixture,
      pObservations(sourcePrepared.prepared, { includeSpeech: true }),
      "p-fabricated",
    );
    const scoped = pResponseWithScopeExclusion(run.input);
    const fabricated = {
      ...scoped,
      unmatchedActuals: scoped.unmatchedActuals.map((item) => ({
        ...item,
        status: "fabricated" as const,
        scopeRef: undefined,
        scopeMatch: undefined,
        sourceSupport: undefined,
      })),
    };
    const fabricatedResult = await run.validate(JSON.stringify(fabricated));
    expect(fabricatedResult.projection.fabricatedActualCount).toBe(1);
    expect(fabricatedResult.projection.unscoredActualCount).toBe(0);
    expect(fabricatedResult.projection.semanticStatus).toBe("FAIL");

    const unsupportedPrepared = await preparedCase(planFixture);
    const [plannedSentence, residualSentence] = sentenceQuotes(
      unsupportedPrepared.prepared.evalCase.documents[0]!.text,
    );
    const unsupported = await prepareRun(
      planFixture,
      pObservations(unsupportedPrepared.prepared, {
        includeSpeech: true,
        speechQuote: residualSentence,
      }),
      "p-unsupported-evidence",
    );
    expect(plannedSentence).not.toBe(residualSentence);
    const unsupportedResponse = pResponseWithScopeExclusion(
      unsupported.run.input,
    );
    await expect(
      unsupported.run.validate(JSON.stringify(unsupportedResponse)),
    ).rejects.toMatchObject({ code: "JUDGE_REFERENCE_INVALID" });
  });

  it("preserves color-modifier omissions and rejects missing participant completion", async () => {
    const actualPrepared = await preparedCase(actualFixture);
    const actual = await prepareRun(
      actualFixture,
      actualObservations(actualPrepared.prepared),
      "a-color",
    );
    const put = actual.run.input.actualClaims.find(
      (claim) => claim.predicate === "入れる",
    );
    if (!put) throw new Error("A put actual is missing");
    expect(put.participants).toContainEqual({ surface: "布", role: "theme" });
    expect(put.participants).not.toContainEqual({
      surface: "赤い布",
      role: "theme",
    });
    const actualResult = await actual.run.validate(
      JSON.stringify(allMatchResponse(actual.run.input)),
    );
    expect(actualResult.projection.semanticStatus).toBe("PASS");

    const dreamPrepared = await preparedCase(dreamFixture);
    const dream = await prepareRun(
      dreamFixture,
      dreamObservations(dreamPrepared.prepared),
      "d-color",
    );
    const swim = dream.run.input.actualClaims.find(
      (claim) => claim.predicate === "泳ぐ",
    );
    if (!swim) throw new Error("D swim actual is missing");
    expect(swim.participants).toContainEqual({ surface: "魚", role: "agent" });
    expect(swim.participants).not.toContainEqual({
      surface: "銀の魚",
      role: "agent",
    });
    const dreamResult = await dream.run.validate(
      JSON.stringify(allMatchResponse(dream.run.input)),
    );
    expect(dreamResult.projection.semanticStatus).toBe("PASS");

    const missingPrepared = await preparedCase(planFixture);
    const missing = await prepareRun(
      planFixture,
      pObservations(missingPrepared.prepared, { missingTheme: true }),
      "p-missing-participant",
    );
    const target = missing.run.input.actualClaims[0];
    if (!target) throw new Error("Missing P target");
    expect(target.participants).toHaveLength(1);
    expect(target.participants).not.toContainEqual({
      surface: "薬箱",
      role: "theme",
    });
    const missingResult = await missing.run.validate(
      JSON.stringify(
        responseWithAxes(missing.run.input, {
          predicate: "match",
          participants: "mismatch",
          roles: "match",
          actuality: "match",
          attribution: "match",
          narrativeFrame: "match",
          sourceSupport: "mismatch",
        }),
      ),
    );
    expect(missingResult.projection.semanticStatus).toBe("FAIL");
    expect(missingResult.projection.dimensions.participants.mismatch).toBe(1);
  });

  it("rejects foreign/stale refs and refuses tampered scoped serialization", async () => {
    const sourcePrepared = await preparedCase(planFixture);
    const first = await prepareRun(
      planFixture,
      pObservations(sourcePrepared.prepared),
      "stale-first",
    );
    const second = await prepareRun(
      planFixture,
      pObservations((await preparedCase(planFixture)).prepared),
      "stale-second",
    );
    const firstResponse = allMatchResponse(first.run.input);
    await expect(
      second.run.validate(JSON.stringify(firstResponse)),
    ).rejects.toMatchObject({
      code: "JUDGE_REFERENCE_INVALID",
    });

    const result = await first.run.validate(
      JSON.stringify(allMatchResponse(first.run.input)),
    );
    const serialized = await first.run.serialize(result);
    expect(JSON.parse(serialized)).toEqual(result.projection);
    const tampered = {
      ...result,
      projection: {
        ...result.projection,
        scopeDigest: "sha256:" + "0".repeat(64),
      },
    };
    await expect(first.run.serialize(tampered)).rejects.toMatchObject({
      code: "JUDGE_SERIALIZATION_INVALID",
    });
    const extraField = {
      ...result,
      projection: {
        ...result.projection,
        untrusted: true,
      },
    };
    await expect(first.run.serialize(extraField)).rejects.toMatchObject({
      code: "JUDGE_SERIALIZATION_INVALID",
    });
    expect(scopeRefForSpeech(first.run.input)).toMatch(/^stale-first-opaque-/);
  });

  it("rejects a stale citation ID before judge input construction", async () => {
    const sourcePrepared = await preparedCase(planFixture);
    const prepared = sourcePrepared.prepared;
    const firstWindow = prepared.windows[0];
    if (!firstWindow?.windowId) throw new Error("P window is missing");
    const staleObservation = JSON.stringify({
      observations: [
        {
          localId: "p-stale-citation",
          evidenceRefs: ["Eforeign-request-001"],
          assertion: {
            attribution: "character:リナ",
            narrativeFrame: "reported",
          },
          payload: {
            predicate: "運ぶ",
            actuality: "planned",
            participants: [{ surface: "私", role: "agent" }],
            temporalExpressions: [],
            durationKind: "unknown",
          },
        },
      ],
    });
    await expect(
      prepareChronicleLlmJudgeOfflineRun({
        prepared,
        contract: sourcePrepared.contract,
        observationResponsesByWindowId: new Map([
          [firstWindow.windowId, staleObservation],
        ]),
      }),
    ).rejects.toMatchObject({
      code: "NEX_CHRONICLE_CITATION_ID_EVIDENCE_SPAN_REFERENCE_UNKNOWN",
    });
  });

  it.each(["rumored", "actual"] as const)(
    "projects H %s through the canonical parser and fixed semantic response",
    async (actuality) => {
      const fixture = hearsayFixture;
      const prepared = await preparedCase(fixture);
      const [quote] = sentenceQuotes(
        prepared.prepared.evalCase.documents[0]!.text,
      );
      const { run } = await prepareRun(
        fixture,
        [
          {
            localId: "h-content",
            quote,
            predicate: "燃える",
            actuality,
            participants: [{ surface: "山小屋", role: "theme" }],
            attribution: "character:ハル",
            narrativeFrame: "reported",
            durationKind: "unknown",
          },
        ],
        `hearsay-${actuality}`,
      );
      expect(run.input.actualClaims).toHaveLength(1);
      expect(run.input.actualClaims[0]).toMatchObject({
        actuality,
        attribution: "character:ハル",
        narrativeFrame: "reported",
      });
      const response = responseWithAxes(run.input, {
        predicate: "match",
        participants: "match",
        roles: "match",
        actuality: actuality === "rumored" ? "match" : "mismatch",
        attribution: "match",
        narrativeFrame: "match",
        sourceSupport: actuality === "rumored" ? "match" : "mismatch",
      });
      const result = await run.validate(JSON.stringify(response));
      expect(result.projection.semanticStatus).toBe(
        actuality === "rumored" ? "PASS" : "FAIL",
      );
    },
  );

  it("keeps the hearing act outside H even when its evidence overlaps the fire claim", async () => {
    const prepared = await preparedCase(hearsayFixture);
    const [quote] = sentenceQuotes(
      prepared.prepared.evalCase.documents[0]!.text,
    );
    const { run } = await prepareRun(
      hearsayFixture,
      [
        {
          localId: "h-fire",
          quote,
          predicate: "燃える",
          actuality: "rumored",
          participants: [{ surface: "山小屋", role: "theme" }],
          attribution: "character:ハル",
          narrativeFrame: "reported",
          durationKind: "unknown",
        },
        {
          localId: "h-hearing",
          quote,
          predicate: "聞く",
          actuality: "actual",
          participants: [{ surface: "ハル", role: "experiencer" }],
          attribution: "narrator",
          narrativeFrame: "story-world",
          durationKind: "unknown",
        },
      ],
      "hearsay-hearing",
    );
    const target = run.input.actualClaims.find(
      (claim) => claim.predicate === "燃える",
    )!;
    const hearing = run.input.actualClaims.find(
      (claim) => claim.predicate === "聞く",
    )!;
    const exclusion = run.input.scope?.exclusions.find((scope) =>
      scope.meaning.includes("聴取行為"),
    );
    if (!exclusion) throw new Error("H hearing exclusion is missing");
    const response = buildChronicleLlmJudgeResponse(run.input, {
      primaryAssignments: [
        {
          actualRef: target.ref,
          goldRef: run.input.goldClaims[0]!.ref,
          axes: {
            predicate: "match",
            participants: "match",
            roles: "match",
            actuality: "match",
            attribution: "match",
            narrativeFrame: "match",
            sourceSupport: "match",
          },
        },
      ],
      unmatchedActuals: [
        {
          actualRef: hearing.ref,
          status: "unscored",
          scopeRef: exclusion.ref,
          scopeMatch: "match",
          sourceSupport: "match",
        },
      ],
      unmatchedGolds: [],
      temporalRelations: [],
    });
    const result = await run.validate(JSON.stringify(response));
    expect(result.projection.semanticStatus).toBe("PASS");
  });

  it("rejects an explicitly disabled representation-gap contract", async () => {
    const { prepared, contract } = await preparedCase({
      ...hearsayFixture,
      authorship: {
        ...hearsayFixture.authorship,
        runtimeCapability: "representation-gap",
        ordinaryQualityRun: "disabled",
      },
    });
    await expect(
      prepareChronicleLlmJudgeOfflineRun({
        prepared,
        contract,
        observationResponsesByWindowId: new Map(),
      }),
    ).rejects.toMatchObject({ code: "JUDGE_CONTEXT_UNSUPPORTED" });
  });

  it("does not turn empty hypotheses or proposals into an Observation failure", async () => {
    const sourcePrepared = await preparedCase(actualFixture);
    const { run } = await prepareRun(
      actualFixture,
      actualObservations(sourcePrepared.prepared),
      "empty-downstream",
    );
    expect(run.input.actualClaims).toHaveLength(2);
    const result = await run.validate(
      JSON.stringify(allMatchResponse(run.input)),
    );
    expect(result.projection.semanticStatus).toBe("PASS");
    expect(result.projection.actualCount).toBe(2);
    expect(result.projection.goldCount).toBe(2);
  });
});
