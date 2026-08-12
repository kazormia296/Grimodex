import type {
  CreateRunPayload,
  CreateRunResult,
  RunRefPayload,
} from "./nativeApi";
import {
  narrativeExtractionCancelRun,
  narrativeExtractionCreateRun,
  narrativeExtractionGetRun,
  narrativeExtractionListResumableRuns,
} from "./nativeApi";
import type {
  NarrativeExtractionRunProjection,
  NarrativeExtractionRunStatus,
} from "@/features/narrative-extraction/runtime/types";

const RESUMABLE_RUN_STATUSES = new Set<NarrativeExtractionRunStatus>([
  "pending",
  "running",
  "completed",
]);

const runIndexByProject = new Map<string, Set<string>>();

function rememberRun(projectId: string, runId: string): void {
  const existing = runIndexByProject.get(projectId) ?? new Set<string>();
  existing.add(runId);
  runIndexByProject.set(projectId, existing);
}

export function resetNarrativeExtractionRunIndexForTests(): void {
  runIndexByProject.clear();
}

export async function createRun(
  payload: CreateRunPayload,
): Promise<CreateRunResult> {
  const created = await narrativeExtractionCreateRun(payload);
  rememberRun(payload.projectId, created.runId);
  return created;
}

export async function getRun(
  runId: string,
  projectId: string,
): Promise<NarrativeExtractionRunProjection> {
  const payload: RunRefPayload = { runId, projectId };
  return narrativeExtractionGetRun(payload);
}

export async function cancelRun(
  runId: string,
  projectId: string,
): Promise<{ runId: string; status: string }> {
  return narrativeExtractionCancelRun({ runId, projectId });
}

export async function listResumableRuns(params: {
  projectId: string;
  surfacePathId?: string;
  limit?: number;
}): Promise<readonly NarrativeExtractionRunProjection[]> {
  try {
    const summaries = await narrativeExtractionListResumableRuns({
      projectId: params.projectId,
      surfacePathId: params.surfacePathId,
      limit: params.limit,
    });
    const projections = await Promise.all(
      summaries.map((summary) => getRun(summary.runId, summary.projectId)),
    );
    return projections.filter((projection) =>
      isResumableRun(projection, params.surfacePathId),
    );
  } catch {
    const indexedRunIds = [
      ...(runIndexByProject.get(params.projectId) ?? []),
    ].slice(0, params.limit ?? 20);
    const projections = await Promise.all(
      indexedRunIds.map((runId) => getRun(runId, params.projectId)),
    );
    return projections.filter((projection) =>
      isResumableRun(projection, params.surfacePathId),
    );
  }
}

function isResumableRun(
  projection: NarrativeExtractionRunProjection,
  surfacePathId?: string,
): boolean {
  if (
    surfacePathId !== undefined &&
    projection.run.surfacePathId !== surfacePathId
  ) {
    return false;
  }
  return RESUMABLE_RUN_STATUSES.has(projection.run.status);
}
