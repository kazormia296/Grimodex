import {
  CLOUD_CONTENT_POLICY_ACK_HEADER,
  CLOUD_CONTENT_POLICY_VERSION,
  parseAccessSession,
  parseAiDataDisclosure,
  type AccessSessionV1,
  type AiDataDisclosureRoute,
  type AiDataDisclosureV1,
  type ScanBundleV1,
} from "@grimodex/scan-contract";

export type ScanMode = "quick" | "full";
export type ScanInterfaceLocale = "ja" | "en";
export type ScanSourceLanguagePreference = "auto" | "ja" | "en";
export type ScanStatus =
  | "created"
  | "uploading"
  | "queued"
  | "validating"
  | "chunking"
  | "extracting"
  | "merging"
  | "adjudicating"
  | "reporting"
  | "completed"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "expired"
  | "deleted";

export interface ScanApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Short-lived Turnstile token obtained from the visible widget. */
  turnstileToken?: string;
  /** Short-lived Full Scan entitlement supplied by the authenticated host. */
  fullAccessToken?: string;
}

export interface UploadIntent {
  uploadId: string;
  uploadUrl: string;
  uploadToken: string;
  expiresAt: string;
}

export interface UploadIntentInput {
  filename: string;
  contentType: string;
  size: number;
  consentId: string;
}

export interface EditorToken {
  token: string;
  expiresAt: string;
}

export interface ScanHandle {
  scanId: string;
  scanToken: string;
  mode: ScanMode;
}

export interface ScanStatusResponse {
  scanId: string;
  status: ScanStatus;
  mode: ScanMode;
  updatedAt: string;
}

export interface ScanDeleteResponse {
  scanId: string;
  status: "deleted";
  cleanup: "completed" | "pending";
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

const SCAN_CREATE_ATTEMPTS = 3;

export class ScanApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ScanApiError";
  }
}

export class ScanAuthenticationRequiredError extends Error {
  constructor(message = "A Grimodex Scan account session is required") {
    super(message);
    this.name = "ScanAuthenticationRequiredError";
  }
}

class InvalidScanCreateResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScanCreateResponseError";
  }
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertConsentId(consentId: unknown): asserts consentId is string {
  if (typeof consentId !== "string" || consentId.trim().length === 0) {
    throw new Error("AI data consent is required before uploading a source");
  }
}

function parseScanDeleteResponse(
  value: unknown,
  expectedScanId: string,
): ScanDeleteResponse {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).scanId === expectedScanId &&
    (value as Record<string, unknown>).status === "deleted" &&
    ((value as Record<string, unknown>).cleanup === "completed" ||
      (value as Record<string, unknown>).cleanup === "pending")
  ) {
    return value as ScanDeleteResponse;
  }
  throw new Error("Scan deletion response is invalid");
}

async function responseError(response: Response): Promise<ScanApiError> {
  let message = `Scan request failed (${response.status})`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as ErrorBody;
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // Keep the status-only message for non-JSON proxy errors.
  }
  return new ScanApiError(response.status, message, code);
}

function isRetryablePollingError(cause: unknown): boolean {
  if (!(cause instanceof ScanApiError)) return true;
  return (
    cause.status === 408 ||
    cause.status === 425 ||
    cause.status === 429 ||
    cause.status >= 500
  );
}

function isRetryableCreateError(cause: unknown): boolean {
  if (cause instanceof InvalidScanCreateResponseError) return false;
  return isRetryablePollingError(cause);
}

function randomScanToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function assertMatchingScanHandle(
  response: unknown,
  expected: ScanHandle,
): void {
  const candidate =
    typeof response === "object" && response !== null
      ? (response as Partial<ScanHandle>)
      : null;
  if (
    candidate?.scanId !== expected.scanId ||
    candidate.scanToken !== expected.scanToken ||
    candidate.mode !== expected.mode
  ) {
    throw new InvalidScanCreateResponseError(
      "Scan create response did not match the requested handle",
    );
  }
}

