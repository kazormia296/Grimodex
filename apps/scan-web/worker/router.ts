import {
  DEFAULT_SCAN_AI_MODEL,
  type ScanEnv,
  type WorkerExecutionContextLike,
} from "./env";
import { ScanRepository, type ScanMode } from "./repository";
import {
  CLOUD_CONTENT_POLICY_ACK_HEADER,
  CLOUD_CONTENT_POLICY_VERSION,
  EDITOR_HANDOFF_SCHEMA_VERSION,
  HOSTED_EDITOR_AI_LIMITS,
  ID_PATTERNS,
  PUBLIC_REPORT_AUTHOR_CONFIRMATION_MAX_LENGTH,
  SCAN_LIMITS,
  parseHostedEditorAiAgentRequest,
  parseHostedEditorAiToolCalls,
  parseEditorSeed,
  parsePublicReport,
  parseScanBundle,
  toPublicReport,
  type HostedEditorAiAgentRequest,
  type ScanBundleV1,
} from "@grimodex/scan-contract";
import {
  constantTimeEqual,
  isFeatureEnabled,
  randomToken,
  sha256Hex,
  sha256HexBytes,
} from "./security";
import { parseMaxUploadBytes, validateUploadIntent } from "./validation";
import { HostedAiError, runHostedAi } from "./ai/hostedAi";
import { emitContentFreeObservation } from "./observability";
import { purgeDeletedScan } from "./retention";
import { publicReportArtifactKey } from "./publicReportPublication";
import type { ScanFunnelStep } from "./observability";
import {
  editorAiArtifactKey,
  readEditorAiArtifact,
  type EditorAiOperationArtifact,
} from "./editorAiArtifact";
import {
  AiDataConsentMismatchError,
  AiDataDisclosureUnavailableError,
  assertCurrentAiDataConsentIdentity,
  createAiDataDisclosure,
  currentAiDataConsentIdentity,
  type AiDataDisclosureLocale,
  type AiDataConsentIdentity,
} from "./ai/aiDataDisclosure";
import type { AiDataDisclosureRoute } from "@grimodex/scan-contract";

const JSON_LIMIT_BYTES = 64 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const EDITOR_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_EDITOR_SESSION_TTL_HOURS = 24;
const MAX_EDITOR_SESSION_TTL_HOURS = 24 * 7;
const QUICK_CHUNK_CHARACTERS = 6_000;
const FULL_CHUNK_CHARACTERS = 4_000;
const CLIENT_SCAN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_SCAN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

async function emitFunnel(
  context: WorkerExecutionContextLike | undefined,
  step: ScanFunnelStep,
  identifier?: string,
): Promise<void> {
  emitContentFreeObservation(context, {
    event: "funnel",
    code: step,
    scanIdHash: identifier ? await sha256Hex(identifier) : undefined,
  });
}

function dailyLimit(env: ScanEnv): number | null {
  if (env.SCAN_DAILY_LIMIT_UNITS === undefined) return null;
  const value = Number(env.SCAN_DAILY_LIMIT_UNITS);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function monthlyLimit(env: ScanEnv): number | null {
  if (env.SCAN_MONTHLY_LIMIT_UNITS === undefined) return null;
  const value = Number(env.SCAN_MONTHLY_LIMIT_UNITS);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function usageBuckets(
  env: ScanEnv,
  now = new Date(),
): Array<{ key: string; limit: number }> {
  const buckets: Array<{ key: string; limit: number }> = [];
  const daily = dailyLimit(env);
  if (daily !== null)
    buckets.push({
      key: `daily:${now.toISOString().slice(0, 10)}`,
      limit: daily,
    });
  const monthly = monthlyLimit(env);
  if (monthly !== null)
    buckets.push({
      key: `monthly:${now.toISOString().slice(0, 7)}`,
      limit: monthly,
    });
  return buckets;
}

function estimatedScanUnits(mode: ScanMode, sourceBytes: number): number {
  const chunkCharacters =
    mode === "full" ? FULL_CHUNK_CHARACTERS : QUICK_CHUNK_CHARACTERS;
  const extractionUnits = Math.max(1, Math.ceil(sourceBytes / chunkCharacters));
  return extractionUnits + (mode === "full" ? 2 : 0);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function configuredAllowedOrigins(env: ScanEnv): ReadonlySet<string> {
  const configured =
    env.ALLOWED_ORIGINS !== undefined
      ? env.ALLOWED_ORIGINS
      : (env.ALLOWED_ORIGIN ?? "https://try.grimodex.app");
  const origins = new Set<string>();
  for (const candidate of configured.split(",").map((value) => value.trim())) {
    if (!candidate || candidate === "*") continue;
    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.origin === candidate
      ) {
        origins.add(candidate);
      }
    } catch {
      // Invalid configuration entries fail closed without widening CORS.
    }
  }
  return origins;
}

function isAllowedOrigin(origin: string, env: ScanEnv): boolean {
  return configuredAllowedOrigins(env).has(origin);
}

function responseHeaders(origin: string | null, env: ScanEnv): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (origin && isAllowedOrigin(origin, env)) {
    headers.set("access-control-allow-origin", origin);
    headers.set(
      "access-control-allow-headers",
      `content-type, authorization, x-upload-token, x-scan-token, x-editor-session-token, x-scan-full-access, x-scan-source-language, x-idempotency-key, x-ai-consent-id, ${CLOUD_CONTENT_POLICY_ACK_HEADER}`,
    );
    headers.set(
      "access-control-allow-methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    headers.set("vary", "Origin");
  }
  return headers;
}

function json(
  data: unknown,
  status: number,
  request: Request,
  env: ScanEnv,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders(request.headers.get("origin"), env),
  });
}

function success(
  data: unknown,
  request: Request,
  env: ScanEnv,
  status = 200,
): Response {
  return json(data, status, request, env);
}

async function aiDisclosure(
  request: Request,
  env: ScanEnv,
  route: AiDataDisclosureRoute,
): Promise<Response> {
  try {
    const locale = disclosureLocale(request);
    const response = success(
      await createAiDataDisclosure(env, route, locale),
      request,
      env,
    );
    response.headers.set("content-language", locale);
    return response;
  } catch (cause) {
    if (cause instanceof AiDataDisclosureUnavailableError) {
      throw new HttpError(
        503,
        "ai_disclosure_unavailable",
        "AI data disclosure is unavailable",
      );
    }
    throw cause;
  }
}

function normalizedDisclosureLocale(
  value: string | null | undefined,
): AiDataDisclosureLocale | null {
  const primary = value?.trim().toLowerCase().split(/[-_]/, 1)[0];
  return primary === "ja" || primary === "en" ? primary : null;
}

