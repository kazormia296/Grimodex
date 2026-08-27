import type {
  ChronicleBlockedDiscardExpectation,
  ChronicleTaskResumeCandidate,
  CreateRunPayload,
  CreateRunResult,
  NarrativeExtractionWorkspaceBinding,
  RunRefPayload,
} from "./nativeApi";
import {
  narrativeExtractionCancelRun,
  narrativeExtractionCreateRun,
  narrativeExtractionGetRun,
  narrativeExtractionListChronicleTaskResumeCandidates,
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

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RFC3339_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const CHRONICLE_TASK_RESUME_DAG = [
  "source.snapshot@1",
  "source.window-plan@1",
  "chronicle.observe-events@1",
  "evidence.resolve@1",
  "chronicle.merge-local-observations@1",
  "chronicle.cluster-event-observations@1",
  "chronicle.synthesize-event@1",
  "chronicle.match-existing-events@1",
  "chronicle.plan-proposals@1",
] as const;
const CHRONICLE_TASK_RESUME_CANDIDATE_FIELDS = [
  "runId",
  "projectId",
  "status",
  "scopeJson",
  "specJson",
  "runSpecDigest",
  "snapshotDigest",
  "catalogDigest",
  "executionMode",
  "coordinatorContractDigest",
  "completedTaskKinds",
  "nextTask",
  "availability",
  "blockedCode",
  "language",
  "existingEventsCatalog",
  "createdAt",
  "startedAt",
] as const;

function invalidResumeCandidate(detail: string): never {
  throw new Error(`NEX_CHRONICLE_TASK_RESUME_CANDIDATE_INVALID: ${detail}`);
}

function requireResumeRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidResumeCandidate(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireExactResumeFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    invalidResumeCandidate(`${label} has an unsupported shape`);
  }
}

function requireResumeString(
  value: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.trim() !== candidate
  ) {
    invalidResumeCandidate(
      `${label}.${field} must be a non-empty exact string`,
    );
  }
  return candidate;
}