export class ScanApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly turnstileToken?: string;
  private readonly fullAccessToken?: string;

  constructor(options: ScanApiClientOptions) {
    this.baseUrl = trimBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.turnstileToken = options.turnstileToken;
    this.fullAccessToken = options.fullAccessToken;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
      ...init,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as T;
  }

  async getAccountSession(): Promise<AccessSessionV1> {
    const response = await this.fetchImpl(this.url("/api/v1/session"), {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      throw new ScanAuthenticationRequiredError();
    }
    if (!response.ok) throw await responseError(response);
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
    ) {
      throw new ScanAuthenticationRequiredError();
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ScanAuthenticationRequiredError();
    }
    const parsed = parseAccessSession(payload);
    if (!parsed.ok) throw new ScanAuthenticationRequiredError();
    return parsed.value;
  }

  accountLoginUrl(returnTo: string): string {
    const query = new URLSearchParams({ return_to: returnTo }).toString();
    return this.url(`/api/v1/session?${query}`);
  }

  accountLogoutUrl(): string {
    return this.url("/cdn-cgi/access/logout");
  }

  async createUploadIntent(input: UploadIntentInput): Promise<UploadIntent> {
    assertConsentId(input.consentId);
    const { consentId, ...upload } = input;
    const body = {
      ...upload,
      ...(this.turnstileToken ? { turnstileToken: this.turnstileToken } : {}),
    };
    return this.json<UploadIntent>("/api/v1/upload-intents", {
      method: "POST",
      headers: {
        "x-ai-consent-id": consentId,
        [CLOUD_CONTENT_POLICY_ACK_HEADER]: CLOUD_CONTENT_POLICY_VERSION,
      },
      body: JSON.stringify(body),
    });
  }

  async getAiDisclosure(
    route: AiDataDisclosureRoute,
    locale?: ScanInterfaceLocale,
  ): Promise<AiDataDisclosureV1> {
    const query = locale
      ? `?${new URLSearchParams({ locale }).toString()}`
      : "";
    const disclosure = await this.json<unknown>(
      `/api/v1/ai-disclosures/${encodeURIComponent(route)}${query}`,
      { cache: "no-store" },
    );
    const parsed = parseAiDataDisclosure(disclosure);
    if (!parsed.ok) {
      throw new Error("AI data disclosure response is invalid");
    }
    return parsed.value;
  }

  async uploadSource(
    file: Blob & { name?: string },
    mode: ScanMode,
    consentId: string,
    sourceLanguage: ScanSourceLanguagePreference = "auto",
  ): Promise<ScanHandle> {
    const filename = file.name ?? "source.txt";
    const contentType = file.type || "application/octet-stream";
    const intent = await this.createUploadIntent({
      filename,
      contentType,
      size: file.size,
      consentId,
    });
    const uploadResponse = await this.fetchImpl(intent.uploadUrl, {
      method: "PUT",
      credentials: "include",
      headers: {
        "content-type": contentType,
        "x-upload-token": intent.uploadToken,
        "x-scan-source-language": sourceLanguage,
      },
      body: file,
    });
    if (!uploadResponse.ok) throw await responseError(uploadResponse);
    await this.json(
      `/api/v1/uploads/${encodeURIComponent(intent.uploadId)}/complete`,
      {
        method: "POST",
        headers: { "x-upload-token": intent.uploadToken },
      },
    );
    return this.createScan(intent.uploadId, intent.uploadToken, mode);
  }

  private async createScan(
    uploadId: string,
    uploadToken: string,
    mode: ScanMode,
  ): Promise<ScanHandle> {
    const handle: ScanHandle = {
      scanId: crypto.randomUUID(),
      scanToken: randomScanToken(),
      mode,
    };
    const body = JSON.stringify({ uploadId, ...handle });
    const headers = {
      "x-upload-token": uploadToken,
      ...(mode === "full" && this.fullAccessToken
        ? { "x-scan-full-access": this.fullAccessToken }
        : {}),
    };
    let lastFailure: unknown;
    for (let attempt = 0; attempt < SCAN_CREATE_ATTEMPTS; attempt += 1) {
      try {
        const created = await this.json<unknown>("/api/v1/scans", {
          method: "POST",
          body,
          headers,
        });
        assertMatchingScanHandle(created, handle);
        return handle;
      } catch (cause) {
        if (!isRetryableCreateError(cause)) throw cause;
        lastFailure = cause;
        if (attempt + 1 < SCAN_CREATE_ATTEMPTS) {
          await this.sleep(250 * 2 ** attempt);
        }
      }
    }

    try {
      const status = await this.getStatus(handle);
      if (status.scanId !== handle.scanId || status.mode !== handle.mode) {
        throw new InvalidScanCreateResponseError(
          "Scan status response did not match the requested handle",
        );
      }
      return handle;
    } catch (cause) {
      if (cause instanceof InvalidScanCreateResponseError) throw cause;
      throw lastFailure;
    }
  }

  getStatus(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
  ): Promise<ScanStatusResponse> {
    return this.json<ScanStatusResponse>(
      `/api/v1/scans/${encodeURIComponent(handle.scanId)}`,
      {
        headers: { "x-scan-token": handle.scanToken },
      },
    );
  }

  async waitForCompletion(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
    options: { timeoutMs?: number } = {},
  ): Promise<ScanStatusResponse> {
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    const startedAt = Date.now();
    let delay = 2000;
    let lastError: unknown;
    while (Date.now() - startedAt <= timeoutMs) {
      try {
        const status = await this.getStatus(handle);
        if (
          status.status === "completed" ||
          status.status === "failed" ||
          status.status === "cancelled" ||
          status.status === "expired"
        ) {
          return status;
        }
        lastError = undefined;
      } catch (cause) {
        if (!isRetryablePollingError(cause)) throw cause;
        lastError = cause;
      }
      await this.sleep(delay);
      delay = Math.min(5000, Math.round(delay * 1.25));
    }
    if (lastError instanceof Error) {
      throw new Error(`Scan polling timed out: ${lastError.message}`, {
        cause: lastError,
      });
    }
    throw new Error("Scan polling timed out");
  }

  async getReport(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
  ): Promise<ScanBundleV1> {
    return this.json<ScanBundleV1>(
      `/api/v1/scans/${encodeURIComponent(handle.scanId)}/report`,
      {
        headers: { "x-scan-token": handle.scanToken },
      },
    );
  }

  async createEditorToken(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
  ): Promise<EditorToken> {
    return this.json<EditorToken>(
      `/api/v1/scans/${encodeURIComponent(handle.scanId)}/editor-tokens`,
      { method: "POST", headers: { "x-scan-token": handle.scanToken } },
    );
  }

  async sendFindingFeedback(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
    findingId: string,
    status: "intentional" | "rejected",
  ): Promise<void> {
    await this.json(
      `/api/v1/scans/${encodeURIComponent(handle.scanId)}/feedback`,
      {
        method: "POST",
        headers: { "x-scan-token": handle.scanToken },
        body: JSON.stringify({ findingId, status }),
      },
    );
  }

  async publishPublicReport(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
    authorConfirmedAt = new Date().toISOString(),
  ): Promise<{ publicReportId: string; status: "published" }> {
    return this.json(
      `/api/v1/scans/${encodeURIComponent(handle.scanId)}/public-report`,
      {
        method: "POST",
        headers: { "x-scan-token": handle.scanToken },
        body: JSON.stringify({ authorConfirmedAt }),
      },
    );
  }

  async unpublishPublicReport(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
  ): Promise<void> {
    await this.json(
      `/api/v1/scans/${encodeURIComponent(handle.scanId)}/public-report/unpublish`,
      {
        method: "POST",
        headers: { "x-scan-token": handle.scanToken },
      },
    );
  }

  getPublicReport<T = unknown>(publicReportId: string): Promise<T> {
    return this.json<T>(
      `/api/v1/public-reports/${encodeURIComponent(publicReportId)}`,
      { cache: "no-store" },
    );
  }

  async reportPublicAbuse(
    publicReportId: string,
    reason: string,
  ): Promise<void> {
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0 || normalizedReason.length > 1_000) {
      throw new Error(
        "Public abuse report reason must be 1 to 1000 characters",
      );
    }
    await this.json(
      `/api/v1/public-reports/${encodeURIComponent(publicReportId)}/abuse-reports`,
      {
        method: "POST",
        body: JSON.stringify({ reason: normalizedReason }),
      },
    );
  }

  async deletePublicReport(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
    publicReportId: string,
  ): Promise<void> {
    await this.json(
      `/api/v1/public-reports/${encodeURIComponent(publicReportId)}`,
      {
        method: "DELETE",
        headers: { "x-scan-token": handle.scanToken },
      },
    );
  }

  async cancel(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
  ): Promise<void> {
    await this.json(
      `/api/v1/scans/${encodeURIComponent(handle.scanId)}/cancel`,
      {
        method: "POST",
        headers: { "x-scan-token": handle.scanToken },
      },
    );
  }

  async delete(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
  ): Promise<ScanDeleteResponse> {
    const result = await this.json<unknown>(
      `/api/v1/scans/${encodeURIComponent(handle.scanId)}`,
      {
        method: "DELETE",
        headers: { "x-scan-token": handle.scanToken },
      },
    );
    return parseScanDeleteResponse(result, handle.scanId);
  }
}