function acceptedDisclosureLocale(
  value: string | null,
): AiDataDisclosureLocale | null {
  let selected: AiDataDisclosureLocale | null = null;
  let selectedQuality = -1;
  for (const candidate of value?.split(",") ?? []) {
    const [languageTag, ...parameters] = candidate.split(";");
    const locale = normalizedDisclosureLocale(languageTag);
    if (!locale) continue;
    let quality = 1;
    const qualityParameter = parameters.find((parameter) =>
      parameter.trim().toLowerCase().startsWith("q="),
    );
    if (qualityParameter) {
      const parsed = Number(qualityParameter.trim().slice(2));
      quality =
        Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    if (quality > 0 && quality > selectedQuality) {
      selected = locale;
      selectedQuality = quality;
    }
  }
  return selected;
}

function disclosureLocale(request: Request): AiDataDisclosureLocale {
  const requested = normalizedDisclosureLocale(
    new URL(request.url).searchParams.get("locale"),
  );
  return (
    requested ??
    acceptedDisclosureLocale(request.headers.get("accept-language")) ??
    "en"
  );
}

async function requireAiDataConsent(
  request: Request,
  env: ScanEnv,
  route: AiDataDisclosureRoute,
): Promise<AiDataConsentIdentity> {
  let current: AiDataConsentIdentity;
  try {
    current = await currentAiDataConsentIdentity(env, route);
  } catch (cause) {
    if (cause instanceof AiDataDisclosureUnavailableError) {
      throw new HttpError(
        503,
        "ai_disclosure_unavailable",
        "AI data disclosure is unavailable",
      );
    }
    throw cause;
  }
  const consentId = request.headers.get("x-ai-consent-id")?.trim() ?? "";
  if (!consentId || !constantTimeEqual(consentId, current.consentId)) {
    throw new HttpError(
      428,
      "ai_consent_required",
      "current AI data consent is required",
    );
  }
  const contentPolicyVersion =
    request.headers.get(CLOUD_CONTENT_POLICY_ACK_HEADER)?.trim() ?? "";
  if (contentPolicyVersion !== CLOUD_CONTENT_POLICY_VERSION) {
    throw new HttpError(
      428,
      "hosted_content_confirmation_required",
      "current hosted-content confirmation is required",
    );
  }
  return current;
}

async function requireStoredAiDataConsent(
  env: ScanEnv,
  identity: AiDataConsentIdentity | null | undefined,
  route: AiDataDisclosureRoute,
): Promise<AiDataConsentIdentity> {
  try {
    return await assertCurrentAiDataConsentIdentity(env, identity, route);
  } catch (cause) {
    if (cause instanceof AiDataDisclosureUnavailableError) {
      throw new HttpError(
        503,
        "ai_disclosure_unavailable",
        "AI data disclosure is unavailable",
      );
    }
    if (cause instanceof AiDataConsentMismatchError) {
      throw new HttpError(
        428,
        "ai_consent_required",
        "current AI data consent is required",
      );
    }
    throw cause;
  }
}

function artifactResponse(
  body: ReadableStream<Uint8Array>,
  request: Request,
  env: ScanEnv,
  contentType: string,
  cacheControl: string,
): Response {
  const headers = responseHeaders(request.headers.get("origin"), env);
  headers.set("content-type", contentType);
  headers.set("cache-control", cacheControl);
  return new Response(body, { status: 200, headers });
}

function applyFindingFeedback(
  bundle: ScanBundleV1,
  feedback: ReadonlyMap<string, "intentional" | "rejected">,
): ScanBundleV1 {
  if (feedback.size === 0) return bundle;
  return {
    ...bundle,
    findings: bundle.findings.map((finding) => ({
      ...finding,
      status: feedback.get(finding.id) ?? finding.status,
    })),
  };
}

async function readPrivateScanBundle(
  env: ScanEnv,
  artifactKey: string,
): Promise<ScanBundleV1> {
  const object = await env.SCAN_BUCKET.get(artifactKey);
  if (!object?.body)
    throw new HttpError(
      404,
      "report_not_found",
      "report artifact was not found",
    );
  let value: unknown;
  try {
    value = JSON.parse(await new Response(object.body).text()) as unknown;
  } catch {
    throw new HttpError(
      500,
      "report_invalid",
      "private report artifact is invalid",
    );
  }
  const parsed = parseScanBundle(value);
  if (!parsed.ok)
    throw new HttpError(
      500,
      "report_invalid",
      "private report failed contract validation",
    );
  return parsed.value;
}

function editorAiIdempotencyKey(request: Request): string {
  const key = request.headers.get("x-idempotency-key")?.trim() ?? "";
  if (key.length < 16 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new HttpError(
      400,
      "invalid_idempotency_key",
      "a valid editor AI idempotency key is required",
    );
  }
  return key;
}

async function writeEditorAiArtifact(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  objectKey: string,
  artifact: EditorAiOperationArtifact,
): Promise<void> {
  const serialized = JSON.stringify(artifact);
  if (
    new TextEncoder().encode(serialized).byteLength >
    HOSTED_EDITOR_AI_LIMITS.maxArtifactBytes
  ) {
    throw new HttpError(
      502,
      "editor_ai_result_invalid",
      "hosted editor AI result is too large",
    );
  }
  const beforeWrite = await repository.getScan(scanId);
  if (
    !beforeWrite ||
    beforeWrite.status !== "completed" ||
    !beforeWrite.privateReportKey
  ) {
    throw new HttpError(404, "scan_not_found", "scan was not found");
  }
  await env.SCAN_BUCKET.put(objectKey, serialized, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { schemaVersion: artifact.schemaVersion },
  });
  const afterWrite = await repository.getScan(scanId);
  if (
    !afterWrite ||
    afterWrite.status !== "completed" ||
    !afterWrite.privateReportKey
  ) {
    await env.SCAN_BUCKET.delete(objectKey).catch(() => undefined);
    throw new HttpError(404, "scan_not_found", "scan was not found");
  }
}

function tokenFromRequest(request: Request): string | null {
  const header = request.headers.get("x-upload-token");
  if (header?.trim()) return header.trim();
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

function sourceLanguagePreference(request: Request): "auto" | "ja" | "en" {
  const value = request.headers.get("x-scan-source-language")?.trim() || "auto";
  if (value === "auto" || value === "ja" || value === "en") return value;
  throw new HttpError(
    400,
    "invalid_source_language",
    "source language must be auto, ja, or en",
  );
}

function scanTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("x-scan-token");
  if (header?.trim()) return header.trim();
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

function editorSessionTtlMs(env: ScanEnv): number {
  if (env.SCAN_EDITOR_SESSION_TTL_HOURS === undefined) {
    return DEFAULT_EDITOR_SESSION_TTL_HOURS * 60 * 60 * 1000;
  }
  const hours = Number(env.SCAN_EDITOR_SESSION_TTL_HOURS);
  if (
    !Number.isSafeInteger(hours) ||
    hours < 1 ||
    hours > MAX_EDITOR_SESSION_TTL_HOURS
  ) {
    throw new HttpError(
      503,
      "editor_session_configuration_invalid",
      "hosted Editor session configuration is invalid",
    );
  }
  return hours * 60 * 60 * 1000;
}

async function parseJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > JSON_LIMIT_BYTES) {
    throw new HttpError(413, "payload_too_large", "request body is too large");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    try {
      return JSON.parse(await request.text()) as unknown;
    } catch {
      throw new HttpError(
        400,
        "invalid_json",
        "request body must be valid JSON",
      );
    }
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > JSON_LIMIT_BYTES) {
        await reader.cancel("request body is too large");
        throw new HttpError(
          413,
          "payload_too_large",
          "request body is too large",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "request body must be valid JSON");
  }
}

function secretFor(env: ScanEnv): string {
  return env.UPLOAD_TOKEN_SECRET ?? "development-only-secret";
}

async function tokenHash(token: string, env: ScanEnv): Promise<string> {
  return sha256Hex(`${secretFor(env)}\u0000${token}`);
}

function idSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function routeFamily(pathname: string): string {
  const segments = idSegments(pathname);
  return segments.length >= 3
    ? `/${segments.slice(0, 3).join("/")}`
    : pathname || "/";
}

function modeOf(value: unknown): ScanMode {
  if (value === "quick" || value === "full") return value;
  throw new HttpError(400, "invalid_mode", "mode must be quick or full");
}

