import {
  buildChunks,
  buildEditorSeed,
  buildScanBundle,
  buildPhases,
  mergeEntities,
  mergeEvents,
  mergeRelations,
  normalizeDocument,
  type NormalizedDocument,
  type SourceDocumentInput,
} from "@grimodex/scan-core";
import {
  CHUNK_EXTRACTION_SCHEMA_VERSION,
  SCAN_SCHEMA_VERSION,
  sha256Hex,
  type ChunkExtractionV1,
  type EvidenceRef,
  type ScanBundleV1,
  type ScanEntity,
  type ScanEvent,
  type ScanFinding,
  type ScanLanguage,
  type ScanPhase,
  type ScanRelation,
} from "@grimodex/scan-contract";
import {
  PROMPT_VERSIONS,
  ScanProviderError,
  type ChunkExtractionInput,
} from "@grimodex/scan-prompts";
import { DEFAULT_SCAN_AI_MODEL, type ScanEnv } from "./env";
import {
  createWorkersAiProvider,
  type ProviderCallHooks,
} from "./ai/workersAiProvider";
import {
  createGatewayAiProvider,
  type GatewayProviderName,
} from "./ai/gatewayAiProvider";
import type { ScanRepository } from "./repository";
import { assertCurrentAiDataConsentIdentity } from "./ai/aiDataDisclosure";

export const PIPELINE_VERSION = "scan-pipeline/2026-07-16.1";
const JSON_CONTENT_TYPE = "application/json";
const MAX_SOURCE_TEXT_BYTES = 16 * 1024 * 1024;
const QUICK_CHUNK_CHARACTERS = 6_000;
const FULL_CHUNK_CHARACTERS = 4_000;
// The extraction Workflow step performs up to roughly 15 D1/R2/provider
// operations per chunk (including one schema-repair request). Forty-eight
// leaves substantial headroom below the paid Workers per-invocation external
// operation budget for step setup, recovery reads and the final artifact.
export const MAX_SCAN_CHUNKS = 48;

export class ScanDeletedError extends Error {
  constructor() {
    super("scan was deleted while processing");
    this.name = "ScanDeletedError";
  }
}

export interface StoredExtraction {
  chunkId: string;
  extraction: ChunkExtractionV1;
  provider:
    | "workers-ai"
    | "ai-gateway"
    | "openrouter"
    | "deterministic"
    | "deterministic-fallback";
  model: string;
}

export interface StoredExtractions {
  sourceFingerprint: string;
  chunks: StoredExtraction[];
}

export interface MergeOutput {
  sourceFingerprint: string;
  entities: ReturnType<typeof mergeEntities>["entities"];
  relations: ReturnType<typeof mergeRelations>["relations"];
  events: ReturnType<typeof mergeEvents>["events"];
  phases: ReturnType<typeof buildPhases>["phases"];
  unresolvedRelations: ReturnType<typeof mergeRelations>["unresolved"];
  unresolvedEvents: ReturnType<typeof mergeEvents>["unresolved"];
  unresolvedPhases: ReturnType<typeof buildPhases>["unresolved"];
  ambiguities: ReturnType<typeof mergeEntities>["ambiguities"];
  ambiguityEntityIds: Record<string, string[]>;
  ambiguityInputs: Array<{
    ambiguityId: string;
    candidateSummary: string;
    evidenceParagraphs: Array<{ paragraphId: string; text: string }>;
  }>;
}

export interface AdjudicationOutput {
  ambiguityId: string;
  entityIds: string[];
  decision: "merge" | "keep-separate" | "uncertain";
  rationale: string;
  provider:
    | "workers-ai"
    | "ai-gateway"
    | "openrouter"
    | "deterministic-fallback";
  model: string;
}

const ADJUDICATION_RESULT_SCHEMA_VERSION =
  "grimodex-scan/adjudication-result/1";

function adjudicationResultKey(scanId: string, ambiguityId: string): string {
  return `artifacts/${scanId}/adjudication-results/${sha256Hex(ambiguityId)}.json`;
}

function isAdjudicationOutput(
  value: unknown,
  expectedAmbiguityId: string,
): value is AdjudicationOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.ambiguityId === expectedAmbiguityId &&
    Array.isArray(record.entityIds) &&
    record.entityIds.every((id) => typeof id === "string") &&
    (record.decision === "merge" ||
      record.decision === "keep-separate" ||
      record.decision === "uncertain") &&
    typeof record.rationale === "string" &&
    (record.provider === "workers-ai" ||
      record.provider === "ai-gateway" ||
      record.provider === "openrouter" ||
      record.provider === "deterministic-fallback") &&
    typeof record.model === "string"
  );
}

export interface AdjudicatedScanParts {
  entities: ScanEntity[];
  relations: ScanRelation[];
  phases: ScanPhase[];
  events: ScanEvent[];
}

