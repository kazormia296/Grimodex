import { describe, expect, it } from "vitest";
import { productionRuntime } from "./production-runtime";
import {
  LIVE_CONFIG,
  createOfflineBudget,
  createOpenRouterTransport,
  loadCalibrationFixture,
  loadSourceOnlyContext,
  runCalibration,
} from "./live-driver.mjs";

const FAKE_API_KEY = "sk-test-canary_123";
const JSON_HEADERS = { "content-type": "application/json" };
const GOLD_IDS = [
  "chain-break",
  "gate-fall",
  "guards-ring-bell",
  "guards-evacuate-passersby",
] as const;
const TEMPORAL_IDS = [
  "night-half-chain-break",
  "night-half-gate-fall",
] as const;

type Fixture = Awaited<ReturnType<typeof loadCalibrationFixture>>;
type Scenario = Fixture["scenarios"][number];
type JudgeInput = {
  actualClaims: Array<{ ref: string }>;
  goldClaims: Array<{ ref: string }>;
  temporalRelations: Array<{ ref: string }>;
};
type CapturedJudgeInput = {
  rubricVersion: string;
  rubric: {
    sourceSupportRule: string;
    actualDataRule: string;
  };
  actualClaims: Array<{
    predicate: string;
    semanticType: string | null;
  }>;
};
type CapturedJudgeCall = {
  body: string;
  init: RequestInit | undefined;
};
type ProviderFailure = "schema" | "transport" | undefined;

const RUBRIC_VERSION_V2 = "chronicle-llm-judge-rubric/2";

function fixtureResponse(
  scenario: Scenario,
  input: JudgeInput,
  variantIndex: number,
): string {
  const variant = scenario.expected.variants[variantIndex];
  if (!variant) throw new Error(`Missing fixture variant ${variantIndex}`);
  const actualRefs = new Map(
    scenario.response.observations.map((observation, index) => [
      observation.localId,
      input.actualClaims[index]?.ref,
    ]),
  );
  const goldRefs = new Map(GOLD_IDS.map((id, index) => [id, input.goldClaims[index]?.ref]));
  const relationRefs = new Map(
    TEMPORAL_IDS.map((id, index) => [id, input.temporalRelations[index]?.ref]),
  );
  const resolve = (value: string | null | undefined, label: string) => {
    if (!value) throw new Error(`Missing opaque ${label}`);
    return value;
  };
  return JSON.stringify({
    schemaVersion: 1,
    judgeVersion: "chronicle-llm-judge-offline/1",
    primaryAssignments: variant.primaryAssignments.map((assignment) => ({
      actualRef: resolve(actualRefs.get(assignment.actualLocalId), "actual ref"),
      goldRef: resolve(goldRefs.get(assignment.goldClaimId), "Gold ref"),
      axes: assignment.axes,
    })),
    unmatchedActuals: variant.unmatchedActuals.map((actual) => ({
      actualRef: resolve(actualRefs.get(actual.actualLocalId), "unmatched actual ref"),
      status: actual.status,
      ...(actual.duplicateOf
        ? {
            duplicateOf: resolve(
              actualRefs.get(actual.duplicateOf),
              "duplicate actual ref",
            ),
          }
        : {}),
    })),
    unmatchedGolds: variant.unmatchedGolds.map((gold) => ({
      goldRef: resolve(goldRefs.get(gold.goldClaimId), "unmatched Gold ref"),
      status: gold.status,
    })),
    temporalRelations: variant.temporalRelations.map((relation) => ({
      relationRef: resolve(
        relationRefs.get(relation.goldRelationId),
        "temporal relation ref",
      ),
      actualRef:
        relation.actualLocalId === null
          ? null
          : resolve(actualRefs.get(relation.actualLocalId), "temporal actual ref"),
      status: relation.status,
      ...(relation.reason ? { reason: relation.reason } : {}),
    })),
  });
}

function requestInput(init: RequestInit | undefined): JudgeInput {
  if (typeof init?.body !== "string") throw new Error("missing request body");
  const request = JSON.parse(init.body) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  const userMessage = request.messages?.find((message) => message.role === "user");
  if (!userMessage?.content) throw new Error("missing judge message");
  const payload = JSON.parse(userMessage.content) as { input?: JudgeInput };
  if (!payload.input) throw new Error("missing judge input");
  return payload.input;
}