function maxActiveJobs(env: ScanEnv): number | null {
  if (env.SCAN_MAX_ACTIVE_JOBS === undefined) return null;
  const value = Number(env.SCAN_MAX_ACTIVE_JOBS);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function fullScanProviderConfigured(env: ScanEnv): boolean {
  const provider =
    env.SCAN_AI_PROVIDER ?? (env.AI ? "workers-ai" : "ai-gateway");
  const frontierProvider = env.SCAN_FRONTIER_PROVIDER ?? provider;
  const frontierModel =
    env.SCAN_FRONTIER_MODEL?.trim() ||
    (frontierProvider === "workers-ai" ? env.SCAN_AI_MODEL?.trim() : "");
  const configured = (name: typeof provider): boolean => {
    if (name === "workers-ai") return Boolean(env.AI);
    if (name === "ai-gateway")
      return Boolean(env.SCAN_AI_GATEWAY_URL && env.AI_GATEWAY_TOKEN);
    return Boolean(env.OPENROUTER_URL && env.OPENROUTER_API_KEY);
  };
  return (
    configured(provider) &&
    configured(frontierProvider) &&
    Boolean(frontierModel)
  );
}

async function enforceRateLimit(
  request: Request,
  env: ScanEnv,
  scope: string,
): Promise<void> {
  if (!env.RATE_LIMITER) {
    if (env.SCAN_ENVIRONMENT === "production") {
      throw new HttpError(
        503,
        "rate_limiter_unavailable",
        "request rate limiting is not configured",
      );
    }
    return;
  }
  const ip = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const key = await sha256Hex(`${secretFor(env)}\u0000${scope}\u0000${ip}`);
  const result = await env.RATE_LIMITER.limit({ key });
  if (!result.success)
    throw new HttpError(429, "rate_limited", "request rate limit exceeded");
}

async function verifyTurnstile(
  request: Request,
  env: ScanEnv,
  value: unknown,
): Promise<void> {
  if (!isFeatureEnabled(env.SCAN_TURNSTILE_REQUIRED, false)) return;
  if (
    !env.TURNSTILE_SECRET_KEY ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new HttpError(
      403,
      "bot_check_required",
      "bot verification is required",
    );
  }
  const token = (value as Record<string, unknown>).turnstileToken;
  if (typeof token !== "string" || token.length < 10 || token.length > 4_000) {
    throw new HttpError(
      403,
      "bot_check_required",
      "bot verification is required",
    );
  }
  const form = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) form.set("remoteip", remoteIp);
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    },
  );
  if (
    !response.ok ||
    !((await response.json()) as { success?: boolean }).success
  ) {
    throw new HttpError(403, "bot_check_failed", "bot verification failed");
  }
}

async function uploadIntent(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  context?: WorkerExecutionContextLike,
): Promise<Response> {
  await enforceRateLimit(request, env, "upload-intent");
  if (!isFeatureEnabled(env.SCAN_ACCEPTING_NEW_JOBS, false)) {
    throw new HttpError(
      503,
      "scan_paused",
      "new scans are temporarily unavailable",
    );
  }
  const aiConsent = await requireAiDataConsent(request, env, "scan");
  const body = await parseJson(request);
  await verifyTurnstile(request, env, body);
  let input;
  try {
    input = validateUploadIntent(
      body,
      parseMaxUploadBytes(env.MAX_UPLOAD_BYTES),
    );
  } catch (cause) {
    throw new HttpError(
      400,
      "invalid_upload_intent",
      cause instanceof Error ? cause.message : "upload intent is invalid",
    );
  }
  const uploadId = crypto.randomUUID();
  const uploadToken = randomToken(32);
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
  await repository.createUploadIntent({
    id: uploadId,
    tokenHash: await tokenHash(uploadToken, env),
    filename: input.filename,
    contentType: input.contentType,
    expectedSize: input.size,
    sourceKey: `incoming/${uploadId}/source.txt`,
    status: "issued",
    expiresAt,
    actualSize: null,
    sourceHash: null,
    aiConsent,
  });
  const uploadUrl = new URL(
    `/api/v1/uploads/${uploadId}`,
    request.url,
  ).toString();
  await emitFunnel(context, "upload_intent_issued");
  return success(
    { uploadId, uploadUrl, uploadToken, expiresAt },
    request,
    env,
    201,
  );
}

