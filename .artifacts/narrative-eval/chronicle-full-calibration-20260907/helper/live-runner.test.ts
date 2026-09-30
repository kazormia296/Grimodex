import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { productionRuntime } from "./production-runtime";
import { readRuntimeKeyFromStdin } from "./key-reader.mjs";
import {
  LIVE_CONFIG,
  LiveJudgeFailure,
  assertLiveAuthorization,
  buildSanitizedEnvelope,
  createOfflineBudget,
  createOpenRouterTransport,
  loadCalibrationFixture,
  loadHelperManifest,
  loadSourceOnlyContext,
  persistSanitizedEnvelope,
  runCalibration,
  runNorthGate,
  verifyImmutableBinding,
} from "./live-driver.mjs";
import { installOpenRouterFetchGuard } from "./openrouter-fetch-guard.mjs";

function failureDetails(error: unknown) {
  if (error instanceof LiveJudgeFailure) {
    return { code: error.code, stage: error.stage };
  }
  if (
    error &&
    typeof error === "object" &&
    [
      "JUDGE_RESPONSE_INVALID",
      "JUDGE_SCHEMA_INVALID",
      "JUDGE_REFERENCE_INVALID",
    ].includes((error as { code?: unknown }).code as string)
  ) {
    return { code: "response-invalid" as const, stage: "judge" as const };
  }
  return { code: "runtime-failure" as const, stage: "validation" as const };
}

async function ensureOutputRoot(outputRoot: string) {
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await chmod(outputRoot, 0o700);
}

describe("Chronicle Luna max live runner", () => {
  it("runs the approved calibration gate and one fresh production replay", async () => {
    const runId = process.env.CHRONICLE_RUN_ID;
    const scratchRoot = process.env.CHRONICLE_LIVE_SCRATCH;
    if (!runId || !scratchRoot) throw new Error("live runner environment missing");

    const loaded = await loadHelperManifest();
    await verifyImmutableBinding(loaded.manifest);
    assertLiveAuthorization(loaded.manifest);
    const context = await loadSourceOnlyContext(productionRuntime, {
      requestIdentity: `chronicle-llm-judge-live:${runId}`,
    });
    const fixture = await loadCalibrationFixture();
    const budget = createOfflineBudget();
    const outputRoot = path.join(LIVE_CONFIG.receiptRoot, "runs");
    const calibrationOutputRoot = path.join(outputRoot, "calibration");
    await ensureOutputRoot(outputRoot);
    await ensureOutputRoot(calibrationOutputRoot);
    const progressPath = path.join(scratchRoot, "fetch-progress.json");
    const key = readRuntimeKeyFromStdin();
    const guard = installOpenRouterFetchGuard({ progressPath });
    const transport = createOpenRouterTransport({
      apiKey: key,
      budget,
    });

    let calibration = { outcomes: [], gateOpened: false } as {
      outcomes: readonly Record<string, unknown>[];
      gateOpened: boolean;
    };
    let northGate: Awaited<ReturnType<typeof runNorthGate>> | null = null;
    let projectionRef: Record<string, unknown> | null = null;
    let terminal: {
      status: "complete" | "failed";
      code: string | null;
      stage: string | null;
    } = { status: "failed", code: "runtime-failure", stage: "preflight" };
    let guardSnapshot = { admittedRequests: 0, blockedRequests: 0 };

    try {
      calibration = await runCalibration({
        runtime: productionRuntime,
        context,
        fixture,
        transport,
        budget,
        persistResult: async ({ run, result }) =>
          productionRuntime.saveChronicleLlmJudgeOfflineDiagnostic({
            run,
            result,
            outputRoot: calibrationOutputRoot,
          }),
      });
      if (!calibration.gateOpened) {
        throw new LiveJudgeFailure("calibration-mismatch", "calibration");
      }
      northGate = await runNorthGate({
        runtime: productionRuntime,
        context,
        transport,
        budget,
      });
      await ensureOutputRoot(outputRoot);
      const saved = await productionRuntime.saveChronicleLlmJudgeOfflineDiagnostic({
        run: northGate.replayRun,
        result: northGate.result,
        outputRoot,
        createRunId: () => runId,
      });
      if (saved.runId !== runId) {
        throw new LiveJudgeFailure("validation-failure", "persistence");
      }
      projectionRef = {
        runId: saved.runId,
        diagnosticDigest: saved.diagnosticDigest,
        byteLength: saved.byteLength,
      };
      terminal = { status: "complete", code: null, stage: null };
    } catch (error) {
      budget.abort();
      const details = failureDetails(error);
      terminal = { status: "failed", ...details };
    } finally {
      guardSnapshot = {
        admittedRequests: guard.state.admittedRequests,
        blockedRequests: guard.state.blockedRequests,
      };
      guard.restore();
    }

    const outcomes = budget.calibrationOutcomes;
    const envelope = buildSanitizedEnvelope({
      mode: "live",
      runId,
      helperManifestDigest: loaded.digest,
      budget: budget.budget,
      dispatches: budget.dispatches,
      calibration: {
        passedCount: outcomes.filter((entry) => entry.status === "pass").length,
        mismatchCount: outcomes.filter((entry) => entry.status === "mismatch").length,
        gateOpened: calibration.gateOpened,
      },
      calibrationOutcomes: outcomes,
      calibrationProjections: budget.calibrationProjections,
      guard: guardSnapshot,
      northGate: {
        extractionSynthesisCount: budget.budget.extractionSynthesisCount,
        judgeCount: budget.budget.judgeCount,
        actualReplayValidated: northGate !== null,
      },
      projection: northGate?.result.projection ?? null,
      projectionRef,
      terminal,
    });
    const persisted = await persistSanitizedEnvelope(envelope, outputRoot);
    process.stdout.write(
      `${JSON.stringify({
        status: terminal.status,
        terminalCode: terminal.code,
        runId,
        dispatchCount: budget.dispatches.length,
        projectionPath: northGate ? persisted.diagnosticPath : null,
        envelopePath: persisted.envelopePath,
      })}\n`,
    );

    expect(envelope.runId).toBe(runId);
    expect(envelope.dispatchCount).toBeLessThanOrEqual(LIVE_CONFIG.maxRequests);
    expect(persisted.envelopePath).toContain(`${runId}/diagnostic-envelope.json`);
  }, LIVE_CONFIG.maxRunRuntimeMs + 30_000);
});
