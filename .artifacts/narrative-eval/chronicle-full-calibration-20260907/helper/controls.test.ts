import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { productionRuntime } from "./production-runtime";
import {
  LIVE_CONFIG,
  buildJudgeMessages,
  buildSanitizedEnvelope,
  createOfflineBudget,
  createOpenRouterTransport,
  loadCalibrationFixture,
  loadSourceOnlyContext,
  persistSanitizedEnvelope,
  runCalibration,
} from "./live-driver.mjs";
import type {
  ChronicleLlmJudgeOfflineResult,
  ChronicleLlmJudgePreparedRun,
} from "@/features/narrative-extraction/eval/chronicleLlmJudgeOffline";

const FAKE_API_KEY = "sk-test-controls_123";
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
type PersistInput = {
  readonly ordinal: number;
  readonly run: ChronicleLlmJudgePreparedRun;
  readonly result: ChronicleLlmJudgeOfflineResult;
};
type FailureKind = "schema" | "transport";

type SavedDiagnostic = Awaited<
  ReturnType<typeof productionRuntime.saveChronicleLlmJudgeOfflineDiagnostic>
>;

function completedData(costUsd: number | null = null) {
  return {
    text: "{}",
    model: LIVE_CONFIG.model,
    effectiveReasoningEffort: LIVE_CONFIG.reasoningEffort,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    costUsd,
    finishReason: "stop",
    stopReason: "end_turn",
  };
}

function requestInput(init: RequestInit | undefined): JudgeInput {
  if (typeof init?.body !== "string") throw new Error("missing request body");
  const request = JSON.parse(init.body) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  const userMessage = request.messages?.find(
    (message) => message.role === "user",
  );
  if (!userMessage?.content) throw new Error("missing judge message");
  const payload = JSON.parse(userMessage.content) as { input?: JudgeInput };
  if (!payload.input) throw new Error("missing judge input");
  return payload.input;
}

function fixtureResponse(scenario: Scenario, input: JudgeInput): string {
  const variant = scenario.expected.variants[0];
  if (!variant) throw new Error("missing fixture variant");
  const actualRefs = new Map(
    scenario.response.observations.map((observation, index) => [
      observation.localId,
      input.actualClaims[index]?.ref,
    ]),
  );
  const goldRefs = new Map(
    GOLD_IDS.map((id, index) => [id, input.goldClaims[index]?.ref]),
  );
  const relationRefs = new Map(
    TEMPORAL_IDS.map((id, index) => [id, input.temporalRelations[index]?.ref]),
  );
  const resolve = (value: string | undefined, label: string) => {
    if (!value) throw new Error(`missing opaque ${label}`);
    return value;
  };
  return JSON.stringify({
    schemaVersion: 1,
    judgeVersion: "chronicle-llm-judge-offline/1",
    primaryAssignments: variant.primaryAssignments.map((assignment) => ({
      actualRef: resolve(
        actualRefs.get(assignment.actualLocalId),
        "actual ref",
      ),
      goldRef: resolve(goldRefs.get(assignment.goldClaimId), "Gold ref"),
      axes: assignment.axes,
    })),
    unmatchedActuals: variant.unmatchedActuals.map((actual) => ({
      actualRef: resolve(
        actualRefs.get(actual.actualLocalId),
        "unmatched actual ref",
      ),
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
          : resolve(
              actualRefs.get(relation.actualLocalId),
              "temporal actual ref",
            ),
      status: relation.status,
      ...(relation.reason ? { reason: relation.reason } : {}),
    })),
  });
}

function assertSavedDiagnostic(saved: SavedDiagnostic): string {
  expect(lstatSync(saved.runDir).isDirectory()).toBe(true);
  expect(lstatSync(saved.runDir).mode & 0o777).toBe(0o700);
  expect(lstatSync(saved.diagnosticPath).isFile()).toBe(true);
  expect(lstatSync(saved.diagnosticPath).mode & 0o777).toBe(0o600);
  const text = readFileSync(saved.diagnosticPath, "utf8");
  expect(JSON.parse(text)).toMatchObject({
    schemaVersion: 1,
    diagnosticOnly: true,
    formalCertification: false,
    accepted: false,
    authorshipReady: false,
  });
  return text;
}