async function uploadSource(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  uploadId: string,
  context?: WorkerExecutionContextLike,
): Promise<Response> {
  await enforceRateLimit(request, env, `upload-source:${uploadId}`);
  const rawToken = tokenFromRequest(request);
  if (!rawToken)
    throw new HttpError(
      401,
      "upload_token_required",
      "upload token is required",
    );
  const record = await repository.authorizeUpload(
    uploadId,
    await tokenHash(rawToken, env),
  );
  if (!record)
    throw new HttpError(
      404,
      "upload_not_found",
      "upload intent is invalid or expired",
    );
  let uploadCompleted = false;
  try {
    await requireStoredAiDataConsent(env, record.aiConsent, "scan");
    const sourceLanguage = sourceLanguagePreference(request);
    const requestContentType = (request.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (
      requestContentType !== record.contentType &&
      requestContentType !== "application/octet-stream"
    ) {
      throw new HttpError(
        415,
        "upload_content_type_mismatch",
        "uploaded content type does not match the intent",
      );
    }
    const body = await readBoundedBody(request, record.expectedSize);
    if (body.byteLength !== record.expectedSize) {
      throw new HttpError(
        400,
        "upload_size_mismatch",
        "uploaded bytes do not match the declared size",
      );
    }
    const digest = await sha256HexBytes(body);
    await env.SCAN_BUCKET.put(record.sourceKey, body, {
      httpMetadata: { contentType: record.contentType },
      customMetadata: {
        sha256: digest,
        schemaVersion: "source-text/1",
        sourceLanguage,
      },
    });
    await repository.markUploadComplete(uploadId, body.byteLength, digest);
    uploadCompleted = true;
    await emitFunnel(context, "source_uploaded", uploadId);
    return success(
      { uploadId, status: "uploaded", sha256: digest },
      request,
      env,
      200,
    );
  } catch (cause) {
    if (!uploadCompleted) await repository.releaseUploadClaim(uploadId);
    throw cause;
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel("upload exceeds limit");
        throw new HttpError(
          413,
          "payload_too_large",
          "uploaded bytes exceed the limit",
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function completeUpload(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  uploadId: string,
  context?: WorkerExecutionContextLike,
): Promise<Response> {
  await enforceRateLimit(request, env, `upload-complete:${uploadId}`);
  const rawToken = tokenFromRequest(request);
  if (!rawToken)
    throw new HttpError(
      401,
      "upload_token_required",
      "upload token is required",
    );
  const record = await repository.getUploadIntent(uploadId);
  const expectedTokenHash = await tokenHash(rawToken, env);
  if (
    !record ||
    record.status !== "uploaded" ||
    !constantTimeEqual(record.tokenHash, expectedTokenHash)
  ) {
    throw new HttpError(404, "upload_not_found", "upload is not ready");
  }
  const head = await env.SCAN_BUCKET.head(record.sourceKey);
  if (
    !head ||
    head.size !== record.expectedSize ||
    record.actualSize !== head.size ||
    !record.sourceHash ||
    !head.customMetadata?.sha256 ||
    !constantTimeEqual(head.customMetadata.sha256, record.sourceHash) ||
    (head.httpMetadata?.contentType !== record.contentType &&
      head.httpMetadata?.contentType !== "application/octet-stream")
  ) {
    throw new HttpError(
      409,
      "upload_verification_failed",
      "uploaded object verification failed",
    );
  }
  await emitFunnel(context, "source_verified", uploadId);
  return success({ uploadId, status: "uploaded" }, request, env);
}

async function createScan(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  context?: WorkerExecutionContextLike,
): Promise<Response> {
  await enforceRateLimit(request, env, "create-scan");
  if (!isFeatureEnabled(env.SCAN_ACCEPTING_NEW_JOBS, false)) {
    throw new HttpError(
      503,
      "scan_paused",
      "new scans are temporarily unavailable",
    );
  }
  const value = await parseJson(request);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_body", "scan body must be an object");
  }
  const body = value as Record<string, unknown>;
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  const mode = modeOf(body.mode);
  const scanId = typeof body.scanId === "string" ? body.scanId : "";
  if (!CLIENT_SCAN_ID_PATTERN.test(scanId)) {
    throw new HttpError(
      400,
      "invalid_scan_id",
      "scanId must be a client-generated UUID",
    );
  }
  const scanToken = typeof body.scanToken === "string" ? body.scanToken : "";
  if (!CLIENT_SCAN_TOKEN_PATTERN.test(scanToken)) {
    throw new HttpError(
      400,
      "invalid_scan_token",
      "scanToken must be a 32-byte base64url token",
    );
  }
  if (
    mode === "full" &&
    env.SCAN_ENVIRONMENT === "production" &&
    !env.SCAN_FULL_ACCESS_SECRET
  ) {
    throw new HttpError(
      503,
      "full_scan_not_configured",
      "Full Scan access is not configured",
    );
  }
  if (mode === "full" && env.SCAN_FULL_ACCESS_SECRET) {
    const fullToken = request.headers.get("x-scan-full-access")?.trim();
    if (
      !fullToken ||
      !constantTimeEqual(
        await sha256Hex(fullToken),
        await sha256Hex(env.SCAN_FULL_ACCESS_SECRET),
      )
    ) {
      throw new HttpError(
        403,
        "full_scan_auth_required",
        "Full Scan requires an authorized access token",
      );
    }
  }
  if (
    mode === "full" &&
    env.SCAN_ENVIRONMENT === "production" &&
    !fullScanProviderConfigured(env)
  ) {
    throw new HttpError(
      503,
      "full_scan_provider_not_configured",
      "Full Scan provider is not configured",
    );
  }
  const rawUploadToken = tokenFromRequest(request);
  if (!rawUploadToken)
    throw new HttpError(
      401,
      "upload_token_required",
      "upload token is required",
    );
  const upload = await repository.getUploadIntent(uploadId);
  if (
    !upload ||
    (upload.status !== "uploaded" && upload.status !== "consumed") ||
    upload.actualSize !== upload.expectedSize ||
    !upload.sourceHash
  )
    throw new HttpError(
      409,
      "upload_not_ready",
      "upload must be completed before scan creation",
    );
  if (
    !constantTimeEqual(upload.tokenHash, await tokenHash(rawUploadToken, env))
  ) {
    throw new HttpError(404, "upload_not_found", "upload intent is invalid");
  }
  const aiConsent = await requireStoredAiDataConsent(
    env,
    upload.aiConsent,
    "scan",
  );
  const activeLimit = maxActiveJobs(env);
  const reservedUnits = estimatedScanUnits(mode, upload.expectedSize);
  const buckets = usageBuckets(env);
  const created = await repository.createScan({
    id: scanId,
    uploadId,
    mode,
    reservedUnits,
    accessTokenHash: await tokenHash(scanToken, env),
    buckets,
    aiConsent,
    maxActiveJobs: activeLimit,
  });
  if (created === "budget-exhausted") {
    throw new HttpError(
      429,
      "scan_budget_exhausted",
      "Scan capacity is exhausted",
    );
  }
  if (created === "concurrency-exhausted") {
    throw new HttpError(
      429,
      "scan_concurrency_exhausted",
      "scan concurrency is exhausted",
    );
  }
  if (created === "upload-not-ready") {
    throw new HttpError(
      409,
      "upload_not_ready",
      "upload must be completed before scan creation",
    );
  }
  if (created === "consent-mismatch") {
    throw new HttpError(
      428,
      "ai_consent_required",
      "current AI data consent is required",
    );
  }
  if (created === "conflict") {
    throw new HttpError(
      409,
      "scan_id_conflict",
      "scanId is already associated with another request",
    );
  }

  const existingScan =
    created === "existing" ? await repository.getScan(scanId) : null;
  if (created === "existing" && !existingScan) {
    throw new HttpError(
      503,
      "scan_state_unavailable",
      "existing scan state is unavailable",
    );
  }
  const shouldDispatch =
    created === "created" || existingScan?.status === "queued";
  if (shouldDispatch) {
    if (!env.SCAN_WORKFLOW) {
      if (created === "created") {
        await repository.transitionScan(scanId, "failed");
        await repository.settleUsage(scanId, 0);
      }
      throw new HttpError(
        503,
        "workflow_unavailable",
        "scan workflow is not configured",
      );
    }
    try {
      await env.SCAN_WORKFLOW.create({ id: scanId, params: { scanId } });
      await emitFunnel(context, "scan_queued", scanId);
      emitContentFreeObservation(context, {
        event: "workflow_started",
        scanIdHash: await sha256Hex(scanId),
      });
    } catch {
      emitContentFreeObservation(context, {
        event: "workflow_failed",
        code: "start_failed",
        scanIdHash: await sha256Hex(scanId),
      });
      if (created === "created") {
        await repository.transitionScan(scanId, "failed");
        await repository.settleUsage(scanId, 0);
      }
      throw new HttpError(
        503,
        "workflow_unavailable",
        "scan workflow could not be started",
      );
    }
  }
  return success(
    { scanId, status: existingScan?.status ?? "queued", mode, scanToken },
    request,
    env,
    202,
  );
}

async function editorAi(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
): Promise<Response> {
  await enforceRateLimit(request, env, `editor-ai:${scanId}`);
  const scan = await authorizedEditorAiScan(request, env, repository, scanId);
  if (scan.status !== "completed" || !scan.privateReportKey)
    throw new HttpError(
      409,
      "editor_ai_not_ready",
      "hosted editor AI requires a completed scan",
    );
  if (!isFeatureEnabled(env.SCAN_EDITOR_AI_ENABLED, false)) {
    throw new HttpError(
      503,
      "editor_ai_paused",
      "hosted editor AI is temporarily unavailable",
    );
  }
  await requireAiDataConsent(request, env, "hosted-editor");
  const body = await parseJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(
      400,
      "invalid_body",
      "editor AI body must be an object",
    );
  }
  const value = body as Record<string, unknown>;
  const operation = value.operation;
  const prompt = value.prompt;
  const context = value.context;
  if (operation !== "chat" && operation !== "inline" && operation !== "codex") {
    throw new HttpError(
      400,
      "invalid_operation",
      "editor AI operation is invalid",
    );
  }
  if (
    typeof prompt !== "string" ||
    prompt.length === 0 ||
    prompt.length > 8_000
  ) {
    throw new HttpError(400, "invalid_prompt", "editor AI prompt is invalid");
  }
  if (
    context !== undefined &&
    (typeof context !== "string" || context.length > 16_000)
  ) {
    throw new HttpError(400, "invalid_context", "editor AI context is invalid");
  }
  const hasAgentMessages = value.messages !== undefined;
  const hasAgentTools = value.tools !== undefined;
  let agent: HostedEditorAiAgentRequest | undefined;
  if (hasAgentMessages || hasAgentTools) {
    if (
      operation !== "codex" ||
      context !== undefined ||
      !hasAgentMessages ||
      !hasAgentTools
    ) {
      throw new HttpError(
        400,
        "invalid_agent_contract",
        "editor AI agent contract is invalid",
      );
    }
    const parsedAgent = parseHostedEditorAiAgentRequest(
      { messages: value.messages, tools: value.tools },
      prompt,
    );
    if (!parsedAgent.ok) {
      throw new HttpError(
        400,
        "invalid_agent_contract",
        "editor AI agent contract is invalid",
      );
    }
    agent = parsedAgent.value;
  }
  const declaredToolNames = new Set(
    agent?.tools.map((tool) => tool.name) ?? [],
  );
  const idempotencyKey = editorAiIdempotencyKey(request);
  const costWeight = operation === "chat" ? 1 : operation === "inline" ? 2 : 3;
  const requestHash = await sha256Hex(
    JSON.stringify({
      operation,
      prompt,
      context: typeof context === "string" ? context : null,
      agent: agent ?? null,
    }),
  );
  const operationId = `editor-ai:${await sha256Hex(
    `${scanId}\u0000${idempotencyKey}`,
  )}`;
  const artifactKey = editorAiArtifactKey(scanId, operationId);
  const configuredProvider =
    env.SCAN_AI_PROVIDER ?? (env.AI ? "workers-ai" : "ai-gateway");
  const configuredModel = env.SCAN_AI_MODEL ?? DEFAULT_SCAN_AI_MODEL;

  const deliverArtifact = async (
    artifact: EditorAiOperationArtifact,
  ): Promise<Response> => {
    if (
      artifact.operationId !== operationId ||
      artifact.requestHash !== requestHash ||
      artifact.costWeight !== costWeight
    ) {
      throw new HttpError(
        artifact.operationId === operationId ? 409 : 500,
        artifact.operationId === operationId
          ? "idempotency_key_conflict"
          : "editor_ai_result_invalid",
        artifact.operationId === operationId
          ? "the idempotency key was already used for another request"
          : "hosted editor AI result is invalid",
      );
    }
    if (artifact.toolCalls) {
      const parsedToolCalls = parseHostedEditorAiToolCalls(
        artifact.toolCalls,
        declaredToolNames,
      );
      if (!parsedToolCalls.ok || parsedToolCalls.value.length === 0) {
        throw new HttpError(
          500,
          "editor_ai_result_invalid",
          "hosted editor AI result is invalid",
        );
      }
    }
    try {
      await repository.finalizeAiUsageOperation({
        operationId,
        provider: artifact.provider,
        model: artifact.model,
        status: artifact.status,
      });
    } catch {
      throw new HttpError(
        503,
        "editor_ai_accounting_unavailable",
        "hosted editor AI accounting is unavailable",
      );
    }
    if (artifact.status === "completed") {
      return success(
        {
          response: artifact.response ?? "",
          costWeight,
          ...(artifact.toolCalls ? { toolCalls: artifact.toolCalls } : {}),
        },
        request,
        env,
      );
    }
    throw new HttpError(
      artifact.httpStatus ??
        (artifact.errorCode === "editor_ai_rate_limited" ? 429 : 503),
      artifact.errorCode ?? "editor_ai_unavailable",
      artifact.errorCode === "editor_ai_rate_limited"
        ? "hosted editor AI is rate limited"
        : "hosted editor AI failed",
    );
  };

  try {
    const persisted = await readEditorAiArtifact(
      env.SCAN_BUCKET,
      artifactKey,
      declaredToolNames,
    );
    if (persisted) return await deliverArtifact(persisted);
  } catch (cause) {
    if (cause instanceof HttpError) throw cause;
    throw new HttpError(
      500,
      "editor_ai_result_invalid",
      "hosted editor AI result is invalid",
    );
  }
  const existingOperation = await repository.getAiUsageOperation(operationId);
  if (existingOperation) {
    if (existingOperation.requestHash !== requestHash) {
      throw new HttpError(
        409,
        "idempotency_key_conflict",
        "the idempotency key was already used for another request",
      );
    }
    throw new HttpError(
      existingOperation.status === "reserved" ? 409 : 503,
      existingOperation.status === "reserved"
        ? "editor_ai_in_progress"
        : "editor_ai_result_unavailable",
      existingOperation.status === "reserved"
        ? "hosted editor AI request is still in progress"
        : "hosted editor AI result is unavailable",
    );
  }

  let claim;
  try {
    claim = await repository.claimAndReserveAiUsage({
      operationId,
      scanId,
      provider: configuredProvider,
      model: configuredModel,
      requestHash,
      units: costWeight,
      buckets: usageBuckets(env),
    });
  } catch {
    throw new HttpError(
      503,
      "editor_ai_accounting_unavailable",
      "hosted editor AI accounting is unavailable",
    );
  }
  if (!claim.claimed) {
    const persisted = await readEditorAiArtifact(
      env.SCAN_BUCKET,
      artifactKey,
      declaredToolNames,
    ).catch(() => null);
    if (persisted) return deliverArtifact(persisted);
    const existing = claim.operation;
    if (!existing) {
      throw new HttpError(
        429,
        "scan_budget_exhausted",
        "Scan capacity is exhausted",
      );
    }
    if (existing.requestHash !== requestHash) {
      throw new HttpError(
        409,
        "idempotency_key_conflict",
        "the idempotency key was already used for another request",
      );
    }
    throw new HttpError(
      existing?.status === "reserved" ? 409 : 503,
      existing?.status === "reserved"
        ? "editor_ai_in_progress"
        : "editor_ai_result_unavailable",
      existing?.status === "reserved"
        ? "hosted editor AI request is still in progress"
        : "hosted editor AI result is unavailable",
    );
  }

  let result: Awaited<ReturnType<typeof runHostedAi>>;
  try {
    result = await runHostedAi(env, {
      prompt,
      context: typeof context === "string" ? context : undefined,
      ...(agent ? { agent } : {}),
    });
  } catch (cause) {
    const rateLimited = cause instanceof HostedAiError && cause.status === 429;
    const artifact: EditorAiOperationArtifact = {
      schemaVersion: "grimodex-scan/editor-ai-operation/1",
      operationId,
      requestHash,
      status: "failed",
      provider: configuredProvider,
      model: configuredModel,
      costWeight,
      httpStatus: rateLimited ? 429 : 503,
      errorCode: rateLimited
        ? "editor_ai_rate_limited"
        : "editor_ai_unavailable",
    };
    try {
      await writeEditorAiArtifact(
        env,
        repository,
        scanId,
        artifactKey,
        artifact,
      );
    } catch (artifactCause) {
      if (artifactCause instanceof HttpError) {
        await repository
          .finalizeAiUsageOperation({
            operationId,
            provider: configuredProvider,
            model: configuredModel,
            status: "failed",
          })
          .catch(() => undefined);
        throw artifactCause;
      }
      emitContentFreeObservation(undefined, {
        event: "request_failed",
        route: "/api/v1/scans/editor-ai-artifact",
        status: 503,
        code: "failure_artifact_write_failed",
      });
      throw new HttpError(
        503,
        "editor_ai_result_persistence_failed",
        "hosted editor AI result could not be persisted",
      );
    }
    await repository
      .finalizeAiUsageOperation({
        operationId,
        provider: configuredProvider,
        model: configuredModel,
        status: "failed",
      })
      .catch(() => {
        emitContentFreeObservation(undefined, {
          event: "request_failed",
          route: "/api/v1/scans/editor-ai-accounting",
          status: 503,
          code: "provider_failure_cleanup_failed",
        });
      });
    throw new HttpError(
      artifact.httpStatus ?? 503,
      artifact.errorCode ?? "editor_ai_unavailable",
      rateLimited
        ? "hosted editor AI is rate limited"
        : "hosted editor AI failed",
    );
  }

  const artifact: EditorAiOperationArtifact = {
    schemaVersion: "grimodex-scan/editor-ai-operation/1",
    operationId,
    requestHash,
    status: "completed",
    provider: result.provider,
    model: result.model,
    costWeight,
    response: result.response,
    ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
  };
  try {
    await writeEditorAiArtifact(env, repository, scanId, artifactKey, artifact);
  } catch (artifactCause) {
    if (artifactCause instanceof HttpError) {
      await repository
        .finalizeAiUsageOperation({
          operationId,
          provider: result.provider,
          model: result.model,
          status: "failed",
        })
        .catch(() => undefined);
      throw artifactCause;
    }
    emitContentFreeObservation(undefined, {
      event: "request_failed",
      route: "/api/v1/scans/editor-ai-artifact",
      status: 503,
      code: "completion_artifact_write_failed",
    });
    throw new HttpError(
      503,
      "editor_ai_result_persistence_failed",
      "hosted editor AI result could not be persisted",
    );
  }
  await repository
    .finalizeAiUsageOperation({
      operationId,
      provider: result.provider,
      model: result.model,
      status: "completed",
    })
    .catch(() => {
      emitContentFreeObservation(undefined, {
        event: "request_failed",
        route: "/api/v1/scans/editor-ai-accounting",
        status: 503,
        code: "completion_accounting_failed",
      });
    });
  return success(
    {
      response: result.response,
      costWeight,
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    },
    request,
    env,
  );
}

async function authorizedScan(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  allowDeleted = false,
) {
  const rawToken = scanTokenFromRequest(request);
  if (!rawToken)
    throw new HttpError(401, "scan_token_required", "scan token is required");
  const scan = await repository.authorizeScan(
    scanId,
    await tokenHash(rawToken, env),
  );
  if (!scan || (scan.status === "deleted" && !allowDeleted))
    throw new HttpError(404, "scan_not_found", "scan was not found");
  return scan;
}

async function authorizedEditorAiScan(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
) {
  const sessionHeader = request.headers.get("x-editor-session-token");
  if (sessionHeader === null) {
    return authorizedScan(request, env, repository, scanId);
  }
  const rawToken = sessionHeader.trim();
  if (!rawToken) {
    throw new HttpError(
      401,
      "editor_session_token_required",
      "Editor session token is required",
    );
  }
  const scan = await repository.authorizeEditorSession(
    scanId,
    await tokenHash(rawToken, env),
  );
  if (!scan) {
    throw new HttpError(404, "scan_not_found", "scan was not found");
  }
  return scan;
}

async function report(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  context?: WorkerExecutionContextLike,
): Promise<Response> {
  await enforceRateLimit(request, env, `scan-report:${scanId}`);
  const scan = await authorizedScan(request, env, repository, scanId);
  if (scan.status !== "completed" || !scan.privateReportKey)
    throw new HttpError(409, "report_not_ready", "report is not ready");
  const object = await env.SCAN_BUCKET.get(scan.privateReportKey);
  if (!object?.body)
    throw new HttpError(
      404,
      "report_not_found",
      "report artifact was not found",
    );
  const reportText = await new Response(object.body).text();
  let reportValue: unknown;
  try {
    reportValue = JSON.parse(reportText) as unknown;
  } catch {
    throw new HttpError(
      500,
      "report_invalid",
      "private report artifact is invalid",
    );
  }
  const parsed = parseScanBundle(reportValue);
  if (!parsed.ok)
    throw new HttpError(
      500,
      "report_invalid",
      "private report failed contract validation",
    );
  const feedback = await repository.getFindingFeedback(scanId);
  await emitFunnel(context, "private_report_viewed", scanId);
  return artifactResponse(
    new Response(JSON.stringify(applyFindingFeedback(parsed.value, feedback)))
      .body!,
    request,
    env,
    object.httpMetadata?.contentType ?? "application/json",
    "no-store",
  );
}

async function createEditorToken(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  context?: WorkerExecutionContextLike,
): Promise<Response> {
  await enforceRateLimit(request, env, `editor-token:${scanId}`);
  const scan = await authorizedScan(request, env, repository, scanId);
  if (scan.status !== "completed" || !scan.privateBundleKey)
    throw new HttpError(409, "seed_not_ready", "editor seed is not ready");
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + EDITOR_TOKEN_TTL_MS).toISOString();
  await repository.createEditorToken({
    tokenHash: await tokenHash(token, env),
    scanId,
    artifactKey: scan.privateBundleKey,
    expiresAt,
  });
  await emitFunnel(context, "editor_token_issued", scanId);
  return success({ token, expiresAt }, request, env, 201);
}

async function consumeEditorToken(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  token: string,
): Promise<Response> {
  const hashedToken = await tokenHash(token, env);
  const record = await repository.getEditorToken(hashedToken);
  if (!record)
    throw new HttpError(
      404,
      "editor_token_invalid",
      "editor token is invalid or already used",
    );
  const object = await env.SCAN_BUCKET.get(record.artifactKey);
  if (!object?.body)
    throw new HttpError(
      404,
      "seed_not_found",
      "editor seed artifact was not found",
    );
  let seedValue: unknown;
  try {
    seedValue = JSON.parse(await new Response(object.body).text()) as unknown;
  } catch {
    throw new HttpError(500, "seed_invalid", "editor seed artifact is invalid");
  }
  const seed = parseEditorSeed(seedValue);
  if (!seed.ok) {
    throw new HttpError(
      500,
      "seed_invalid",
      "editor seed artifact failed contract validation",
    );
  }
  const sessionToken = randomToken(32);
  const sessionTokenHash = await tokenHash(sessionToken, env);
  const sessionExpiresAt = new Date(
    Date.now() + editorSessionTtlMs(env),
  ).toISOString();
  await repository.createEditorSession({
    tokenHash: sessionTokenHash,
    scanId: record.scanId,
    expiresAt: sessionExpiresAt,
  });
  const consumed = await repository.consumeEditorToken(hashedToken);
  if (!consumed) {
    await repository
      .revokeEditorSession(sessionTokenHash)
      .catch(() => undefined);
    throw new HttpError(
      404,
      "editor_token_invalid",
      "editor token is invalid or already used",
    );
  }
  return success(
    {
      schemaVersion: EDITOR_HANDOFF_SCHEMA_VERSION,
      seed: seed.value,
      hostedAiSession: {
        scanId: consumed.scanId,
        token: sessionToken,
        expiresAt: sessionExpiresAt,
      },
    },
    request,
    env,
  );
}

async function publishPublicReport(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  context?: WorkerExecutionContextLike,
): Promise<Response> {
  await enforceRateLimit(request, env, `public-report-publish:${scanId}`);
  const scan = await authorizedScan(request, env, repository, scanId);
  if (scan.status !== "completed" || !scan.privateReportKey) {
    throw new HttpError(409, "report_not_ready", "report is not ready");
  }
  const body = await parseJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(
      400,
      "invalid_body",
      "publication body must be an object",
    );
  }
  const authorConfirmedAt = (body as Record<string, unknown>).authorConfirmedAt;
  if (
    typeof authorConfirmedAt !== "string" ||
    !authorConfirmedAt.trim() ||
    authorConfirmedAt.length > PUBLIC_REPORT_AUTHOR_CONFIRMATION_MAX_LENGTH ||
    !Number.isFinite(Date.parse(authorConfirmedAt))
  ) {
    throw new HttpError(
      400,
      "author_confirmation_required",
      "author confirmation timestamp is required",
    );
  }
  const privateObject = await env.SCAN_BUCKET.get(scan.privateReportKey);
  if (!privateObject?.body)
    throw new HttpError(
      404,
      "report_not_found",
      "report artifact was not found",
    );
  let privateValue: unknown;
  try {
    privateValue = JSON.parse(
      await new Response(privateObject.body).text(),
    ) as unknown;
  } catch {
    throw new HttpError(
      500,
      "report_invalid",
      "private report artifact is invalid",
    );
  }
  const parsed = parseScanBundle(privateValue);
  if (!parsed.ok)
    throw new HttpError(
      500,
      "report_invalid",
      "private report failed contract validation",
    );
  const feedback = await repository.getFindingFeedback(scanId);
  const publicReport = toPublicReport(
    applyFindingFeedback(parsed.value, feedback),
    { authorConfirmedAt },
  );
  const previous = await repository.getPublicReportByScanId(scanId);
  const publicationId = crypto.randomUUID();
  const artifactKey = publicReportArtifactKey(scanId, publicationId);
  const deleteRegisteredArtifact = async (): Promise<boolean> => {
    try {
      await env.SCAN_BUCKET.delete(artifactKey);
      await repository.forgetPublicReportArtifact(scanId, artifactKey);
      return true;
    } catch {
      // Keep the registry row whenever R2 deletion is uncertain. The bounded
      // scheduled reaper can then retry without losing track of the object.
      return false;
    }
  };
  if (!(await repository.registerPublicReportArtifact(scanId, artifactKey))) {
    throw new HttpError(409, "report_not_ready", "report is not ready");
  }
  try {
    await env.SCAN_BUCKET.put(artifactKey, JSON.stringify(publicReport), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { schemaVersion: publicReport.schemaVersion },
    });
  } catch (cause) {
    await deleteRegisteredArtifact();
    throw cause;
  }
  const latest = await repository.getScan(scanId);
  if (!latest || latest.status === "deleted") {
    await deleteRegisteredArtifact();
    throw new HttpError(404, "scan_not_found", "scan was not found");
  }
  let published: Awaited<ReturnType<ScanRepository["publishPublicReport"]>>;
  try {
    published = await repository.publishPublicReport({
      id: publicationId,
      scanId,
      artifactKey,
      authorConfirmedAt,
    });
  } catch (cause) {
    const recovered = await repository
      .getPublicReportByScanId(scanId)
      .catch(() => undefined);
    if (recovered?.artifactKey === artifactKey) published = recovered;
    else {
      // When recovery itself is unavailable, keep the immutable object: the
      // D1 transaction may have committed before its response was lost.
      if (recovered !== undefined) await deleteRegisteredArtifact();
      throw cause;
    }
  }
  if (!published) {
    await deleteRegisteredArtifact();
    throw new HttpError(404, "scan_not_found", "scan was not found");
  }
  const obsoleteKeys = new Set(
    await repository.listObsoletePublicReportArtifacts(scanId).catch(() => []),
  );
  if (previous?.artifactKey && previous.artifactKey !== published.artifactKey) {
    obsoleteKeys.add(previous.artifactKey);
  }
  if (published.artifactKey !== artifactKey) obsoleteKeys.add(artifactKey);
  for (const obsoleteKey of obsoleteKeys) {
    if (obsoleteKey === published.artifactKey) continue;
    try {
      await env.SCAN_BUCKET.delete(obsoleteKey);
      await repository.forgetPublicReportArtifact(scanId, obsoleteKey);
    } catch {
      // The next publish or scheduled prefix cleanup retries orphan removal.
    }
  }
  await emitFunnel(context, "public_report_published", scanId);
  return success(
    { publicReportId: published.id, status: published.status },
    request,
    env,
    201,
  );
}

