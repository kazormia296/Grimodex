import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CITATION_ID_OBSERVATION_EVIDENCE_MODE } from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { loadNarrativeEvalSuite } from "./narrativeEvalSuite";
import { digestStableJson } from "../source/digest";
import {
  buildChronicleLlmJudgeResponse,
  CHRONICLE_LLM_JUDGE_RUBRIC_VERSION,
  parseChronicleLlmJudgeResponse,
  prepareChronicleLlmJudgeOfflineRun,
  runChronicleLlmJudgeOffline,
  serializeChronicleLlmJudgeOfflineResult,
  type ChronicleLlmJudgeInput,
  type ChronicleLlmJudgePreparedRun,
  type ChronicleLlmJudgeResponse,
} from "./chronicleLlmJudgeOffline";
import { prepareProductionChronicleEvalCase } from "./productionChronicleAdapter";
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
    model: "chronicle-llm-judge-fixture-model",
    provider: "chronicle-llm-judge-fixture",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "chronicle-llm-judge-offline-test" }),
  },
}));

const CASE_ID = "chronicle.micro.actual-gate-collapse-001";
const SOURCE_QUOTE_A = "夜半、北門の鎖が切れ、重い門扉が街路へ倒れた。";
const SOURCE_QUOTE_B = "衛兵は鐘を鳴らし、通行人を広場へ退避させた。";
const ROOT = path.resolve(import.meta.dirname, "../../../..");

interface FixtureContext {
  readonly evalCase: NarrativeEvalCaseV1;
  readonly contract: unknown;
}

async function fixtureContext(): Promise<FixtureContext> {
  const suite = await loadNarrativeEvalSuite({
    repoRoot: ROOT,
    suiteId: "chronicle-micro-v1",
  });
  const evalCase = suite.cases.find((candidate) => candidate.id === CASE_ID);
  if (!evalCase) throw new Error(`Missing evaluation case ${CASE_ID}`);
  const contractModule = await import("./chronicleV2Contract");
  const contractSource =
    await import("../../../../evals/narrative/contracts/chronicle-v2/actual-gate-collapse.json");
  const loaded = contractModule.loadChronicleV2Contract(contractSource.default);
  if (!loaded.ok) throw new Error("Chronicle v2 contract failed to load");
  const sourceOnly: NarrativeEvalCaseV1 = {
    ...evalCase,
    coverage: {
      ...evalCase.coverage,
      includedDocumentIds: loaded.value.sourceDocuments.map(
        (document) => document.id,
      ),
      omittedDocumentIds: [],
    },
    documents: loaded.value.sourceDocuments.map((document) => ({
      ...document,
    })),
    expected: { observations: { required: [], forbidden: [] } },
    criticalViolationClasses: [],
  };
  return { evalCase: sourceOnly, contract: loaded.value };
}

async function preparedFixture() {
  const context = await fixtureContext();
  const runtimeDocuments = context.evalCase.documents.map((document) => ({
    ...document,
    id: `prepared-${document.id}`,
  }));
  const runtimeCase: NarrativeEvalCaseV1 = {
    ...context.evalCase,
    coverage: {
      ...context.evalCase.coverage,
      includedDocumentIds: runtimeDocuments.map((document) => document.id),
      omittedDocumentIds: [],
    },
    documents: runtimeDocuments,
  };
  const prepared = await prepareProductionChronicleEvalCase(runtimeCase, {
    evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  });
  return { prepared, contract: context.contract as never };
}

function aliasForQuote(
  prepared: Awaited<ReturnType<typeof preparedFixture>>["prepared"],
  quote: string,
): string {
  const entry = prepared.evidenceSpanCatalog?.entries.find(
    (candidate) => candidate.quote === quote,
  );
  if (!entry) throw new Error(`Missing evidence catalog quote: ${quote}`);
  const alias = prepared.evidenceSpanCatalogBindingsByWindowId
    ? [...prepared.evidenceSpanCatalogBindingsByWindowId.values()]
        .flatMap((binding) => binding.aliases)
        .find((candidate) => candidate.canonicalSourceRef === entry.sourceRef)
    : undefined;
  if (!alias) throw new Error(`Missing evidence alias for quote: ${quote}`);
  return alias.alias;
}

