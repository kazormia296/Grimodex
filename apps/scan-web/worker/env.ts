export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

export interface R2ObjectLike {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  etag?: string;
}

export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list?(options?: { prefix?: string; cursor?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

export interface ScanWorkflowBinding {
  create(input: { id: string; params: { scanId: string } }): Promise<unknown>;
}

export interface RateLimiterBindingLike {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

// Cloudflare deprecated the former Llama 3.1 default on 2026-05-30. Keep the
// runtime fallback on an active, function-calling model while still allowing
// every environment to override it explicitly.
export const DEFAULT_SCAN_AI_MODEL = "@cf/zai-org/glm-4.7-flash";

export interface WorkersAiBindingLike {
  run(
    model: string,
    input: {
      messages: unknown[];
      tools?: Array<Record<string, unknown>>;
      tool_choice?: "auto";
      max_completion_tokens?: number;
    },
  ): Promise<unknown>;
}

export interface ScanEnv {
  DB: D1DatabaseLike;
  SCAN_BUCKET: R2BucketLike;
  SCAN_WORKFLOW?: ScanWorkflowBinding;
  AI?: WorkersAiBindingLike;
  SCAN_AI_MODEL?: string;
  SCAN_FRONTIER_MODEL?: string;
  SCAN_ACCEPTING_NEW_JOBS?: string;
  SCAN_WORKERS_AI_ENABLED?: string;
  SCAN_FRONTIER_ENABLED?: string;
  SCAN_EDITOR_AI_ENABLED?: string;
  SCAN_EDITOR_SESSION_TTL_HOURS?: string;
  SCAN_DAILY_LIMIT_UNITS?: string;
  SCAN_MONTHLY_LIMIT_UNITS?: string;
  SCAN_MAX_ACTIVE_JOBS?: string;
  SCAN_AI_PROVIDER?: "workers-ai" | "ai-gateway" | "openrouter";
  SCAN_FRONTIER_PROVIDER?: "workers-ai" | "ai-gateway" | "openrouter";
  SCAN_AI_GATEWAY_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  OPENROUTER_URL?: string;
  OPENROUTER_API_KEY?: string;
  SCAN_RETENTION_DAYS?: string;
  SCAN_SOURCE_RETENTION_DAYS?: string;
  SCAN_UPLOAD_RETENTION_MINUTES?: string;
  SCAN_TURNSTILE_REQUIRED?: string;
  TURNSTILE_SECRET_KEY?: string;
  RATE_LIMITER?: RateLimiterBindingLike;
  ALLOWED_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
  SCAN_ENVIRONMENT?: "development" | "staging" | "production";
  SCAN_FULL_ACCESS_SECRET?: string;
  MAX_UPLOAD_BYTES?: string;
  UPLOAD_TOKEN_SECRET?: string;
}

export interface WorkerExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