async function unpublishPublicReport(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  context?: WorkerExecutionContextLike,
): Promise<Response> {
  await authorizedScan(request, env, repository, scanId);
  await repository.unpublishPublicReport(scanId);
  const objectKeys =
    await repository.listUnpublishedPublicReportArtifacts(scanId);
  for (const objectKey of objectKeys) {
    try {
      await env.SCAN_BUCKET.delete(objectKey);
      await repository.forgetPublicReportArtifact(scanId, objectKey);
    } catch {
      // Scheduled retention retries objects that remain registered/in-prefix.
    }
  }
  await emitFunnel(context, "public_report_unpublished", scanId);
  return success({ scanId, status: "unpublished" }, request, env);
}

async function publicReport(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  reportId: string,
  context?: WorkerExecutionContextLike,
): Promise<Response> {
  await enforceRateLimit(request, env, `public-report:${reportId}`);
  const record = await repository.getPublicReportById(reportId);
  if (!record || record.status !== "published") {
    throw new HttpError(
      404,
      "public_report_not_found",
      "public report was not found",
    );
  }
  const object = await env.SCAN_BUCKET.get(record.artifactKey);
  if (!object?.body)
    throw new HttpError(
      404,
      "public_report_not_found",
      "public report artifact was not found",
    );
  if (object.size > SCAN_LIMITS.maxBundleSerializedLength) {
    throw new HttpError(
      500,
      "public_report_invalid",
      "public report artifact exceeds the contract limit",
    );
  }
  let publicValue: unknown;
  try {
    publicValue = JSON.parse(await new Response(object.body).text()) as unknown;
  } catch {
    throw new HttpError(
      500,
      "public_report_invalid",
      "public report artifact is invalid",
    );
  }
  const parsed = parsePublicReport(publicValue);
  if (!parsed.ok) {
    throw new HttpError(
      500,
      "public_report_invalid",
      "public report failed contract validation",
    );
  }
  await emitFunnel(context, "public_report_viewed", reportId);
  return success(parsed.value, request, env);
}