function normalizeLookupName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function dedupeEvidence(evidence: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = [
      item.sectionId,
      item.paragraphId,
      item.sentenceIndex ?? "",
      item.excerpt ?? "",
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueResolvedIds(
  ids: readonly string[],
  resolve: (id: string) => string,
): string[] {
  return [...new Set(ids.map(resolve))];
}

/** Applies explicit Full-scan merge decisions to all downstream references. */
export function applyAdjudicationDecisions(
  parts: AdjudicatedScanParts,
  decisions: readonly AdjudicationOutput[],
): AdjudicatedScanParts {
  const availableIds = new Set(parts.entities.map((entity) => entity.id));
  const parentById = new Map<string, string>();
  const resolve = (id: string): string => {
    let current = id;
    const visited = new Set<string>();
    while (parentById.has(current) && !visited.has(current)) {
      visited.add(current);
      current = parentById.get(current)!;
    }
    return current;
  };

  for (const decision of decisions) {
    if (decision.decision !== "merge") continue;
    const candidates = uniqueResolvedIds(decision.entityIds, resolve)
      .filter((id) => availableIds.has(id))
      .sort();
    const target = candidates[0];
    if (!target || candidates.length < 2) continue;
    for (const candidate of candidates.slice(1))
      parentById.set(candidate, target);
  }

  const grouped = new Map<string, ScanEntity[]>();
  for (const entity of parts.entities) {
    const target = resolve(entity.id);
    const group = grouped.get(target) ?? [];
    group.push(entity);
    grouped.set(target, group);
  }
  const entities = [...grouped.entries()].map(([target, group]) => {
    const primary = group.find((entity) => entity.id === target) ?? group[0]!;
    const canonicalName = primary.name;
    const aliases = [
      ...new Set(group.flatMap((entity) => [entity.name, ...entity.aliases])),
    ]
      .filter(
        (name) =>
          normalizeLookupName(name) !== normalizeLookupName(canonicalName),
      )
      .sort((left, right) => left.localeCompare(right, "ja"));
    const parentId = primary.parentId ? resolve(primary.parentId) : undefined;
    return {
      ...primary,
      id: target,
      aliases,
      summary: group.find((entity) => entity.summary)?.summary,
      parentId: parentId && parentId !== target ? parentId : undefined,
      evidence: dedupeEvidence(group.flatMap((entity) => entity.evidence)),
      confidence: Math.max(...group.map((entity) => entity.confidence)),
    };
  });

  const relations = parts.relations
    .map((relation) => ({
      ...relation,
      fromEntityId: resolve(relation.fromEntityId),
      toEntityId: resolve(relation.toEntityId),
    }))
    .filter(
      (relation) =>
        relation.fromEntityId !== relation.toEntityId ||
        relation.type === "self",
    );
  const phases = parts.phases.map((phase) => ({
    ...phase,
    entityIds: uniqueResolvedIds(phase.entityIds, resolve),
  }));
  const events = parts.events.map((event) => ({
    ...event,
    entityIds: uniqueResolvedIds(event.entityIds, resolve),
  }));
  return { entities, relations, phases, events };
}

export interface PipelineArtifacts {
  bundle: ScanBundleV1;
  editorSeed: ReturnType<typeof buildEditorSeed>;
  bundleKey: string;
  reportKey: string;
}

function sourceTitle(filename: string): string {
  const withoutExtension = filename
    .replace(/\.(?:txt|md|markdown)$/i, "")
    .trim();
  return withoutExtension || "Untitled";
}

function detectLanguage(text: string): ScanLanguage {
  const japanese = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (japanese > 0 && japanese >= latin) return "ja";
  if (latin > 0) return "en";
  return "other";
}

function excerpt(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 1)}…`;
}

function evidenceFor(
  paragraph: NormalizedDocument["paragraphs"][number],
): EvidenceRef {
  return {
    sectionId: paragraph.sectionId,
    paragraphId: paragraph.id,
    excerpt: excerpt(paragraph.text),
  };
}

function candidateNames(text: string): string[] {
  const stopWords = new Set([
    "そして",
    "しかし",
    "それから",
    "これ",
    "それ",
    "あれ",
    "ため",
    "よう",
    "こと",
    "もの",
    "ところ",
    "the",
    "and",
    "with",
    "that",
    "this",
    "from",
    "into",
    "when",
    "where",
    "what",
    "which",
  ]);
  const counts = new Map<string, number>();
  const add = (value: string) => {
    const name = value
      .normalize("NFKC")
      .replace(/^[「『（(【\[]+|[」』）)】\],。.!?！？]+$/g, "")
      .trim();
    if (
      name.length < 2 ||
      name.length > 32 ||
      stopWords.has(name.toLocaleLowerCase())
    )
      return;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const match of text.matchAll(
    /[\p{Script=Han}\p{Script=Katakana}ー]{2,16}/gu,
  )) {
    if (match[0]) add(match[0]);
  }
  for (const match of text.matchAll(
    /\b[A-Z][A-Za-z]{2,24}(?:\s+[A-Z][A-Za-z]{2,24})?\b/g,
  )) {
    if (match[0]) add(match[0]);
  }
  return [...counts.entries()]
    .sort(
      (left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0], "ja"),
    )
    .slice(0, 16)
    .map(([name]) => name);
}

function deterministicExtraction(
  chunk: { id: string; text: string; paragraphIds: string[] },
  document: NormalizedDocument,
  sourceFingerprint: string,
): ChunkExtractionV1 {
  const paragraphById = new Map(
    document.paragraphs.map((paragraph) => [paragraph.id, paragraph]),
  );
  const paragraphs = chunk.paragraphIds
    .map((paragraphId) => paragraphById.get(paragraphId))
    .filter(
      (paragraph): paragraph is NormalizedDocument["paragraphs"][number] =>
        Boolean(paragraph),
    );
  const firstParagraph = paragraphs[0];
  const fallbackEvidence: EvidenceRef = firstParagraph
    ? evidenceFor(firstParagraph)
    : { sectionId: "unknown", paragraphId: "unknown" };
  const names = candidateNames(chunk.text);
  const entities = names.map((name) => {
    const paragraph =
      paragraphs.find((item) => item.text.includes(name)) ?? firstParagraph;
    const evidence = paragraph ? evidenceFor(paragraph) : fallbackEvidence;
    return {
      type: "unknown" as const,
      name,
      aliases: [],
      evidence: [evidence],
      confidence: 0.35,
    };
  });
  const events = paragraphs.slice(0, 200).map((paragraph, index) => {
    const namesInParagraph = names.filter((name) =>
      paragraph.text.includes(name),
    );
    const evidence = evidenceFor(paragraph);
    return {
      title: excerpt(paragraph.text, 80) || `Paragraph ${index + 1}`,
      summary: excerpt(paragraph.text, 240),
      sectionId: paragraph.sectionId,
      paragraphIds: [paragraph.id],
      entityNames: namesInParagraph,
      order: paragraph.sectionOrdinal * 100_000 + paragraph.ordinal,
      evidence: [evidence],
    };
  });
  return {
    schemaVersion: CHUNK_EXTRACTION_SCHEMA_VERSION,
    chunkId: chunk.id,
    sourceFingerprint,
    entities,
    relations: [],
    events,
  };
}

type ConfiguredProvider = "workers-ai" | GatewayProviderName;

function configuredProvider(env: ScanEnv): ConfiguredProvider {
  if (
    env.SCAN_AI_PROVIDER === "ai-gateway" ||
    env.SCAN_AI_PROVIDER === "openrouter" ||
    env.SCAN_AI_PROVIDER === "workers-ai"
  )
    return env.SCAN_AI_PROVIDER;
  return env.AI ? "workers-ai" : "ai-gateway";
}

function configuredFrontierProvider(env: ScanEnv): ConfiguredProvider {
  if (
    env.SCAN_FRONTIER_PROVIDER === "ai-gateway" ||
    env.SCAN_FRONTIER_PROVIDER === "openrouter" ||
    env.SCAN_FRONTIER_PROVIDER === "workers-ai"
  )
    return env.SCAN_FRONTIER_PROVIDER;
  return configuredProvider(env);
}

type ProviderPurpose = "extraction" | "frontier";

function providerProfile(
  env: ScanEnv,
  provider = configuredProvider(env),
  purpose: ProviderPurpose = "extraction",
) {
  const model =
    purpose === "frontier"
      ? env.SCAN_FRONTIER_MODEL?.trim() ||
        (provider === "workers-ai"
          ? (env.SCAN_AI_MODEL ?? DEFAULT_SCAN_AI_MODEL)
          : "")
      : (env.SCAN_AI_MODEL ?? DEFAULT_SCAN_AI_MODEL);
  return {
    provider,
    model,
    maxInputCharacters: 6_000,
    maxOutputCharacters: 20_000,
    allowFallback: true,
  };
}

function parseStoredExtraction(value: string | null): StoredExtraction | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredExtraction>;
    if (
      typeof parsed.chunkId !== "string" ||
      typeof parsed.provider !== "string" ||
      typeof parsed.model !== "string" ||
      !parsed.extraction ||
      typeof parsed.extraction !== "object"
    )
      return null;
    return parsed as StoredExtraction;
  } catch {
    return null;
  }
}

async function recordExtractionUsage(
  repository: ScanRepository,
  scanId: string,
  record: StoredExtraction,
): Promise<void> {
  await repository.recordAiUsage({
    operationId: `${scanId}:${record.chunkId}:extract`,
    scanId,
    provider: record.provider,
    model: record.model,
    status:
      record.provider === "deterministic-fallback" ? "failed" : "completed",
  });
}

function createConfiguredProvider(
  env: ScanEnv,
  providerName: ConfiguredProvider,
  purpose: ProviderPurpose = "extraction",
  hooks: ProviderCallHooks = {},
): ReturnType<typeof createWorkersAiProvider> | null {
  const profile = providerProfile(env, providerName, purpose);
  if (!profile.model) return null;
  if (providerName === "workers-ai") {
    return env.AI ? createWorkersAiProvider(env.AI, profile, hooks) : null;
  }
  return createGatewayAiProvider(env, providerName, profile, hooks);
}

async function ensureBillableProviderActive(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
): Promise<void> {
  const scan = await repository.getScan(scanId);
  if (!scan) throw new Error("scan session was not found");
  if (scan.status === "deleted") throw new ScanDeletedError();
  if (
    scan.status === "cancel_requested" ||
    scan.status === "cancelled" ||
    scan.status === "failed" ||
    scan.status === "expired" ||
    scan.status === "completed"
  ) {
    throw new Error(`scan is not active for an AI request: ${scan.status}`);
  }
  await assertCurrentAiDataConsentIdentity(env, scan.aiConsent, "scan");
}

function billableProviderHooks(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
): ProviderCallHooks {
  return {
    beforeCall: () => ensureBillableProviderActive(env, repository, scanId),
    afterCall: () => ensureBillableProviderActive(env, repository, scanId),
  };
}

async function readObjectText(
  env: ScanEnv,
  objectKey: string,
): Promise<string> {
  const object = await env.SCAN_BUCKET.get(objectKey);
  if (!object?.body) throw new Error("required scan artifact is missing");
  const text = await new Response(object.body).text();
  if (new TextEncoder().encode(text).byteLength > MAX_SOURCE_TEXT_BYTES) {
    throw new Error("source artifact exceeds the processing limit");
  }
  return text;
}

async function readJson<T>(env: ScanEnv, objectKey: string): Promise<T> {
  try {
    return JSON.parse(await readObjectText(env, objectKey)) as T;
  } catch (cause) {
    throw new Error(`scan artifact ${objectKey} is invalid: ${String(cause)}`);
  }
}

async function putJsonObject(
  env: ScanEnv,
  repository: ScanRepository,
  input: {
    scanId: string;
    objectKey: string;
    schemaVersion: string;
    serialized: string;
  },
): Promise<void> {
  const beforeWrite = await repository.getScan(input.scanId);
  if (!beforeWrite || beforeWrite.status === "deleted")
    throw new ScanDeletedError();
  await env.SCAN_BUCKET.put(input.objectKey, input.serialized, {
    httpMetadata: { contentType: JSON_CONTENT_TYPE },
    customMetadata: {
      sha256: sha256Hex(input.serialized),
      schemaVersion: input.schemaVersion,
    },
  });
  const afterWrite = await repository.getScan(input.scanId);
  if (!afterWrite || afterWrite.status === "deleted") {
    await env.SCAN_BUCKET.delete(input.objectKey).catch(() => undefined);
    throw new ScanDeletedError();
  }
}

function parseAdjudicationResult(
  serialized: string,
  ambiguityId: string,
  source: "D1" | "R2",
): AdjudicationOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (cause) {
    throw new Error(
      `durable adjudication result in ${source} is invalid: ${String(cause)}`,
    );
  }
  if (!isAdjudicationOutput(parsed, ambiguityId)) {
    throw new Error(
      `durable adjudication result in ${source} failed validation`,
    );
  }
  return parsed;
}

async function readR2AdjudicationResult(
  env: ScanEnv,
  scanId: string,
  ambiguityId: string,
): Promise<AdjudicationOutput | null> {
  const object = await env.SCAN_BUCKET.get(
    adjudicationResultKey(scanId, ambiguityId),
  );
  if (!object) return null;
  if (!object.body)
    throw new Error("durable adjudication result has no readable body");
  return parseAdjudicationResult(
    await new Response(object.body).text(),
    ambiguityId,
    "R2",
  );
}

async function writeAdjudicationResult(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  result: AdjudicationOutput,
): Promise<void> {
  await putJsonObject(env, repository, {
    scanId,
    objectKey: adjudicationResultKey(scanId, result.ambiguityId),
    schemaVersion: ADJUDICATION_RESULT_SCHEMA_VERSION,
    serialized: JSON.stringify(result),
  });
}

async function readDurableAdjudicationResult(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  ambiguityId: string,
): Promise<AdjudicationOutput | null> {
  const persisted = await repository.getAdjudicationResult(scanId, ambiguityId);
  if (persisted) {
    const result = parseAdjudicationResult(
      persisted.resultJson,
      ambiguityId,
      "D1",
    );
    // D1 is authoritative for paid-call idempotency. Re-create the R2 cache
    // before continuing when a previous attempt failed during its PUT.
    await writeAdjudicationResult(env, repository, scanId, result);
    return result;
  }

  // Backfill results written by deployments that only used the R2 cache.
  const legacyResult = await readR2AdjudicationResult(env, scanId, ambiguityId);
  if (!legacyResult) return null;
  const canonical = await repository.saveAdjudicationResult(
    scanId,
    ambiguityId,
    JSON.stringify(legacyResult),
  );
  return parseAdjudicationResult(canonical.resultJson, ambiguityId, "D1");
}

async function writeJson(
  env: ScanEnv,
  repository: ScanRepository,
  input: {
    scanId: string;
    kind: Parameters<ScanRepository["saveArtifact"]>[0]["kind"];
    objectKey: string;
    schemaVersion: string;
    value: unknown;
    expiresAt?: string | null;
  },
): Promise<void> {
  const serialized = JSON.stringify(input.value);
  const digest = sha256Hex(serialized);
  await putJsonObject(env, repository, {
    scanId: input.scanId,
    objectKey: input.objectKey,
    schemaVersion: input.schemaVersion,
    serialized,
  });
  await repository.saveArtifact({
    scanId: input.scanId,
    kind: input.kind,
    objectKey: input.objectKey,
    schemaVersion: input.schemaVersion,
    sha256: digest,
    contentType: JSON_CONTENT_TYPE,
    expiresAt: input.expiresAt,
  });
}

function sourceArtifactExpiresAt(env: ScanEnv): string {
  const configuredDays = Number(env.SCAN_SOURCE_RETENTION_DAYS);
  const days =
    Number.isSafeInteger(configuredDays) && configuredDays > 0
      ? configuredDays
      : 1;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function normalizeScanSource(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
): Promise<{ objectKey: string; fingerprint: string }> {
  const scan = await repository.getScan(scanId);
  if (!scan) throw new Error("scan session was not found");
  const upload = await repository.getUploadIntent(scan.uploadId);
  if (!upload || upload.status !== "consumed")
    throw new Error("source upload is not consumed");
  const text = await readObjectText(env, upload.sourceKey);
  const input: SourceDocumentInput = {
    title: sourceTitle(upload.filename),
    text,
    language: detectLanguage(text),
  };
  const document = normalizeDocument(input);
  const objectKey = `artifacts/${scanId}/source-document.json`;
  await writeJson(env, repository, {
    scanId,
    kind: "source",
    objectKey,
    schemaVersion: "grimodex-scan/normalized-document/1",
    value: document,
    expiresAt: sourceArtifactExpiresAt(env),
  });
  return { objectKey, fingerprint: document.source.fingerprint };
}

export async function buildScanChunks(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  mode: "quick" | "full",
): Promise<{ objectKey: string; count: number }> {
  const document = await readJson<NormalizedDocument>(
    env,
    `artifacts/${scanId}/source-document.json`,
  );
  const chunks = buildChunks(document, {
    maxCharacters:
      mode === "full" ? FULL_CHUNK_CHARACTERS : QUICK_CHUNK_CHARACTERS,
    overlapParagraphs: mode === "full" ? 1 : 0,
  });
  if (chunks.length > MAX_SCAN_CHUNKS) {
    throw new Error(
      `scan produces too many chunks (maximum ${MAX_SCAN_CHUNKS})`,
    );
  }
  const objectKey = `artifacts/${scanId}/chunks.json`;
  await writeJson(env, repository, {
    scanId,
    kind: "chunk-input",
    objectKey,
    schemaVersion: "grimodex-scan/chunks/1",
    value: { sourceFingerprint: document.source.fingerprint, chunks },
    expiresAt: sourceArtifactExpiresAt(env),
  });
  return { objectKey, count: chunks.length };
}

export async function extractScanChunks(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
): Promise<{ objectKey: string; count: number; fallbackCount: number }> {
  const document = await readJson<NormalizedDocument>(
    env,
    `artifacts/${scanId}/source-document.json`,
  );
  const chunkData = await readJson<{
    sourceFingerprint: string;
    chunks: Array<{
      id: string;
      text: string;
      paragraphIds: string[];
      sectionIds: string[];
    }>;
  }>(env, `artifacts/${scanId}/chunks.json`);
  // Re-check the durable artifact as well as the builder output. This keeps a
  // legacy or tampered 4,096-chunk artifact from entering the paid step.
  if (chunkData.chunks.length > MAX_SCAN_CHUNKS) {
    throw new Error(
      `scan produces too many chunks (maximum ${MAX_SCAN_CHUNKS})`,
    );
  }
  const providerName = configuredProvider(env);
  const provider =
    env.SCAN_WORKERS_AI_ENABLED === "true"
      ? createConfiguredProvider(
          env,
          providerName,
          "extraction",
          billableProviderHooks(env, repository, scanId),
        )
      : null;
  const profile = providerProfile(env, providerName);
  let records: StoredExtraction[] = [];
  try {
    const previous = await readJson<StoredExtractions>(
      env,
      `artifacts/${scanId}/chunk-extractions.json`,
    );
    if (previous.sourceFingerprint === chunkData.sourceFingerprint)
      records = previous.chunks;
  } catch {
    // A missing or partial extraction artifact is expected on the first run.
  }
  const recordByChunk = new Map(
    records.map((record) => [record.chunkId, record]),
  );
  const paragraphById = new Map(
    document.paragraphs.map((paragraph) => [paragraph.id, paragraph]),
  );
  const chunkPersistenceAvailable =
    typeof repository.ensureScanChunks === "function" &&
    typeof repository.getScanChunk === "function" &&
    typeof repository.claimScanChunk === "function" &&
    typeof repository.completeScanChunk === "function" &&
    typeof repository.failScanChunk === "function" &&
    typeof repository.saveScanChunkResult === "function";
  if (chunkPersistenceAvailable) {
    await repository.ensureScanChunks(
      scanId,
      chunkData.chunks.map((chunk) => ({
        chunkHash: chunk.id,
        pipelineVersion: PIPELINE_VERSION,
        inputKey: `artifacts/${scanId}/chunks.json`,
      })),
    );
  }
  let fallbackCount = records.filter(
    (record) => record.provider === "deterministic-fallback",
  ).length;
  for (const chunk of chunkData.chunks) {
    const previous = recordByChunk.get(chunk.id);
    let recoveringStaleClaim = false;
    let claimAttempt: number | null = null;
    if (chunkPersistenceAvailable) {
      const current = await repository.getScanChunk(
        scanId,
        chunk.id,
        PIPELINE_VERSION,
      );
      if (current?.status === "completed" && current.extractionKey) {
        let stored: StoredExtraction | null = null;
        try {
          stored = await readJson<StoredExtraction>(env, current.extractionKey);
        } catch {
          stored = parseStoredExtraction(current.extractionJson);
          if (!stored)
            throw new Error("completed scan chunk result is missing");
          const serialized = JSON.stringify(stored);
          await putJsonObject(env, repository, {
            scanId,
            objectKey: current.extractionKey,
            schemaVersion: CHUNK_EXTRACTION_SCHEMA_VERSION,
            serialized,
          });
        }
        recordByChunk.set(chunk.id, stored);
        records = chunkData.chunks
          .map((candidate) => recordByChunk.get(candidate.id))
          .filter((candidate): candidate is StoredExtraction =>
            Boolean(candidate),
          );
        await recordExtractionUsage(repository, scanId, stored);
        continue;
      }
      const durableResult = parseStoredExtraction(
        current?.extractionJson ?? null,
      );
      if (durableResult) {
        const claimed = await repository.claimScanChunk(
          scanId,
          chunk.id,
          PIPELINE_VERSION,
          new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        );
        if (!claimed) {
          throw new ScanProviderError(
            "unavailable",
            "scan chunk is already being processed",
            true,
          );
        }
        const extractionKey = `artifacts/${scanId}/chunk-results/${encodeURIComponent(chunk.id)}.json`;
        try {
          const serialized = JSON.stringify(durableResult);
          await putJsonObject(env, repository, {
            scanId,
            objectKey: extractionKey,
            schemaVersion: CHUNK_EXTRACTION_SCHEMA_VERSION,
            serialized,
          });
          await repository.completeScanChunk(
            scanId,
            chunk.id,
            PIPELINE_VERSION,
            claimed.attempt,
            extractionKey,
          );
        } catch (cause) {
          await repository.failScanChunk(
            scanId,
            chunk.id,
            PIPELINE_VERSION,
            claimed.attempt,
          );
          throw cause;
        }
        recordByChunk.set(chunk.id, durableResult);
        records = chunkData.chunks
          .map((candidate) => recordByChunk.get(candidate.id))
          .filter((candidate): candidate is StoredExtraction =>
            Boolean(candidate),
          );
        await recordExtractionUsage(repository, scanId, durableResult);
        continue;
      }
      if (previous) {
        // Older runs may have written the aggregate artifact before the
        // per-chunk ledger was introduced. Backfill the ledger from that
        // already-paid result instead of calling the provider again.
        const claimed = await repository.claimScanChunk(
          scanId,
          chunk.id,
          PIPELINE_VERSION,
          new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        );
        if (!claimed) {
          throw new ScanProviderError(
            "unavailable",
            "scan chunk is already being processed",
            true,
          );
        }
        const extractionKey = `artifacts/${scanId}/chunk-results/${encodeURIComponent(chunk.id)}.json`;
        try {
          const serialized = JSON.stringify(previous);
          await repository.saveScanChunkResult(
            scanId,
            chunk.id,
            PIPELINE_VERSION,
            claimed.attempt,
            serialized,
          );
          await putJsonObject(env, repository, {
            scanId,
            objectKey: extractionKey,
            schemaVersion: CHUNK_EXTRACTION_SCHEMA_VERSION,
            serialized,
          });
          await repository.completeScanChunk(
            scanId,
            chunk.id,
            PIPELINE_VERSION,
            claimed.attempt,
            extractionKey,
          );
        } catch (cause) {
          await repository.failScanChunk(
            scanId,
            chunk.id,
            PIPELINE_VERSION,
            claimed.attempt,
          );
          throw cause;
        }
        await recordExtractionUsage(repository, scanId, previous);
        continue;
      }
      recoveringStaleClaim = current?.status === "running";
      const claimed = await repository.claimScanChunk(
        scanId,
        chunk.id,
        PIPELINE_VERSION,
        new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      );
      if (!claimed) {
        throw new ScanProviderError(
          "unavailable",
          "scan chunk is already being processed",
          true,
        );
      }
      claimAttempt = claimed.attempt;
    } else if (previous) {
      continue;
    }
    const paragraphs = chunk.paragraphIds.map((paragraphId) => {
      const paragraph = paragraphById.get(paragraphId);
      if (!paragraph) {
        throw new Error(
          `scan chunk references unknown paragraph ${paragraphId}`,
        );
      }
      return {
        paragraphId,
        sectionId: paragraph.sectionId,
        text: paragraph.text,
      };
    });
    const input: ChunkExtractionInput = {
      chunkId: chunk.id,
      sourceFingerprint: chunkData.sourceFingerprint,
      text: chunk.text,
      sectionIds: chunk.sectionIds,
      paragraphIds: chunk.paragraphIds,
      paragraphSectionIds: Object.fromEntries(
        paragraphs.map((paragraph) => [
          paragraph.paragraphId,
          paragraph.sectionId,
        ]),
      ),
      paragraphs,
    };
    let extraction: ChunkExtractionV1;
    let providerName: StoredExtraction["provider"] = "deterministic";
    let model = "deterministic-extractor/1";
    if (provider && !recoveringStaleClaim) {
      try {
        extraction = await provider.extractChunk(input);
        providerName = configuredProvider(env);
        model = profile.model;
      } catch (cause) {
        if (!(cause instanceof ScanProviderError) || !cause.retryable)
          throw cause;
        extraction = deterministicExtraction(
          chunk,
          document,
          chunkData.sourceFingerprint,
        );
        providerName = "deterministic-fallback";
        model = "deterministic-extractor/1";
        fallbackCount += 1;
      }
    } else {
      extraction = deterministicExtraction(
        chunk,
        document,
        chunkData.sourceFingerprint,
      );
    }
    const record: StoredExtraction = {
      chunkId: chunk.id,
      extraction,
      provider: providerName,
      model,
    };
    const extractionKey = `artifacts/${scanId}/chunk-results/${encodeURIComponent(chunk.id)}.json`;
    if (chunkPersistenceAvailable) {
      if (claimAttempt === null)
        throw new Error("scan chunk claim is missing its fencing attempt");
      try {
        const serialized = JSON.stringify(record);
        // Commit the provider result to D1 before touching R2. If the object
        // write or completion CAS fails, a retry can repair the object from
        // this durable result without invoking (and charging) the provider a
        // second time.
        await repository.saveScanChunkResult(
          scanId,
          chunk.id,
          PIPELINE_VERSION,
          claimAttempt,
          serialized,
        );
        await putJsonObject(env, repository, {
          scanId,
          objectKey: extractionKey,
          schemaVersion: CHUNK_EXTRACTION_SCHEMA_VERSION,
          serialized,
        });
        await repository.completeScanChunk(
          scanId,
          chunk.id,
          PIPELINE_VERSION,
          claimAttempt,
          extractionKey,
        );
      } catch (cause) {
        await repository.failScanChunk(
          scanId,
          chunk.id,
          PIPELINE_VERSION,
          claimAttempt,
        );
        throw cause;
      }
    }
    recordByChunk.set(chunk.id, record);
    records = chunkData.chunks
      .map((candidate) => recordByChunk.get(candidate.id))
      .filter((candidate): candidate is StoredExtraction => Boolean(candidate));
    // D1's fenced per-chunk result is the retry authority. Only legacy/test
    // repositories without that ledger need an aggregate checkpoint after
    // every chunk; the normal path writes the aggregate once after the loop.
    if (!chunkPersistenceAvailable) {
      await writeJson(env, repository, {
        scanId,
        kind: "chunk-extraction",
        objectKey: `artifacts/${scanId}/chunk-extractions.json`,
        schemaVersion: CHUNK_EXTRACTION_SCHEMA_VERSION,
        value: {
          sourceFingerprint: chunkData.sourceFingerprint,
          chunks: records,
        },
      });
    }
    await recordExtractionUsage(repository, scanId, record);
  }
  const output: StoredExtractions = {
    sourceFingerprint: chunkData.sourceFingerprint,
    chunks: records,
  };
  const objectKey = `artifacts/${scanId}/chunk-extractions.json`;
  await writeJson(env, repository, {
    scanId,
    kind: "chunk-extraction",
    objectKey,
    schemaVersion: CHUNK_EXTRACTION_SCHEMA_VERSION,
    value: output,
  });
  return { objectKey, count: records.length, fallbackCount };
}

export async function mergeScanExtractions(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
): Promise<{ objectKey: string; entityCount: number; eventCount: number }> {
  const document = await readJson<NormalizedDocument>(
    env,
    `artifacts/${scanId}/source-document.json`,
  );
  const extractions = await readJson<StoredExtractions>(
    env,
    `artifacts/${scanId}/chunk-extractions.json`,
  );
  const entityCandidates = extractions.chunks.flatMap(
    (item) => item.extraction.entities,
  );
  const relationCandidates = extractions.chunks.flatMap(
    (item) => item.extraction.relations,
  );
  const eventCandidates = extractions.chunks.flatMap(
    (item) => item.extraction.events,
  );
  const entityResult = mergeEntities(entityCandidates);
  const relationResult = mergeRelations(
    relationCandidates,
    entityResult.entities,
  );
  const eventResult = mergeEvents(eventCandidates, entityResult.entities);
  const phaseCandidates = document.sections.flatMap((section) => {
    const sectionParagraphIds = new Set(section.paragraphIds);
    const names = entityResult.entities
      .filter((entity) =>
        entity.evidence.some((evidence) =>
          sectionParagraphIds.has(evidence.paragraphId),
        ),
      )
      .slice(0, 12)
      .map((entity) => entity.name);
    const firstParagraph = document.paragraphs.find(
      (paragraph) => paragraph.sectionId === section.id,
    );
    if (!firstParagraph || names.length === 0) return [];
    return [
      {
        title: section.title,
        entityNames: names,
        anchors: [evidenceFor(firstParagraph)],
        summary: excerpt(firstParagraph.text, 240),
        confidence: 0.4,
      },
    ];
  });
  const phaseResult = buildPhases(phaseCandidates, entityResult.entities);
  const paragraphById = new Map(
    document.paragraphs.map((paragraph) => [paragraph.id, paragraph.text]),
  );
  const ambiguityInputs = entityResult.ambiguities.map((ambiguity) => {
    const candidates = ambiguity.candidateIndexes
      .map((index) => entityCandidates[index])
      .filter((candidate): candidate is (typeof entityCandidates)[number] =>
        Boolean(candidate),
      );
    const evidenceParagraphs = [
      ...new Map(
        candidates
          .flatMap((candidate) => candidate.evidence)
          .flatMap((evidence) => {
            const text = paragraphById.get(evidence.paragraphId);
            return text
              ? [
                  [
                    evidence.paragraphId,
                    { paragraphId: evidence.paragraphId, text },
                  ] as const,
                ]
              : [];
          }),
      ).values(),
    ].slice(0, 8);
    return {
      ambiguityId: ambiguity.id,
      candidateSummary: candidates
        .map((candidate) => `${candidate.type}:${candidate.name}`)
        .join(" / "),
      evidenceParagraphs,
    };
  });
  const ambiguityEntityIds = Object.fromEntries(
    entityResult.ambiguities.map((ambiguity) => {
      const ids = new Set<string>();
      for (const index of ambiguity.candidateIndexes) {
        const candidate = entityCandidates[index];
        if (!candidate) continue;
        const name = normalizeLookupName(candidate.name);
        entityResult.entities.forEach((entity) => {
          if (
            entity.type === candidate.type &&
            [entity.name, ...entity.aliases].some(
              (value) => normalizeLookupName(value) === name,
            )
          ) {
            ids.add(entity.id);
          }
        });
      }
      return [ambiguity.id, [...ids].sort()];
    }),
  );
  const output: MergeOutput = {
    sourceFingerprint: extractions.sourceFingerprint,
    entities: entityResult.entities,
    relations: relationResult.relations,
    events: eventResult.events,
    phases: phaseResult.phases,
    unresolvedRelations: relationResult.unresolved,
    unresolvedEvents: eventResult.unresolved,
    unresolvedPhases: phaseResult.unresolved,
    ambiguities: entityResult.ambiguities,
    ambiguityEntityIds,
    ambiguityInputs,
  };
  const objectKey = `artifacts/${scanId}/merge.json`;
  await writeJson(env, repository, {
    scanId,
    kind: "bundle",
    objectKey,
    schemaVersion: "grimodex-scan/merge/1",
    value: output,
  });
  return {
    objectKey,
    entityCount: output.entities.length,
    eventCount: output.events.length,
  };
}

export async function adjudicateScan(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
): Promise<{ objectKey: string; uncertainCount: number }> {
  const merge = await readJson<MergeOutput>(
    env,
    `artifacts/${scanId}/merge.json`,
  );
  const providerName = configuredFrontierProvider(env);
  const provider =
    env.SCAN_FRONTIER_ENABLED === "true"
      ? createConfiguredProvider(
          env,
          providerName,
          "frontier",
          billableProviderHooks(env, repository, scanId),
        )
      : null;
  const profile = providerProfile(env, providerName, "frontier");
  const output: AdjudicationOutput[] = [];
  const maxProviderCalls = 2;
  for (const [index, input] of merge.ambiguityInputs.entries()) {
    if (!provider || index >= maxProviderCalls) {
      output.push({
        ambiguityId: input.ambiguityId,
        entityIds: merge.ambiguityEntityIds[input.ambiguityId] ?? [],
        decision: "uncertain",
        rationale: "候補の証拠だけでは同一人物・同一対象と断定しない",
        provider: "deterministic-fallback",
        model: "deterministic-adjudicator/1",
      });
      continue;
    }
    const operationId = `${scanId}:${input.ambiguityId}:adjudicate`;
    const cached = await readDurableAdjudicationResult(
      env,
      repository,
      scanId,
      input.ambiguityId,
    );
    if (cached) {
      output.push({
        ...cached,
        entityIds: merge.ambiguityEntityIds[input.ambiguityId] ?? [],
      });
      await repository.recordAiUsage({
        operationId,
        scanId,
        provider: cached.provider,
        model: cached.model,
        status:
          cached.provider === "deterministic-fallback" ? "failed" : "completed",
      });
      continue;
    }
    let result: AdjudicationOutput;
    try {
      const providerResult = await provider.adjudicate({
        sourceFingerprint: merge.sourceFingerprint,
        ambiguityId: input.ambiguityId,
        evidenceParagraphs: input.evidenceParagraphs,
        candidateSummary: input.candidateSummary,
      });
      result = {
        ...providerResult,
        entityIds: merge.ambiguityEntityIds[input.ambiguityId] ?? [],
        provider: providerName,
        model: profile.model,
      };
    } catch (cause) {
      if (!(cause instanceof ScanProviderError) || !cause.retryable)
        throw cause;
      result = {
        ambiguityId: input.ambiguityId,
        entityIds: merge.ambiguityEntityIds[input.ambiguityId] ?? [],
        decision: "uncertain",
        rationale:
          "フロンティア判定を完了できなかったため、統合を保留しました。",
        provider: "deterministic-fallback",
        model: "deterministic-adjudicator/1",
      };
    }
    // Workflow step callbacks may be retried after any later await. D1 is
    // committed before the R2 cache, ledger, or aggregate so an R2 PUT failure
    // can be repaired without issuing the same billable request again.
    const persisted = await repository.saveAdjudicationResult(
      scanId,
      input.ambiguityId,
      JSON.stringify(result),
    );
    result = parseAdjudicationResult(
      persisted.resultJson,
      input.ambiguityId,
      "D1",
    );
    await writeAdjudicationResult(env, repository, scanId, result);
    output.push(result);
    await repository.recordAiUsage({
      operationId,
      scanId,
      provider: result.provider,
      model: result.model,
      status:
        result.provider === "deterministic-fallback" ? "failed" : "completed",
    });
  }
  const objectKey = `artifacts/${scanId}/adjudication.json`;
  await writeJson(env, repository, {
    scanId,
    kind: "bundle",
    objectKey,
    schemaVersion: "grimodex-scan/adjudication/1",
    value: output,
  });
  return {
    objectKey,
    uncertainCount: output.filter((item) => item.decision === "uncertain")
      .length,
  };
}

function findingsFor(
  document: NormalizedDocument,
  merge: MergeOutput,
  adjudication: readonly AdjudicationOutput[],
): ScanFinding[] {
  const firstEvidence = document.paragraphs[0]
    ? [evidenceFor(document.paragraphs[0])]
    : [];
  const paragraphById = new Map(
    document.paragraphs.map((paragraph) => [paragraph.id, paragraph]),
  );
  const ambiguityEvidence = new Map(
    merge.ambiguityInputs.map((input) => [
      input.ambiguityId,
      input.evidenceParagraphs
        .map(({ paragraphId }) => paragraphById.get(paragraphId))
        .filter(
          (paragraph): paragraph is NormalizedDocument["paragraphs"][number] =>
            Boolean(paragraph),
        )
        .map(evidenceFor),
    ]),
  );
  const findings: ScanFinding[] = [];
  const findingId = (scope: string, value: string): string => {
    const hex = sha256Hex(`${scope}:${value}`).slice(0, 32);
    const uuid = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `4${hex.slice(13, 16)}`,
      `${"89ab"[parseInt(hex[16] ?? "8", 16) % 4]}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join("-");
    return `finding:${uuid}`;
  };
  merge.unresolvedRelations.forEach((candidate, index) => {
    findings.push({
      id: findingId(
        "relation",
        `${candidate.fromName}:${candidate.toName}:${index}`,
      ),
      kind: "ambiguity",
      status: "candidate",
      title: `関係を確定できません: ${candidate.fromName} → ${candidate.toName}`,
      summary: "候補名が一意に解決できなかったため、手動確認が必要です。",
      evidence: candidate.evidence,
    });
  });
  merge.unresolvedEvents.forEach((candidate, index) => {
    findings.push({
      id: findingId("event", `${candidate.title}:${index}`),
      kind: "timeline",
      status: "candidate",
      title: `イベントを確定できません: ${candidate.title}`,
      summary: "登場人物の対応付けが一意でないため、手動確認が必要です。",
      evidence: candidate.evidence,
    });
  });
  merge.unresolvedPhases.forEach((candidate, index) => {
    findings.push({
      id: findingId("phase", `${candidate.title}:${index}`),
      kind: "ambiguity",
      status: "candidate",
      title: `フェーズを確定できません: ${candidate.title}`,
      summary: "フェーズに対応するエンティティを一意に解決できませんでした。",
      evidence: candidate.anchors,
    });
  });
  adjudication.forEach((item) => {
    if (item.decision !== "uncertain") return;
    findings.push({
      id: findingId("ambiguity", item.ambiguityId),
      kind: "ambiguity",
      status: "candidate",
      title: "同名候補の統合を保留しました",
      summary: item.rationale,
      evidence: ambiguityEvidence.get(item.ambiguityId) ?? firstEvidence,
    });
  });
  return findings.slice(0, 200);
}