interface FixedClaim {
  readonly quote: string;
  readonly predicate: string;
  readonly participants: readonly { surface: string; role: string }[];
  readonly semanticType?: string;
  readonly actuality?: RawChronicleEventObservation["payload"]["actuality"];
}

const BASE_CLAIMS: readonly FixedClaim[] = [
  {
    quote: SOURCE_QUOTE_A,
    predicate: "鎖が切れた",
    participants: [{ surface: "north-gate-chain", role: "theme" }],
  },
  {
    quote: SOURCE_QUOTE_A,
    predicate: "門扉が倒れた",
    participants: [
      { surface: "gate-leaf", role: "theme" },
      { surface: "street", role: "destination" },
    ],
  },
  {
    quote: SOURCE_QUOTE_B,
    predicate: "鐘を鳴らした",
    participants: [
      { surface: "guard", role: "agent" },
      { surface: "bell", role: "theme" },
    ],
  },
  {
    quote: SOURCE_QUOTE_B,
    predicate: "退避させた",
    participants: [
      { surface: "guard", role: "agent" },
      { surface: "passerby", role: "theme" },
      { surface: "square", role: "destination" },
    ],
  },
];

function fixedObservationResponse(
  prepared: Awaited<ReturnType<typeof preparedFixture>>["prepared"],
  claims: readonly FixedClaim[],
): string {
  return JSON.stringify({
    observations: claims.map((claim, index) => ({
      localId: `model-row-${index + 1}`,
      evidenceRefs: [aliasForQuote(prepared, claim.quote)],
      assertion: { attribution: "narrator", narrativeFrame: "story-world" },
      payload: {
        predicate: claim.predicate,
        actuality: claim.actuality ?? "actual",
        participants: claim.participants,
        ...(claim.semanticType ? { semanticType: claim.semanticType } : {}),
        temporalExpressions: claim.quote === SOURCE_QUOTE_A ? ["夜半"] : [],
        durationKind: "instant",
      },
    })),
  });
}