async function deletePublicReport(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  reportId: string,
): Promise<Response> {
  const existing = await repository.getPublicReportById(reportId);
  if (!existing)
    throw new HttpError(
      404,
      "public_report_not_found",
      "public report was not found",
    );
  await authorizedScan(request, env, repository, existing.scanId);
  const unpublished = await repository.unpublishPublicReportById(reportId);
  if (unpublished) {
    const objectKeys = await repository.listUnpublishedPublicReportArtifacts(
      unpublished.scanId,
    );
    for (const objectKey of objectKeys) {
      try {
        await env.SCAN_BUCKET.delete(objectKey);
        await repository.forgetPublicReportArtifact(
          unpublished.scanId,
          objectKey,
        );
      } catch {
        // Scheduled retention retries objects that remain registered/in-prefix.
      }
    }
  }
  return success(
    { publicReportId: reportId, status: "unpublished" },
    request,
    env,
  );
}

async function createAbuseReport(
  request: Request,
  env: ScanEnv,
  repository: ScanRepository,
  reportId: string,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !isAllowedOrigin(origin, env)) {
    throw new HttpError(
      403,
      "origin_not_allowed",
      "request origin is not allowed",
    );
  }
  const contentType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(
      415,
      "json_content_type_required",
      "abuse reports require application/json",
    );
  }
  await enforceRateLimit(request, env, `public-abuse:${reportId}`);
  const report = await repository.getPublicReportById(reportId);
  if (!report || report.status !== "published") {
    throw new HttpError(
      404,
      "public_report_not_found",
      "public report was not found",
    );
  }
  const ip = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const minute = Math.floor(Date.now() / 60_000);
  const abuseBucket = await sha256Hex(
    `${secretFor(env)}\u0000public-abuse\u0000${reportId}\u0000${ip}\u0000${minute}`,
  );
  if (!(await repository.consumeAbuseRateLimit(abuseBucket, 3))) {
    throw new HttpError(
      429,
      "abuse_rate_limited",
      "abuse report rate limit exceeded",
    );
  }
  const value = await parseJson(request);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(
      400,
      "invalid_body",
      "abuse report body must be an object",
    );
  }
  const reason = (value as Record<string, unknown>).reason;
  if (
    typeof reason !== "string" ||
    reason.trim().length === 0 ||
    reason.trim().length > 1_000
  ) {
    throw new HttpError(
      400,
      "invalid_reason",
      "abuse report reason is invalid",
    );
  }
  await repository.createPublicAbuseReport({
    id: crypto.randomUUID(),
    publicReportId: reportId,
    reason: reason.trim(),
  });
  return success({ accepted: true }, request, env, 202);
}

