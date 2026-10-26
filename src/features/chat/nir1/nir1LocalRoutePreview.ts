import type { AiSettings } from "@/features/chat/types";
import { resolveActiveOpenaiCompatibleEndpoint } from "@/features/chat/types";

/**
 * The destination and model the disclosure shows (DD-1c, C9; K5/3 開示の
 * 試験 (2), DF+-b の 5). It reads the saved AI settings with the same rules as
 * Native's route resolution (`nir1_prepared_request.rs`
 * `resolve_supported_local_chat_route`, `parse_loopback_chat_completions_endpoint`
 * and `model_name_is_valid`): an OpenAI-compatible provider, an endpoint of the
 * IP literal `127.0.0.1` or `[::1]` with a port and `/v1`, and a model name of
 * 1 to 256 bytes without surrounding space or control characters. It only
 * shapes the display; Native resolves the route when a generation starts.
 */

export type Nir1LocalRouteUnusable =
  | "provider"
  | "no-endpoint"
  | "not-loopback"
  | "model-invalid";

export type Nir1LocalRoutePreview =
  | {
      readonly status: "usable";
      readonly destination: string;
      readonly model: string;
    }
  | { readonly status: "unusable"; readonly reason: Nir1LocalRouteUnusable };

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/v1\/?$/u;
const MAX_MODEL_BYTES = 256;
/** Line／paragraph separators and bidi controls `model_name_is_valid` refuses. */
const MODEL_REFUSED_CODES: ReadonlySet<number> = new Set([
  0x2028, 0x2029, 0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d,
  0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

export function isNir1LocalModelName(model: string): boolean {
  const bytes = new TextEncoder().encode(model).byteLength;
  if (bytes < 1 || bytes > MAX_MODEL_BYTES || model.trim() !== model) {
    return false;
  }
  for (const char of model) {
    const code = char.codePointAt(0) ?? 0;
    if (isControl(code) || MODEL_REFUSED_CODES.has(code)) return false;
  }
  return true;
}

/** The destination URL for a loopback IP literal base URL, or null. */
export function nir1LocalDestinationOf(baseUrl: string): string | null {
  const match = LOOPBACK.exec(baseUrl);
  if (!match || Number(match[2]) > 65535) return null;
  return `http://${match[1]}:${match[2]}/v1/chat/completions`;
}

export function nir1LocalRoutePreview(
  settings: Pick<
    AiSettings,
    | "provider"
    | "model"
    | "openaiCompatible"
    | "openaiCompatibleEndpoints"
    | "activeOpenaiCompatibleEndpointId"
  > | null,
): Nir1LocalRoutePreview {
  if (!settings || settings.provider !== "openai-compatible") {
    return { status: "unusable", reason: "provider" };
  }
  const endpoint = resolveActiveOpenaiCompatibleEndpoint(settings);
  if (!endpoint) return { status: "unusable", reason: "no-endpoint" };
  const destination = nir1LocalDestinationOf(endpoint.baseUrl);
  if (destination === null) {
    return { status: "unusable", reason: "not-loopback" };
  }
  if (!isNir1LocalModelName(settings.model)) {
    return { status: "unusable", reason: "model-invalid" };
  }
  return { status: "usable", destination, model: settings.model };
}