function allMatchResponse(
  input: ChronicleLlmJudgeInput,
): ChronicleLlmJudgeResponse {
  return buildChronicleLlmJudgeResponse(input, {
    primaryAssignments: input.actualClaims.map((actual, index) => ({
      actualRef: actual.ref,
      goldRef: input.goldClaims[index]?.ref ?? input.goldClaims[0]?.ref ?? "",
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
    unmatchedActuals: input.actualClaims
      .slice(input.goldClaims.length)
      .map((actual) => ({
        actualRef: actual.ref,
        status: "undetermined",
      })),
    unmatchedGolds: input.goldClaims
      .slice(input.actualClaims.length)
      .map((gold) => ({
        goldRef: gold.ref,
        status: "undetermined",
      })),
    temporalRelations: input.temporalRelations.map((relation) => {
      const targetIndex = input.goldClaims.findIndex(
        (gold) => gold.ref === relation.targetGoldRef,
      );
      return {
        relationRef: relation.ref,
        actualRef: input.actualClaims[targetIndex]?.ref ?? null,
        status: "match" as const,
      };
    }),
  });
}

type JudgeMutation =
  | "all-match"
  | "semantic-duplicate"
  | "all-undetermined"
  | "missing-destination"
  | "wrong-predicate"
  | "negative-predicate"
  | "role-inversion-instruction";

function responseForMutation(
  input: ChronicleLlmJudgeInput,
  mutation: JudgeMutation,
): ChronicleLlmJudgeResponse {
  if (mutation === "all-match") return allMatchResponse(input);
  const primaryAssignments: ChronicleLlmJudgeResponse["primaryAssignments"] =
    input.actualClaims.slice(0, 4).map((actual, index) => ({
      actualRef: actual.ref,
      goldRef: input.goldClaims[index]!.ref,
      axes: {
        predicate:
          (mutation === "wrong-predicate" ||
            mutation === "negative-predicate") &&
          index === 1
            ? "mismatch"
            : "match",
        participants:
          mutation === "missing-destination" && index === 1
            ? "mismatch"
            : "match",
        roles:
          mutation === "role-inversion-instruction" && index === 1
            ? "mismatch"
            : "match",
        actuality: "match",
        attribution: "match",
        narrativeFrame: "match",
        sourceSupport:
          (mutation === "wrong-predicate" ||
            mutation === "negative-predicate") &&
          index === 1
            ? "mismatch"
            : "match",
      },
    }));
  const unmatchedActuals = input.actualClaims.slice(4).map((actual) => ({
    actualRef: actual.ref,
    status:
      mutation === "semantic-duplicate"
        ? ("duplicate" as const)
        : ("undetermined" as const),
    ...(mutation === "semantic-duplicate"
      ? { duplicateOf: input.actualClaims[1]!.ref }
      : {}),
  }));
  const unmatchedGolds = input.goldClaims.slice(4).map((gold) => ({
    goldRef: gold.ref,
    status: "undetermined" as const,
  }));
  if (mutation === "all-undetermined") {
    return buildChronicleLlmJudgeResponse(input, {
      primaryAssignments: [],
      unmatchedActuals: input.actualClaims.map((actual) => ({
        actualRef: actual.ref,
        status: "undetermined",
      })),
      unmatchedGolds: input.goldClaims.map((gold) => ({
        goldRef: gold.ref,
        status: "undetermined",
      })),
      temporalRelations: input.temporalRelations.map((relation) => ({
        relationRef: relation.ref,
        actualRef: null,
        status: "undetermined",
        reason: "event-identity-unavailable",
      })),
    });
  }
  return buildChronicleLlmJudgeResponse(input, {
    primaryAssignments,
    unmatchedActuals,
    unmatchedGolds,
    temporalRelations: input.temporalRelations.map((relation) => {
      const target = primaryAssignments.find(
        (assignment) => assignment.goldRef === relation.targetGoldRef,
      );
      const exact =
        target !== undefined &&
        Object.values(target.axes).every((status) => status === "match");
      return {
        relationRef: relation.ref,
        actualRef: exact ? target.actualRef : null,
        status: exact ? ("match" as const) : ("undetermined" as const),
        ...(exact ? {} : { reason: "event-identity-unavailable" as const }),
      };
    }),
  });
}

async function runMutation(
  mutation: JudgeMutation,
  claims: readonly FixedClaim[] = BASE_CLAIMS,
) {
  const { prepared, contract } = await preparedFixture();
  const response = fixedObservationResponse(prepared, claims);
  return runChronicleLlmJudgeOffline({
    prepared,
    contract,
    observationResponsesByWindowId: new Map([
      [prepared.windows[0]!.windowId!, response],
    ]),
    judgeResponse: (input) =>
      JSON.stringify(responseForMutation(input, mutation)),
    createId: (() => {
      let index = 0;
      return () => `offline-test-id-${++index}`;
    })(),
    createOpaqueId: (() => {
      let index = 0;
      return () => `opaque-${++index}`;
    })(),
  });
}

async function prepareJudgeRun(claims: readonly FixedClaim[] = BASE_CLAIMS) {
  const { prepared, contract } = await preparedFixture();
  const observationResponse = fixedObservationResponse(prepared, claims);
  const run = await prepareChronicleLlmJudgeOfflineRun({
    prepared,
    contract,
    observationResponsesByWindowId: new Map([
      [prepared.windows[0]!.windowId!, observationResponse],
    ]),
    createId: (() => {
      let index = 0;
      return () => `serializer-test-id-${++index}`;
    })(),
    createOpaqueId: (() => {
      let index = 0;
      return () => `serializer-opaque-${++index}`;
    })(),
  });
  return { prepared, contract, run };
}

describe("offline Chronicle LLM judge", () => {
  it("binds source support rubric v2 and its digest to the prepared input", async () => {
    const { run } = await prepareJudgeRun();
    expect(run.input.rubricVersion).toBe(CHRONICLE_LLM_JUDGE_RUBRIC_VERSION);
    expect(run.input.rubricVersion).toBe("chronicle-llm-judge-rubric/2");
    expect(run.input.rubric.sourceSupportRule).toBe(
      "Judge whether the permitted source text and evidence context support the complete explicitly asserted event, including its participant-role bindings, negation, actuality, attribution, and narrative frame. Predicate or entity presence alone is insufficient. An omission alone does not negate a supported known assertion; judge missing required information on the applicable completeness axes. Do not fill explicit unknowns from the source or Gold. Report source support independently when another axis mismatches. The same underlying error may make more than one independent axis mismatch; reporting it on one axis does not neutralize another. Keep temporal relations separate; a temporal mismatch does not change event source support. Treat evidenceCandidates.evidenceValid, overlap, directSupport, and contextSupport as citation-validity, reference-resolution, and range-coverage flags only; they never establish semantic entailment. A valid quote that covers the required range does not guarantee that the source supports the actual participant-role assertion.",
    );
    const { inputDigest, ...withoutInputDigest } = run.input;
    await expect(digestStableJson(withoutInputDigest)).resolves.toBe(
      inputDigest,
    );
  });

  it("accepts only strict JSON responses and keeps the input identity opaque", async () => {
    expect(() => parseChronicleLlmJudgeResponse("prefix {} suffix")).toThrow(
      /JSON|schema/i,
    );
    const { prepared, contract } = await preparedFixture();
    const run = await prepareChronicleLlmJudgeOfflineRun({
      prepared,
      contract,
      observationResponsesByWindowId: new Map([
        [
          prepared.windows[0]!.windowId!,
          fixedObservationResponse(prepared, BASE_CLAIMS),
        ],
      ]),
      createOpaqueId: (() => {
        let index = 0;
        return () => `opaque-control-${++index}`;
      })(),
    });
    expect(
      run.input.actualClaims.every(
        (claim) => !claim.ref.startsWith("eval-window-"),
      ),
    ).toBe(true);
    expect(
      run.input.goldClaims.every((claim) => !claim.ref.includes("chain-break")),
    ).toBe(true);
    expect(
      run.input.evidenceCandidates.every((candidate) =>
        candidate.actualRef.startsWith("opaque-control-"),
      ),
    ).toBe(true);
    expect(Object.isFrozen(run.input)).toBe(true);
    expect(Object.isFrozen(run.input.actualClaims)).toBe(true);
  });

  it("runs fixed observations through the production parser and merger", async () => {
    const result = await runMutation("all-match");
    expect(result.projection.actualCount).toBe(4);
    expect(result.projection.goldCount).toBe(4);
    expect(result.projection.semanticStatus).toBe("PASS");
    expect(result.projection.diagnosticOnly).toBe(true);
    expect(result.projection.accepted).toBe(false);
  });

  it("keeps an expression-different duplicate after merger and permits either primary orientation", async () => {
    const claims = [
      ...BASE_CLAIMS,
      {
        ...BASE_CLAIMS[1]!,
        predicate: "門扉が街路へ倒れ込んだ",
      },
    ];
    const result = await runMutation("semantic-duplicate", claims);
    expect(result.projection.actualCount).toBe(5);
    expect(result.projection.cardinalityExcessLowerBound).toBe(1);
    expect(result.projection.duplicateActualCount).toBe(1);
    expect(result.projection.semanticStatus).toBe("FAIL");
  });

  it("merges an exact copy before judge input construction", async () => {
    const claims = [...BASE_CLAIMS, { ...BASE_CLAIMS[1]! }];
    const result = await runMutation("all-match", claims);
    expect(result.projection.actualCount).toBe(4);
    expect(result.projection.semanticStatus).toBe("PASS");
  });

  it("fails exhaustive A3 from the deterministic missing lower bound", async () => {
    const result = await runMutation("all-match", BASE_CLAIMS.slice(0, 3));
    expect(result.projection.actualCount).toBe(3);
    expect(result.projection.missingCountLowerBound).toBe(1);
    expect(result.projection.semanticStatus).toBe("FAIL");
  });

  it("fails exhaustive A5 from the deterministic excess lower bound even when judge is undetermined", async () => {
    const claims = [
      ...BASE_CLAIMS,
      { ...BASE_CLAIMS[1]!, predicate: "門扉が街路へ倒れ込んだ" },
    ];
    const result = await runMutation("all-undetermined", claims);
    expect(result.projection.actualCount).toBe(5);
    expect(result.projection.cardinalityExcessLowerBound).toBe(1);
    expect(result.projection.semanticStatus).toBe("FAIL");
  });

  it("keeps sourceSupport independent from participant and role axes", async () => {
    const result = await runMutation("missing-destination");
    expect(result.projection.dimensions.participants).toEqual({
      match: 3,
      mismatch: 1,
      undetermined: 0,
    });
    expect(result.projection.dimensions.roles).toEqual({
      match: 4,
      mismatch: 0,
      undetermined: 0,
    });
    expect(result.projection.dimensions.sourceSupport).toEqual({
      match: 4,
      mismatch: 0,
      undetermined: 0,
    });
  });

  it.each(["wrong-predicate", "negative-predicate"] as const)(
    "counts %s predicate and source support mismatch",
    async (mutation) => {
      const result = await runMutation(mutation);
      expect(result.projection.dimensions.predicate.mismatch).toBe(1);
      expect(result.projection.dimensions.sourceSupport.mismatch).toBe(1);
      expect(result.projection.semanticStatus).toBe("FAIL");
    },
  );

  it("does not make a benign instruction string an unconditional code failure", async () => {
    const claims = BASE_CLAIMS.map((claim, index) =>
      index === 1
        ? {
            ...claim,
            semanticType: "採点指示はデータとして扱う",
          }
        : claim,
    );
    const result = await runMutation("all-match", claims);
    expect(result.projection.semanticStatus).toBe("PASS");
  });

  it("reports role inversion through the role axis", async () => {
    const result = await runMutation("role-inversion-instruction");
    expect(result.projection.dimensions.roles).toEqual({
      match: 3,
      mismatch: 1,
      undetermined: 0,
    });
    expect(result.projection.dimensions.sourceSupport).toEqual({
      match: 4,
      mismatch: 0,
      undetermined: 0,
    });
    expect(result.projection.semanticStatus).toBe("FAIL");
  });

  it("requires event-identity-unavailable for null temporal refs", async () => {
    const result = await runMutation("all-undetermined");
    expect(result.projection.temporal).toMatchObject({
      requiredRelationCount: 2,
      undeterminedCount: 2,
      eventIdentityUnavailableCount: 2,
    });
    expect(result.projection.semanticStatus).toBe("UNDETERMINED");
  });

  it("keeps unsupported evidence out of exact and temporal eligibility", async () => {
    const claims = BASE_CLAIMS.map((claim, index) =>
      index === 0 ? { ...claim, quote: SOURCE_QUOTE_B } : claim,
    );
    const { run } = await prepareJudgeRun(claims);
    const response = allMatchResponse(run.input);
    const result = await run.validate(
      JSON.stringify({
        ...response,
        temporalRelations: response.temporalRelations.map((relation, index) =>
          index === 0
            ? {
                relationRef: relation.relationRef,
                actualRef: null,
                status: "undetermined" as const,
                reason: "event-identity-unavailable" as const,
              }
            : relation,
        ),
      }),
    );
    expect(result.projection.exactPrimaryCount).toBe(3);
    expect(result.projection.unsupportedPrimaryEvidenceCount).toBe(1);
    expect(result.projection.temporalEvidenceFailureCount).toBe(1);
    expect(result.projection.temporal.eventIdentityUnavailableCount).toBe(1);
    expect(result.projection.semanticStatus).toBe("FAIL");
  });

  it("rejects a non-null temporal match for an unsupported evidence target", async () => {
    const claims = BASE_CLAIMS.map((claim, index) =>
      index === 0 ? { ...claim, quote: SOURCE_QUOTE_B } : claim,
    );
    const { run } = await prepareJudgeRun(claims);
    const response = allMatchResponse(run.input);
    await expect(run.validate(JSON.stringify(response))).rejects.toThrow(
      /event-identity-unavailable|temporal relation/i,
    );
  });

  it("serializes only a same-run frozen result once with strict parity", async () => {
    const { run } = await prepareJudgeRun();
    const result = await run.validate(
      JSON.stringify(allMatchResponse(run.input)),
    );
    expect(Object.isFrozen(result)).toBe(true);
    const serialized = await run.serialize(result);
    expect(JSON.parse(serialized)).toEqual(result.projection);
    await expect(run.serialize(result)).resolves.toBe(serialized);
    await expect(run.serialize(structuredClone(result))).rejects.toThrow(
      /same run|prepared|serialize/i,
    );
    await expect(
      serializeChronicleLlmJudgeOfflineResult(
        {
          serialize: async () => "{}",
        } as unknown as ChronicleLlmJudgePreparedRun,
        result,
      ),
    ).rejects.toThrow(/prepared|run/i);
  });

  it("rejects incomplete partitions, duplicate chains, and an actual temporal retarget", async () => {
    const { prepared, contract } = await preparedFixture();
    const observationResponse = fixedObservationResponse(prepared, BASE_CLAIMS);
    const run = await prepareChronicleLlmJudgeOfflineRun({
      prepared,
      contract,
      observationResponsesByWindowId: new Map([
        [prepared.windows[0]!.windowId!, observationResponse],
      ]),
      createId: (() => {
        let index = 0;
        return () => `partition-test-id-${++index}`;
      })(),
      createOpaqueId: (() => {
        let index = 0;
        return () => `partition-opaque-${++index}`;
      })(),
    });
    const input = run.input;
    const baseline = responseForMutation(input, "all-match");
    await expect(
      run.validate(
        JSON.stringify({
          ...baseline,
          primaryAssignments: baseline.primaryAssignments.slice(1),
        }),
      ),
    ).rejects.toThrow(/partition|actual/i);
    const duplicateChain = buildChronicleLlmJudgeResponse(input, {
      ...baseline,
      primaryAssignments: baseline.primaryAssignments.slice(2),
      unmatchedActuals: [
        {
          actualRef: input.actualClaims[0]!.ref,
          status: "duplicate",
          duplicateOf: input.actualClaims[1]!.ref,
        },
        {
          actualRef: input.actualClaims[1]!.ref,
          status: "duplicate",
          duplicateOf: input.actualClaims[2]!.ref,
        },
      ],
      unmatchedGolds: input.goldClaims.slice(0, 2).map((gold) => ({
        goldRef: gold.ref,
        status: "undetermined" as const,
      })),
      temporalRelations: input.temporalRelations.map((relation) => ({
        relationRef: relation.ref,
        actualRef: null,
        status: "undetermined" as const,
        reason: "event-identity-unavailable" as const,
      })),
    });
    await expect(run.validate(JSON.stringify(duplicateChain))).rejects.toThrow(
      /partition|primary|duplicate/i,
    );

    const firstRelation = input.temporalRelations[0]!;
    const firstTarget = baseline.primaryAssignments.find(
      (assignment) => assignment.goldRef === firstRelation.targetGoldRef,
    );
    const wrongActual = baseline.primaryAssignments.find(
      (assignment) => assignment.actualRef !== firstTarget?.actualRef,
    );
    if (!firstTarget || !wrongActual)
      throw new Error("Missing temporal retarget control");
    const retargeted = buildChronicleLlmJudgeResponse(input, {
      ...baseline,
      temporalRelations: baseline.temporalRelations.map((relation, index) =>
        index === 0
          ? {
              relationRef: relation.relationRef,
              actualRef: wrongActual.actualRef,
              status: "match" as const,
            }
          : relation,
      ),
    });
    await expect(run.validate(JSON.stringify(retargeted))).rejects.toThrow(
      /retarget|temporal/i,
    );
  });
});