async function runPersistingCalibration(options: {
  readonly failureKind?: FailureKind;
}) {
  const [context, fixture] = await Promise.all([
    loadSourceOnlyContext(productionRuntime, {
      requestIdentity: "chronicle-llm-judge-live-controls-test",
    }),
    loadCalibrationFixture(),
  ]);
  const outputRoot = mkdtempSync(join(tmpdir(), "chronicle-luna-controls-"));
  chmodSync(outputRoot, 0o700);
  const budget = createOfflineBudget();
  const saved: SavedDiagnostic[] = [];
  const snapshots: string[] = [];
  let callIndex = 0;
  const fetchImpl = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    callIndex += 1;
    const scenario = fixture.scenarios[callIndex - 1];
    if (!scenario) throw new Error("unexpected calibration request");
    if (options.failureKind && callIndex === 3) {
      if (options.failureKind === "transport") {
        return new Response("provider unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          model: LIVE_CONFIG.model,
          choices: [
            {
              message: { content: JSON.stringify({ schemaVersion: 1 }) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    const input = requestInput(init);
    return new Response(
      JSON.stringify({
        model: LIVE_CONFIG.model,
        choices: [
          {
            message: { content: fixtureResponse(scenario, input) },
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
  const persistResult = async ({
    ordinal,
    run,
    result,
  }: PersistInput): Promise<SavedDiagnostic> => {
    const value =
      await productionRuntime.saveChronicleLlmJudgeOfflineDiagnostic({
        run,
        result,
        outputRoot,
        createRunId: () => randomUUID(),
      });
    saved.push(value);
    snapshots.push(readFileSync(value.diagnosticPath, "utf8"));
    return value;
  };
  try {
    const result = await runCalibration({
      runtime: productionRuntime,
      context,
      fixture,
      transport,
      budget,
      persistResult,
    });
    return { outputRoot, budget, saved, snapshots, result, error: null };
  } catch (error) {
    return { outputRoot, budget, saved, snapshots, result: null, error };
  }
}

describe("Chronicle Luna helper stage controls", () => {
  it("rejects every new dispatch after a failed attempt", () => {
    const budget = createOfflineBudget();
    const begun = budget.begin("calibration", 1, 128);
    budget.failed(begun.dispatch, "transport-failure", 1, 503);

    expect(budget.terminalState).toBe("failed");
    expect(() => budget.begin("calibration", 2, 128)).toThrowError(
      expect.objectContaining({ code: "budget-failure", stage: "calibration" }),
    );
    expect(() => budget.begin("observation", 1, 128)).toThrowError(
      expect.objectContaining({ code: "budget-failure", stage: "observation" }),
    );
    expect(() => budget.begin("judge", 1, 128)).toThrowError(
      expect.objectContaining({ code: "budget-failure", stage: "judge" }),
    );
  });

  it("rejects every new dispatch after the single judge completes", () => {
    const budget = createOfflineBudget();
    budget.setNorthGateOpened(true);

    const observation = budget.begin("observation", 1, 128);
    budget.complete(observation.dispatch, completedData(), 2, 1, 200);
    const synthesis = budget.begin("synthesis", 1, 128);
    budget.complete(synthesis.dispatch, completedData(), 2, 1, 200);
    const judge = budget.begin("judge", 1, 128);
    budget.complete(judge.dispatch, completedData(), 2, 1, 200);

    expect(budget.terminalState).toBe("judge-completed");
    expect(() => budget.begin("judge", 2, 128)).toThrowError(
      expect.objectContaining({ code: "budget-failure", stage: "judge" }),
    );
    expect(() => budget.begin("synthesis", 2, 128)).toThrowError(
      expect.objectContaining({ code: "budget-failure", stage: "synthesis" }),
    );
  });

  it("keeps unknown provider costs unknown in the aggregate metadata", () => {
    const budget = createOfflineBudget();
    const begun = budget.begin("calibration", 1, 128);
    budget.complete(begun.dispatch, completedData(null), 2, 1, 200);

    expect(budget.budget.knownReportedCostUsd).toBe(0);
    expect(budget.budget.unknownCostCount).toBe(1);
    expect(budget.budget.totalReportedCostUsd).toBe(0);
  });

  it("states the exact six response keys and excludes prompt rules from the response", () => {
    const [system, user] = buildJudgeMessages({
      actualClaims: [],
      goldClaims: [],
    });
    expect(system).toMatchObject({ role: "system" });
    expect(user).toMatchObject({ role: "user" });
    const payload = JSON.parse(user.content);
    expect(payload.outputContract.outputKeys).toEqual([
      "schemaVersion",
      "judgeVersion",
      "primaryAssignments",
      "unmatchedActuals",
      "unmatchedGolds",
      "temporalRelations",
    ]);
    expect(payload.outputContract.rules.output).toContain(
      "never copy them into the response",
    );
  });

  it("persists all twelve validated calibration results through the core storage boundary", async () => {
    const run = await runPersistingCalibration({});
    try {
      expect(run.error).toBeNull();
      if (!run.result) throw new Error("expected calibration result");
      expect(run.result.gateOpened).toBe(true);
      expect(run.result.outcomes).toHaveLength(12);
      expect(run.result.projections).toHaveLength(12);
      expect(run.saved).toHaveLength(12);
      expect(run.result.projections.map((entry) => entry.runId)).toEqual(
        run.saved.map((entry) => entry.runId),
      );
      expect(
        run.result.projections.map((entry) => entry.diagnosticDigest),
      ).toEqual(run.saved.map((entry) => entry.diagnosticDigest));
      expect(readdirSync(run.outputRoot).sort()).toEqual(
        run.saved.map((entry) => entry.runId).sort(),
      );
      for (const saved of run.saved) assertSavedDiagnostic(saved);
    } finally {
      rmSync(run.outputRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    ["schema", "response-invalid"],
    ["transport", "transport-failure"],
  ] as const)(
    "preserves the first two saved diagnostics on %s failure at calibration three",
    async (failureKind, terminalCode) => {
      const run = await runPersistingCalibration({ failureKind });
      try {
        expect(run.error).toMatchObject({
          code: terminalCode,
          stage: "calibration",
        });
        expect(run.result).toBeNull();
        expect(run.budget.calibrationOutcomes).toHaveLength(3);
        expect(run.budget.calibrationProjections).toHaveLength(2);
        expect(run.saved).toHaveLength(2);
        expect(readdirSync(run.outputRoot).sort()).toEqual(
          run.saved.map((entry) => entry.runId).sort(),
        );
        run.saved.forEach((saved, index) => {
          expect(assertSavedDiagnostic(saved)).toBe(run.snapshots[index]);
        });
        expect(run.budget.northGateOpened).toBe(false);
        expect(run.budget.terminalState).toBe("failed");
      } finally {
        rmSync(run.outputRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects publishing the same sanitized envelope twice without replacing the first file", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "chronicle-luna-envelope-"));
    chmodSync(outputRoot, 0o700);
    const runId = randomUUID();
    const envelope = buildSanitizedEnvelope({
      mode: "offline",
      runId,
      helperManifestDigest: `sha256:${"a".repeat(64)}`,
      budget: {
        totalReservedCostUsd: 0,
        knownReportedCostUsd: 0,
        unknownCostCount: 0,
      },
      dispatches: [],
      calibration: {
        passedCount: 0,
        mismatchCount: 0,
        gateOpened: false,
      },
      calibrationOutcomes: [],
      guard: { admittedRequests: 0, blockedRequests: 0 },
      northGate: {
        extractionSynthesisCount: 0,
        judgeCount: 0,
        actualReplayValidated: false,
      },
      projection: null,
      terminal: { status: "complete", code: null, stage: "validation" },
    });
    try {
      const first = await persistSanitizedEnvelope(envelope, outputRoot);
      const original = readFileSync(first.envelopePath, "utf8");
      await expect(
        persistSanitizedEnvelope(envelope, outputRoot),
      ).rejects.toMatchObject({
        code: "binding-failure",
        stage: "persistence",
      });
      expect(readFileSync(first.envelopePath, "utf8")).toBe(original);
      expect(readdirSync(outputRoot)).toEqual([runId]);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
