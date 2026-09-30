import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type TaskDiagnosticParseStatus = "parsed" | "invalid";

export type TaskDiagnosticCapture<TDiagnostic> = {
  readonly diagnostic: TDiagnostic;
  readonly expectedParseStatus: TaskDiagnosticParseStatus;
  readonly parseStatus: TaskDiagnosticParseStatus;
};

export type RunTaskWithResponseDiagnosticsOptions<TResult, TDiagnostic> = {
  readonly runTask: () => Promise<TResult>;
  readonly getResponseText: () => string | undefined;
  readonly getParseStatus: () => TaskDiagnosticParseStatus | undefined;
  readonly diagnose: (
    responseText: string,
  ) => TDiagnostic | Promise<TDiagnostic>;
  readonly expectedParseStatus: (
    diagnostic: TDiagnostic,
  ) => TaskDiagnosticParseStatus;
  readonly acceptedCount: (diagnostic: TDiagnostic) => number;
  readonly resultCount: (result: TResult) => number;
  readonly onDiagnostic: (capture: TaskDiagnosticCapture<TDiagnostic>) => void;
};

export type ProductionLiveCaseSummary = {
  readonly caseCount: number;
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly parseFailureCount: number;
  };
};

export type ProductionLiveInvocation = {
  readonly stageId: string;
  readonly invocationIndex: number;
  parseStatus: TaskDiagnosticParseStatus | null;
};

export type ProductionLivePipelineFailure = {
  readonly kind: "terminal-pipeline-failure";
  readonly stageId: string | null;
  readonly invocationIndex: number | null;
  readonly parseStatus: TaskDiagnosticParseStatus | null;
};

export type ProductionLiveDiagnosticParityFailure = {
  readonly kind: "diagnostic-parity-failure";
  readonly dispatchCount: number;
  readonly diagnosticCount: number;
  readonly dispatchKeys: readonly string[];
  readonly diagnosticKeys: readonly string[];
};

export function terminalPipelineFailure(
  invocation?: ProductionLiveInvocation,
): ProductionLivePipelineFailure {
  return {
    kind: "terminal-pipeline-failure",
    stageId: invocation?.stageId ?? null,
    invocationIndex: invocation?.invocationIndex ?? null,
    parseStatus: invocation?.parseStatus ?? null,
  };
}

export async function runTaskWithInvocationTracking<TResult>(
  invocation: ProductionLiveInvocation,
  runTask: () => Promise<TResult>,
  onFailure: (invocation: ProductionLiveInvocation) => void,
): Promise<TResult> {
  try {
    return await runTask();
  } catch (error) {
    onFailure({ ...invocation });
    throw error;
  }
}

export function diagnosticParityFailure(
  dispatchKeys: readonly string[],
  diagnosticKeys: readonly string[],
): ProductionLiveDiagnosticParityFailure | undefined {
  if (
    dispatchKeys.length === diagnosticKeys.length &&
    dispatchKeys.every((key, index) => key === diagnosticKeys[index])
  ) {
    return undefined;
  }
  return {
    kind: "diagnostic-parity-failure",
    dispatchCount: dispatchKeys.length,
    diagnosticCount: diagnosticKeys.length,
    dispatchKeys: [...dispatchKeys],
    diagnosticKeys: [...diagnosticKeys],
  };
}

export function summarizeProductionLiveCases<
  TSuccessfulCase extends { readonly evaluation: { readonly passed: boolean } },
>(
  successfulCases: readonly TSuccessfulCase[],
  failedCases: readonly unknown[],
  parseFailureCount: number,
  expectedCaseCount?: number,
): ProductionLiveCaseSummary {
  const summary = {
    passed: successfulCases.filter((entry) => entry.evaluation.passed).length,
    failed:
      successfulCases.filter((entry) => !entry.evaluation.passed).length +
      failedCases.length,
    parseFailureCount,
  };
  const result = {
    caseCount: successfulCases.length + failedCases.length,
    summary,
  };
  if (
    expectedCaseCount !== undefined &&
    result.caseCount !== expectedCaseCount
  ) {
    throw new Error(
      `Chronicle production case accounting mismatch: expected ${expectedCaseCount}, got ${result.caseCount}`,
    );
  }
  return result;
}

export async function writeProductionLiveArtifacts({
  artifactRoot,
  reportJson,
  diagnosticsReport,
}: {
  readonly artifactRoot: string;
  readonly reportJson: string;
  readonly diagnosticsReport: Record<string, unknown>;
}): Promise<void> {
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, "report.json"), reportJson, "utf8");
  await writeFile(
    path.join(artifactRoot, "diagnostics.json"),
    `${JSON.stringify(diagnosticsReport, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Keep the canonical task's rejection semantics while diagnosing a response
 * that was received before parsing/materialization rejected it.
 */
export async function runTaskWithResponseDiagnostics<TResult, TDiagnostic>({
  runTask,
  getResponseText,
  getParseStatus,
  diagnose,
  expectedParseStatus,
  acceptedCount,
  resultCount,
  onDiagnostic,
}: RunTaskWithResponseDiagnosticsOptions<
  TResult,
  TDiagnostic
>): Promise<TResult> {
  let taskSucceeded = false;
  let taskResult!: TResult;
  let taskError: unknown;
  try {
    taskResult = await runTask();
    taskSucceeded = true;
  } catch (error) {
    taskError = error;
  }

  let diagnosticError: unknown;
  const responseText = getResponseText();
  if (responseText !== undefined) {
    try {
      const diagnostic = await diagnose(responseText);
      const expected = expectedParseStatus(diagnostic);
      const actual = getParseStatus() ?? "invalid";
      if (actual !== expected) {
        throw new Error(
          "Task diagnostic parseStatus disagreed with the canonical task callback",
        );
      }
      if (
        taskSucceeded &&
        acceptedCount(diagnostic) !== resultCount(taskResult)
      ) {
        throw new Error(
          "Task diagnostic output count disagreed with the canonical task result",
        );
      }
      onDiagnostic({
        diagnostic,
        expectedParseStatus: expected,
        parseStatus: actual,
      });
    } catch (error) {
      diagnosticError = error;
    }
  }

  if (!taskSucceeded) {
    throw taskError;
  }
  if (diagnosticError !== undefined) {
    throw diagnosticError;
  }
  return taskResult;
}
