import { ScanApiError } from "../api/scanApiClient";
import { scanMessages } from "./scanMessages";
import type { ScanLocale } from "./scanLocale";

export type ScanErrorKind =
  | "network"
  | "unavailable"
  | "rateLimited"
  | "invalidSource"
  | "unauthorized"
  | "generic";

const AUTHORIZATION_CODES = new Set([
  "ai_consent_required",
  "full_access_required",
  "scan_token_required",
  "turnstile_required",
  "unauthorized",
]);

const INVALID_SOURCE_CODES = new Set([
  "content_type_not_allowed",
  "invalid_source_language",
  "source_too_large",
  "unsupported_media_type",
  "upload_size_mismatch",
]);

export function classifyScanError(cause: unknown): ScanErrorKind {
  if (cause instanceof ScanApiError) {
    if (
      cause.status === 401 ||
      cause.status === 403 ||
      (cause.code !== undefined && AUTHORIZATION_CODES.has(cause.code))
    ) {
      return "unauthorized";
    }
    if (cause.status === 408 || cause.status === 425 || cause.status === 429) {
      return "rateLimited";
    }
    if (
      cause.status === 413 ||
      cause.status === 415 ||
      cause.status === 422 ||
      (cause.code !== undefined && INVALID_SOURCE_CODES.has(cause.code))
    ) {
      return "invalidSource";
    }
    if (cause.status >= 500) return "unavailable";
    return "generic";
  }
  if (
    cause instanceof TypeError ||
    (cause instanceof Error && cause.name === "AbortError")
  ) {
    return "network";
  }
  return "generic";
}

export function scanErrorMessageForKind(
  kind: ScanErrorKind,
  locale: ScanLocale,
): string {
  return scanMessages(locale).errors[kind];
}

export function scanErrorMessage(cause: unknown, locale: ScanLocale): string {
  return scanErrorMessageForKind(classifyScanError(cause), locale);
}