function capturedJudgeInput(call: CapturedJudgeCall): CapturedJudgeInput {
  const request = JSON.parse(call.body) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  const userMessage = request.messages?.find(
    (message) => message.role === "user",
  );
  if (!userMessage?.content) throw new Error("missing captured judge message");
  const payload = JSON.parse(userMessage.content) as {
    input?: CapturedJudgeInput;
  };
  if (!payload.input) throw new Error("missing captured judge input");
  return payload.input;
}

async function runWithFakeOpenRouter(options: {
  readonly c07Variant?: number;
  readonly failureAt?: number;
  readonly failureKind?: ProviderFailure;
  readonly mismatchAt?: number;
}) {
  const [context, fixture] = await Promise.all([
    loadSourceOnlyContext(productionRuntime, {
      requestIdentity: "chronicle-llm-judge-live-calibration-test",
    }),
    loadCalibrationFixture(),
  ]);
  const budget = createOfflineBudget();
  const calls: CapturedJudgeCall[] = [];
  let callIndex = 0;
  const fetchImpl = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    callIndex += 1;
    calls.push({ body: String(init?.body ?? ""), init });
    const scenario = fixture.scenarios[callIndex - 1];
    if (!scenario) throw new Error("unexpected calibration request");
    if (options.failureAt === callIndex && options.failureKind === "transport") {
      return new Response("provider unavailable", { status: 503 });
    }
    if (options.failureAt === callIndex && options.failureKind === "schema") {
      return new Response(
        JSON.stringify({
          model: LIVE_CONFIG.model,
          choices: [{ message: { content: JSON.stringify({ schemaVersion: 1 }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    const input = requestInput(init);
    const variantIndex =
      scenario.scenarioId === "C07" ? options.c07Variant ?? 0 : 0;
    const judgeBody = JSON.parse(fixtureResponse(scenario, input, variantIndex)) as {
      primaryAssignments: Array<{ axes: Record<string, string> }>;
      temporalRelations: Array<{
        actualRef: string | null;
        status: string;
        reason?: string;
      }>;
    };
    if (options.mismatchAt === callIndex) {
      const first = judgeBody.primaryAssignments[0];
      if (!first) throw new Error("missing calibration assignment");
      first.axes.predicate = "mismatch";
      const firstTemporal = judgeBody.temporalRelations[0];
      if (!firstTemporal) throw new Error("missing temporal relation");
      firstTemporal.actualRef = null;
      firstTemporal.status = "undetermined";
      firstTemporal.reason = "event-identity-unavailable";
    }
    return new Response(
      JSON.stringify({
        model: LIVE_CONFIG.model,
        choices: [
          {
            message: { content: JSON.stringify(judgeBody) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  };
  const transport = createOpenRouterTransport({
    apiKey: FAKE_API_KEY,
    budget,
    fetchImpl,
  });
  try {
    const result = await runCalibration({
      runtime: productionRuntime,
      context,
      fixture,
      transport,
      budget,
    });
    return { budget, calls, fixture, result, error: null };
  } catch (error) {
    return { budget, calls, fixture, result: null, error };
  }
}

describe("live calibration driver", () => {
  it("runs all twelve fixed calibration calls and accepts both C07 orientations", async () => {
    const orientationA = await runWithFakeOpenRouter({ c07Variant: 0 });
    const orientationB = await runWithFakeOpenRouter({ c07Variant: 1 });

    for (const run of [orientationA, orientationB]) {
      expect(run.error).toBeNull();
      if (!run.result) throw new Error("expected calibration success");
      expect(run.result.gateOpened).toBe(true);
      expect(run.result.outcomes).toHaveLength(12);
      expect(run.result.outcomes.map((outcome) => outcome.status)).toEqual(
        Array(12).fill("pass"),
      );
      expect(run.calls).toHaveLength(12);
      expect(run.budget.dispatches).toHaveLength(12);
      expect(run.budget.dispatches.every((dispatch) => dispatch.status === "completed")).toBe(true);
      expect(run.budget.northGateOpened).toBe(true);
      expect(run.budget.terminalState).toBeNull();
      expect(run.calls.every((call) => call.init?.method === "POST")).toBe(true);
      expect(
        run.calls.every((call) => call.init?.headers && new Headers(call.init.headers).get("authorization") === `Bearer ${FAKE_API_KEY}`),
      ).toBe(true);
    }
    expect(orientationA.result.outcomes[6]?.status).toBe("pass");
    expect(orientationB.result.outcomes[6]?.status).toBe("pass");
  }, 120_000);

  it("puts only the runtime rubric and opaque calibration data on the judge wire", async () => {
    const run = await runWithFakeOpenRouter({});
    expect(run.error).toBeNull();
    expect(run.calls).toHaveLength(12);

    const expectedRubricVersion =
      productionRuntime.CHRONICLE_LLM_JUDGE_RUBRIC_VERSION;
    const expectedRubric = productionRuntime.CHRONICLE_LLM_JUDGE_RUBRIC;
    expect(expectedRubricVersion).toBe(RUBRIC_VERSION_V2);

    const captured = run.calls.map((call) => ({
      input: capturedJudgeInput(call),
      body: call.body,
    }));
    for (const call of captured) {
      expect(call.input.rubricVersion).toBe(expectedRubricVersion);
      expect(call.input.rubric).toEqual(expectedRubric);
      expect(call.body).not.toContain('"expected"');
      expect(call.body).not.toContain('"scenarioId"');
      expect(call.body).not.toContain('"variantId"');
      expect(call.body).not.toMatch(/\bC(?:0[1-9]|1[0-2])\b/);
    }

    const c01 = run.fixture.scenarios.find(
      (scenario) => scenario.scenarioId === "C01",
    );
    const c11 = run.fixture.scenarios.find(
      (scenario) => scenario.scenarioId === "C11",
    );
    const c12 = run.fixture.scenarios.find(
      (scenario) => scenario.scenarioId === "C12",
    );
    if (!c01 || !c11 || !c12) throw new Error("missing C01, C11, or C12");

    const c11Call = captured[10];
    if (!c11Call) throw new Error("missing C11 captured request");
    expect(c11.response.observations.map((observation) => observation.localId)).toEqual(
      [...c01.response.observations]
        .map((observation) => observation.localId)
        .reverse(),
    );
    expect(c11Call.input.actualClaims.map((claim) => claim.predicate)).toEqual(
      c11.response.observations.map((observation) => observation.payload.predicate),
    );

    const c12Call = captured[11];
    if (!c12Call) throw new Error("missing C12 captured request");
    const instruction = c12.response.observations.find(
      (observation) => observation.payload.semanticType,
    )?.payload.semanticType;
    if (!instruction) throw new Error("missing C12 instruction-like value");
    expect(
      c12Call.input.actualClaims.find(
        (claim) => claim.semanticType === instruction,
      )?.semanticType,
    ).toBe(instruction);
    expect(c12Call.body).toContain(instruction);
    expect(c12Call.input.rubric.actualDataRule).toBe(
      expectedRubric.actualDataRule,
    );
  }, 120_000);

  it("collects a semantic mismatch through all twelve calls and keeps the north gate closed", async () => {
    const run = await runWithFakeOpenRouter({ mismatchAt: 1 });

    expect(run.error).toBeNull();
    if (!run.result) throw new Error("expected calibration completion");
    expect(run.result.gateOpened).toBe(false);
    expect(run.result.outcomes).toHaveLength(12);
    expect(run.result.outcomes[0]?.status).toBe("mismatch");
    expect(run.result.outcomes.slice(1).every((outcome) => outcome.status === "pass")).toBe(true);
    expect(run.calls).toHaveLength(12);
    expect(run.budget.dispatches).toHaveLength(12);
    expect(run.budget.northGateOpened).toBe(false);
    expect(run.budget.terminalState).toBeNull();
  }, 120_000);

  it.each([
    ["schema", "response-invalid"],
    ["transport", "transport-failure"],
  ] as const)(
    "stops on %s failure while preserving prior calibration outcomes",
    async (failureKind, terminalCode) => {
      const run = await runWithFakeOpenRouter({
        failureAt: 3,
        failureKind,
      });
      expect(run.error).toMatchObject({ code: terminalCode, stage: "calibration" });
      expect(run.result).toBeNull();
      expect(run.calls).toHaveLength(3);
      expect(run.budget.dispatches).toHaveLength(3);
      expect(run.budget.calibrationOutcomes).toHaveLength(3);
      expect(run.budget.calibrationOutcomes.slice(0, 2).every((outcome) => outcome.status === "pass")).toBe(true);
      expect(run.budget.calibrationOutcomes[2]).toMatchObject({
        ordinal: 3,
        status: "failed",
        terminalCode: terminalCode === "transport-failure" ? "transport-failure" : "response-invalid",
      });
      expect(run.budget.northGateOpened).toBe(false);
      expect(run.budget.terminalState).toBe("failed");
    },
    120_000,
  );
});