export async function handleRequest(
  request: Request,
  env: ScanEnv,
  ctx?: WorkerExecutionContextLike,
): Promise<Response> {
  const startedAt = Date.now();
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: responseHeaders(origin, env),
    });
  }
  const url = new URL(request.url);
  const segments = idSegments(url.pathname);
  const repository = new ScanRepository(env.DB);
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return success(
        {
          ok: true,
          service: "grimodex-scan",
          acceptingNewJobs: isFeatureEnabled(
            env.SCAN_ACCEPTING_NEW_JOBS,
            false,
          ),
        },
        request,
        env,
      );
    }
    if (
      request.method === "GET" &&
      segments[0] === "api" &&
      segments[1] === "v1" &&
      segments[2] === "ai-disclosures" &&
      segments.length === 4 &&
      (segments[3] === "scan" || segments[3] === "hosted-editor")
    ) {
      return await aiDisclosure(request, env, segments[3]);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/upload-intents"
    ) {
      return await uploadIntent(request, env, repository, ctx);
    }
    if (
      segments[0] === "api" &&
      segments[1] === "v1" &&
      segments[2] === "uploads" &&
      segments[3]
    ) {
      const uploadId = segments[3];
      if (request.method === "PUT" && segments.length === 4)
        return await uploadSource(request, env, repository, uploadId, ctx);
      if (request.method === "POST" && segments[4] === "complete")
        return await completeUpload(request, env, repository, uploadId, ctx);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/scans")
      return await createScan(request, env, repository, ctx);
    if (
      segments[0] === "api" &&
      segments[1] === "v1" &&
      segments[2] === "scans" &&
      segments[3]
    ) {
      const scanId = segments[3];
      if (request.method === "GET" && segments.length === 4) {
        await enforceRateLimit(request, env, `scan-status:${scanId}`);
        const scan = await authorizedScan(request, env, repository, scanId);
        await emitFunnel(ctx, "scan_status_viewed", scanId);
        return success(
          {
            scanId: scan.id,
            status: scan.status,
            mode: scan.mode,
            updatedAt: scan.updatedAt,
          },
          request,
          env,
        );
      }
      if (request.method === "POST" && segments[4] === "cancel") {
        await authorizedScan(request, env, repository, scanId);
        const scan = await repository.requestCancel(scanId);
        if (!scan)
          throw new HttpError(404, "scan_not_found", "scan was not found");
        await emitFunnel(ctx, "scan_cancelled", scanId);
        return success({ scanId: scan.id, status: scan.status }, request, env);
      }
      if (request.method === "DELETE" && segments.length === 4) {
        await authorizedScan(request, env, repository, scanId, true);
        const scan = await repository.deleteScan(scanId);
        if (!scan)
          throw new HttpError(404, "scan_not_found", "scan was not found");
        if (scan.status !== "deleted") {
          throw new HttpError(
            409,
            "scan_delete_conflict",
            "scan deletion did not reach a terminal state",
          );
        }
        const purge = await purgeDeletedScan(env, repository, scanId);
        await emitFunnel(ctx, "scan_deleted", scanId);
        return success(
          {
            scanId: scan.id,
            status: scan.status,
            cleanup: purge.cleanupPending ? "pending" : "completed",
          },
          request,
          env,
        );
      }
      if (request.method === "GET" && segments[4] === "report")
        return await report(request, env, repository, scanId, ctx);
      if (request.method === "POST" && segments[4] === "editor-tokens")
        return await createEditorToken(request, env, repository, scanId, ctx);
      if (request.method === "POST" && segments[4] === "editor-ai")
        return await editorAi(request, env, repository, scanId);
      if (
        request.method === "POST" &&
        segments[4] === "public-report" &&
        segments.length === 5
      ) {
        return await publishPublicReport(request, env, repository, scanId, ctx);
      }
      if (
        request.method === "POST" &&
        segments[4] === "public-report" &&
        segments[5] === "unpublish"
      ) {
        return await unpublishPublicReport(
          request,
          env,
          repository,
          scanId,
          ctx,
        );
      }
      if (request.method === "POST" && segments[4] === "feedback") {
        await enforceRateLimit(request, env, `scan-feedback:${scanId}`);
        const scan = await authorizedScan(request, env, repository, scanId);
        if (scan.status !== "completed" || !scan.privateReportKey)
          throw new HttpError(
            409,
            "report_not_ready",
            "feedback requires a completed report",
          );
        const value = await parseJson(request);
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new HttpError(
            400,
            "invalid_body",
            "feedback body must be an object",
          );
        const body = value as Record<string, unknown>;
        if (
          typeof body.findingId !== "string" ||
          body.findingId.length > SCAN_LIMITS.maxIdLength ||
          !ID_PATTERNS.finding.test(body.findingId) ||
          (body.status !== "intentional" && body.status !== "rejected")
        )
          throw new HttpError(
            400,
            "invalid_feedback",
            "findingId and status are required",
          );
        const bundle = await readPrivateScanBundle(env, scan.privateReportKey);
        if (!bundle.findings.some((finding) => finding.id === body.findingId))
          throw new HttpError(
            404,
            "finding_not_found",
            "finding was not found in this scan",
          );
        await repository.saveFindingFeedback({
          scanId,
          findingId: body.findingId,
          status: body.status,
        });
        return success({ ok: true }, request, env, 201);
      }
    }
    if (
      request.method === "GET" &&
      segments[0] === "api" &&
      segments[1] === "v1" &&
      segments[2] === "public-reports" &&
      segments[3]
    ) {
      return await publicReport(request, env, repository, segments[3], ctx);
    }
    if (
      segments[0] === "api" &&
      segments[1] === "v1" &&
      segments[2] === "public-reports" &&
      segments[3]
    ) {
      if (request.method === "DELETE" && segments.length === 4) {
        return await deletePublicReport(request, env, repository, segments[3]);
      }
      if (request.method === "POST" && segments[4] === "abuse-reports") {
        return await createAbuseReport(request, env, repository, segments[3]);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/editor-seeds") {
      await enforceRateLimit(request, env, "editor-seed");
      const editorToken = tokenFromRequest(request);
      if (!editorToken)
        throw new HttpError(
          401,
          "editor_token_required",
          "editor token is required",
        );
      return await consumeEditorToken(request, env, repository, editorToken);
    }
    throw new HttpError(404, "not_found", "route was not found");
  } catch (cause) {
    if (cause instanceof HttpError) {
      emitContentFreeObservation(ctx, {
        event: "request_rejected",
        route: routeFamily(url.pathname),
        status: cause.status,
        code: cause.code,
        durationMs: Date.now() - startedAt,
      });
      return json(
        { error: { code: cause.code, message: cause.message } },
        cause.status,
        request,
        env,
      );
    }
    emitContentFreeObservation(ctx, {
      event: "request_failed",
      route: routeFamily(url.pathname),
      status: 500,
      code: "internal_error",
      durationMs: Date.now() - startedAt,
    });
    return json(
      {
        error: {
          code: "internal_error",
          message: "request could not be completed",
        },
      },
      500,
      request,
      env,
    );
  }
}