export async function buildScanArtifacts(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  mode: "quick" | "full",
): Promise<PipelineArtifacts> {
  const document = await readJson<NormalizedDocument>(
    env,
    `artifacts/${scanId}/source-document.json`,
  );
  const merge = await readJson<MergeOutput>(
    env,
    `artifacts/${scanId}/merge.json`,
  );
  const adjudication =
    mode === "full"
      ? await readJson<AdjudicationOutput[]>(
          env,
          `artifacts/${scanId}/adjudication.json`,
        )
      : [];
  const extractions = await readJson<StoredExtractions>(
    env,
    `artifacts/${scanId}/chunk-extractions.json`,
  );
  const models = [
    ...new Map(
      extractions.chunks.map((item) => [
        `${item.provider}:${item.model}`,
        {
          provider: item.provider,
          model: item.model,
        },
      ]),
    ).values(),
  ];
  adjudication.forEach((item) => {
    models.push({ provider: item.provider, model: item.model });
  });
  const findings = findingsFor(document, merge, adjudication);
  const resolved = applyAdjudicationDecisions(
    {
      entities: merge.entities,
      relations: merge.relations,
      phases: merge.phases,
      events: merge.events,
    },
    adjudication,
  );
  const firstParagraph = document.paragraphs[0];
  const firstEvidence = firstParagraph ? [evidenceFor(firstParagraph)] : [];
  const bundle = buildScanBundle({
    document,
    entities: resolved.entities,
    relations: resolved.relations,
    phases: resolved.phases,
    events: resolved.events,
    findings,
    summary: {
      premise: firstParagraph ? excerpt(firstParagraph.text, 240) : undefined,
      genreCandidates: [],
      themes: [],
      strengths:
        document.sections.length > 0
          ? [
              {
                title: "構造化可能な本文",
                summary: `${document.sections.length}セクションを検出しました。`,
                evidence: firstEvidence,
              },
            ]
          : [],
      risks:
        findings.length > 0
          ? [
              {
                title: "要確認の候補",
                summary: `${findings.length}件の候補を保留しています。`,
                evidence: firstEvidence,
              },
            ]
          : [],
    },
    pipelineVersion: PIPELINE_VERSION,
    promptVersions: {
      chunkExtraction: PROMPT_VERSIONS.chunkExtraction,
      adjudication: PROMPT_VERSIONS.adjudication,
      report: PROMPT_VERSIONS.report,
    },
    models,
  });
  const editorSeed = buildEditorSeed(bundle, document);
  const bundleKey = `artifacts/${scanId}/editor-seed.json`;
  const reportKey = `artifacts/${scanId}/private-report.json`;
  await writeJson(env, repository, {
    scanId,
    kind: "bundle",
    objectKey: bundleKey,
    schemaVersion: editorSeed.schemaVersion,
    value: editorSeed,
    expiresAt: sourceArtifactExpiresAt(env),
  });
  await writeJson(env, repository, {
    scanId,
    kind: "private-report",
    objectKey: reportKey,
    schemaVersion: SCAN_SCHEMA_VERSION,
    value: bundle,
  });
  await repository.setPrivateArtifacts(scanId, { bundleKey, reportKey });
  return { bundle, editorSeed, bundleKey, reportKey };
}