function requireResumeDigest(
  value: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string {
  const digest = requireResumeString(value, field, label);
  if (!SHA256_DIGEST_PATTERN.test(digest)) {
    invalidResumeCandidate(
      `${label}.${field} must be a lowercase sha256 digest`,
    );
  }
  return digest;
}

function requireResumeInstant(
  value: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string {
  const instant = requireResumeString(value, field, label);
  const match = RFC3339_INSTANT_PATTERN.exec(instant);
  if (match === null || !Number.isFinite(Date.parse(instant))) {
    invalidResumeCandidate(`${label}.${field} must be an RFC3339 instant`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    invalidResumeCandidate(`${label}.${field} must be an RFC3339 instant`);
  }
  return instant;
}

function requireResumeStringArray(
  value: unknown,
  label: string,
): readonly string[] {
  const result = requireResumeStringList(value, label);
  if (new Set(result).size !== result.length) {
    invalidResumeCandidate(`${label} must contain unique strings`);
  }
  return result;
}

function requireResumeStringList(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    invalidResumeCandidate(`${label} must be an array`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.trim() !== item) {
      invalidResumeCandidate(`${label} must contain non-empty exact strings`);
    }
    result.push(item);
  }
  return result;
}

function cloneResumeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseExistingEventCatalogRecord(
  value: unknown,
  label: string,
): NonNullable<
  ChronicleTaskResumeCandidate["existingEventsCatalog"]
>["events"][number] {
  const record = requireResumeRecord(value, label);
  const requiredFields = [
    "ref",
    "sourceKey",
    "title",
    "note",
    "version",
    "linkedDocumentSourceKeys",
    "participantEntityRefs",
    "startTime",
    "endTime",
    "digest",
  ] as const;
  const allowedFields = new Set<string>([
    ...requiredFields,
    "applicationProvenanceKeys",
  ]);
  if (
    requiredFields.some((field) => !Object.hasOwn(record, field)) ||
    Object.keys(record).some((field) => !allowedFields.has(field))
  ) {
    invalidResumeCandidate(`${label} has an unsupported shape`);
  }
  const ref = requireResumeString(record, "ref", label);
  const sourceKey = requireResumeString(record, "sourceKey", label);
  const title = requireResumeString(record, "title", label);
  const note = record.note;
  if (note !== null && typeof note !== "string") {
    invalidResumeCandidate(`${label}.note must be a string or null`);
  }
  const version = record.version;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    invalidResumeCandidate(
      `${label}.version must be a non-negative safe integer`,
    );
  }
  const linkedDocumentSourceKeys = requireResumeStringList(
    record.linkedDocumentSourceKeys,
    `${label}.linkedDocumentSourceKeys`,
  );
  const participantEntityRefs = requireResumeStringList(
    record.participantEntityRefs,
    `${label}.participantEntityRefs`,
  );
  const startTime = record.startTime;
  const endTime = record.endTime;
  for (const [field, temporal] of [
    ["startTime", startTime],
    ["endTime", endTime],
  ] as const) {
    if (
      temporal !== null &&
      (typeof temporal !== "number" || !Number.isFinite(temporal))
    ) {
      invalidResumeCandidate(
        `${label}.${field} must be a finite number or null`,
      );
    }
  }
  const eventDigest = requireResumeString(record, "digest", label);
  const applicationProvenanceKeys = Object.hasOwn(
    record,
    "applicationProvenanceKeys",
  )
    ? requireResumeStringList(
        record.applicationProvenanceKeys,
        `${label}.applicationProvenanceKeys`,
      )
    : undefined;
  return {
    ref,
    sourceKey,
    title,
    note,
    version: version as number,
    linkedDocumentSourceKeys: [...linkedDocumentSourceKeys],
    participantEntityRefs: [...participantEntityRefs],
    startTime: startTime as number | null,
    endTime: endTime as number | null,
    digest: eventDigest,
    ...(applicationProvenanceKeys === undefined
      ? {}
      : { applicationProvenanceKeys: [...applicationProvenanceKeys] }),
  };
}

function parseChronicleTaskResumeCandidate(
  value: unknown,
  expectedProjectId: string,
  index: number,
): ChronicleTaskResumeCandidate {
  const label = `candidate[${index}]`;
  const candidate = requireResumeRecord(value, label);
  requireExactResumeFields(
    candidate,
    CHRONICLE_TASK_RESUME_CANDIDATE_FIELDS,
    label,
  );

  const runId = requireResumeString(candidate, "runId", label);
  const projectId = requireResumeString(candidate, "projectId", label);
  if (projectId !== expectedProjectId) {
    invalidResumeCandidate(
      `${label}.projectId differs from the requested project`,
    );
  }
  const status = candidate.status;
  if (status !== "pending" && status !== "running") {
    invalidResumeCandidate(`${label}.status is not resumable`);
  }

  const scope = requireResumeRecord(candidate.scopeJson, `${label}.scopeJson`);
  requireExactResumeFields(
    scope,
    ["folderId", "sceneIds"],
    `${label}.scopeJson`,
  );
  const folderId = requireResumeString(scope, "folderId", `${label}.scopeJson`);
  const sceneIds = requireResumeStringArray(
    scope.sceneIds,
    `${label}.scopeJson.sceneIds`,
  );

  const spec = requireResumeRecord(candidate.specJson, `${label}.specJson`);
  requireExactResumeFields(
    spec,
    [
      "kind",
      "domain",
      "version",
      "taskChain",
      "executionMode",
      "existingEventsCatalogDigest",
      "coordinatorContractDigest",
    ],
    `${label}.specJson`,
  );
  if (
    spec.kind !== "chronicle.extract.run-spec@2" ||
    spec.domain !== "chronicle" ||
    spec.version !== 2
  ) {
    invalidResumeCandidate(
      `${label}.specJson is not the current Chronicle spec`,
    );
  }
  const executionMode = candidate.executionMode;
  if (executionMode !== "ai" && executionMode !== "deterministic-fallback") {
    invalidResumeCandidate(`${label}.executionMode is unsupported`);
  }
  if (spec.executionMode !== executionMode) {
    invalidResumeCandidate(`${label}.executionMode differs from specJson`);
  }
  const taskChain = requireResumeStringArray(
    spec.taskChain,
    `${label}.specJson.taskChain`,
  );
  if (
    taskChain.length !== CHRONICLE_TASK_RESUME_DAG.length ||
    taskChain.some(
      (taskKind, taskIndex) =>
        taskKind !== CHRONICLE_TASK_RESUME_DAG[taskIndex],
    )
  ) {
    invalidResumeCandidate(
      `${label}.specJson.taskChain is not the exact Chronicle DAG`,
    );
  }

  const runSpecDigest = requireResumeDigest(candidate, "runSpecDigest", label);
  const snapshotDigest = requireResumeDigest(
    candidate,
    "snapshotDigest",
    label,
  );
  const catalogDigest = requireResumeDigest(candidate, "catalogDigest", label);
  const coordinatorContractDigest = requireResumeDigest(
    candidate,
    "coordinatorContractDigest",
    label,
  );
  if (
    spec.existingEventsCatalogDigest !== catalogDigest ||
    spec.coordinatorContractDigest !== coordinatorContractDigest
  ) {
    invalidResumeCandidate(`${label}.specJson digest coordinates do not match`);
  }

  const completedTaskKinds = requireResumeStringArray(
    candidate.completedTaskKinds,
    `${label}.completedTaskKinds`,
  );
  if (
    completedTaskKinds.length >= taskChain.length ||
    completedTaskKinds.some((kind, taskIndex) => kind !== taskChain[taskIndex])
  ) {
    invalidResumeCandidate(
      `${label}.completedTaskKinds is not a strict DAG prefix`,
    );
  }

  const nextTask = requireResumeRecord(candidate.nextTask, `${label}.nextTask`);
  requireExactResumeFields(
    nextTask,
    ["taskId", "taskKind", "status", "leaseExpiresAt"],
    `${label}.nextTask`,
  );
  const taskId = requireResumeString(nextTask, "taskId", `${label}.nextTask`);
  const taskKind = requireResumeString(
    nextTask,
    "taskKind",
    `${label}.nextTask`,
  );
  if (taskKind !== taskChain[completedTaskKinds.length]) {
    invalidResumeCandidate(
      `${label}.nextTask is not the first incomplete Task`,
    );
  }
  const nextTaskStatus = nextTask.status;
  if (nextTaskStatus !== "queued" && nextTaskStatus !== "running") {
    invalidResumeCandidate(`${label}.nextTask.status is unsupported`);
  }
  const leaseExpiresAt =
    nextTask.leaseExpiresAt === null
      ? null
      : requireResumeInstant(nextTask, "leaseExpiresAt", `${label}.nextTask`);
  if (nextTaskStatus === "queued" && leaseExpiresAt !== null) {
    invalidResumeCandidate(`${label}.queued nextTask cannot hold a lease`);
  }

  const availability = candidate.availability;
  if (
    availability !== "ready" &&
    availability !== "lease-held" &&
    availability !== "blocked"
  ) {
    invalidResumeCandidate(`${label}.availability is unsupported`);
  }
  const rawBlockedCode = candidate.blockedCode;
  let blockedCode: string | null;
  if (availability === "blocked") {
    if (
      typeof rawBlockedCode !== "string" ||
      rawBlockedCode.length === 0 ||
      rawBlockedCode.trim() !== rawBlockedCode ||
      !/^NEX_[A-Z0-9_]+$/u.test(rawBlockedCode)
    ) {
      invalidResumeCandidate(
        `${label}.blockedCode disagrees with availability`,
      );
    }
    blockedCode = rawBlockedCode;
  } else {
    if (rawBlockedCode !== null) {
      invalidResumeCandidate(
        `${label}.blockedCode disagrees with availability`,
      );
    }
    blockedCode = null;
  }
  if (
    availability === "lease-held" &&
    (status !== "running" ||
      nextTaskStatus !== "running" ||
      leaseExpiresAt === null)
  ) {
    invalidResumeCandidate(`${label}.lease-held candidate has no active lease`);
  }
  if (status === "pending" && nextTaskStatus === "running") {
    invalidResumeCandidate(`${label}.pending Run cannot own a running Task`);
  }
  if (nextTaskStatus === "running" && leaseExpiresAt === null) {
    invalidResumeCandidate(`${label}.running nextTask has no lease instant`);
  }

  const rawLanguage = candidate.language;
  let language: string | null;
  if (rawLanguage === null) {
    language = null;
  } else {
    if (
      typeof rawLanguage !== "string" ||
      rawLanguage.length === 0 ||
      rawLanguage.trim() !== rawLanguage
    ) {
      invalidResumeCandidate(`${label}.language is invalid`);
    }
    language = rawLanguage;
  }
  const rawCatalog = candidate.existingEventsCatalog;
  let existingEventsCatalog: ChronicleTaskResumeCandidate["existingEventsCatalog"] =
    null;
  if (rawCatalog !== null) {
    const catalog = requireResumeRecord(
      rawCatalog,
      `${label}.existingEventsCatalog`,
    );
    requireExactResumeFields(
      catalog,
      ["kind", "events"],
      `${label}.existingEventsCatalog`,
    );
    if (
      catalog.kind !== "chronicle.existing-events-catalog@1" ||
      !Array.isArray(catalog.events)
    ) {
      invalidResumeCandidate(`${label}.existingEventsCatalog is unsupported`);
    }
    existingEventsCatalog = {
      kind: "chronicle.existing-events-catalog@1",
      events: catalog.events.map((event, eventIndex) =>
        parseExistingEventCatalogRecord(
          event,
          `${label}.existingEventsCatalog.events[${eventIndex}]`,
        ),
      ),
    };
  }
  if (
    availability !== "blocked" &&
    (language === null || existingEventsCatalog === null)
  ) {
    invalidResumeCandidate(
      `${label} lacks the durable inputs required to resume`,
    );
  }

  const createdAt = requireResumeInstant(candidate, "createdAt", label);
  const startedAt =
    candidate.startedAt === null
      ? null
      : requireResumeInstant(candidate, "startedAt", label);
  if (
    (status === "pending" &&
      (startedAt !== null || completedTaskKinds.length !== 0)) ||
    (status === "running" && startedAt === null)
  ) {
    invalidResumeCandidate(`${label}.status disagrees with its lifecycle`);
  }
  if (startedAt !== null && Date.parse(startedAt) < Date.parse(createdAt)) {
    invalidResumeCandidate(`${label}.startedAt precedes createdAt`);
  }

  return {
    runId,
    projectId,
    status,
    scopeJson: { folderId, sceneIds: [...sceneIds] },
    specJson: cloneResumeJson(spec),
    runSpecDigest,
    snapshotDigest,
    catalogDigest,
    executionMode,
    coordinatorContractDigest,
    completedTaskKinds: [...completedTaskKinds],
    nextTask: {
      taskId,
      taskKind,
      status: nextTaskStatus,
      leaseExpiresAt,
    },
    availability,
    blockedCode,
    language,
    existingEventsCatalog,
    createdAt,
    startedAt,
  };
}

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
  workspaceBinding: NarrativeExtractionWorkspaceBinding,
): Promise<CreateRunResult> {
  const created = await narrativeExtractionCreateRun(payload, workspaceBinding);
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
  workspaceBinding: NarrativeExtractionWorkspaceBinding,
  chronicleBlockedDiscard?: ChronicleBlockedDiscardExpectation,
): Promise<{ runId: string; status: string }> {
  const payload: RunRefPayload = {
    runId,
    projectId,
    ...(chronicleBlockedDiscard === undefined
      ? {}
      : { chronicleBlockedDiscard }),
  };
  return narrativeExtractionCancelRun(payload, workspaceBinding);
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

export async function listChronicleTaskResumeCandidates(params: {
  readonly projectId: string;
  readonly limit?: number;
}): Promise<readonly ChronicleTaskResumeCandidate[]> {
  if (
    params.projectId.length === 0 ||
    params.projectId.trim() !== params.projectId
  ) {
    throw new Error(
      "NEX_CHRONICLE_TASK_RESUME_QUERY_INVALID: projectId must be a non-empty exact string",
    );
  }
  if (
    params.limit !== undefined &&
    (!Number.isSafeInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > 100)
  ) {
    throw new Error(
      "NEX_CHRONICLE_TASK_RESUME_QUERY_INVALID: limit must be an integer from 1 through 100",
    );
  }

  // Unlike Review restore, task-resume discovery must never use the
  // process-local Run index.  It is empty after the exact cold start this
  // query exists to recover, so swallowing a Native failure would turn an
  // unknown durable state into "no candidate" and permit a duplicate Run.
  const raw: unknown =
    await narrativeExtractionListChronicleTaskResumeCandidates({
      projectId: params.projectId,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
  if (!Array.isArray(raw)) {
    invalidResumeCandidate("Native response must be an array");
  }
  return raw.map((candidate, index) =>
    parseChronicleTaskResumeCandidate(candidate, params.projectId, index),
  );
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
