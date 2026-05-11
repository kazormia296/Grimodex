/**
 * canonicalize.ts — 決定的 JSON 直列化と input_hash 計算。
 * 設計書 §整合性チェック詳細設計 §input_hash を参照。
 */

/** Recursively sort object keys for deterministic JSON (arrays preserve order). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Deterministic JSON stringify: keys sorted, arrays in original order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Normalize text for input_hash computation.
 * CRLF→LF, trailing whitespace, consecutive spaces→single, trim.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface InputHashPayload {
  promptVersion: string;
  model: string;
  effectType: string;
  codex?: unknown;
  scene: string;
  scope: string;
}

/**
 * Compute sha256 input_hash for a post-effect run.
 * Phase ID は入力に含めない（解決後の値が payload に既に反映）。
 */
export async function computeInputHash(
  payload: InputHashPayload,
): Promise<string> {
  const canonical = stableStringify({
    prompt_version: payload.promptVersion,
    model: payload.model,
    effect_type: payload.effectType,
    codex: payload.codex ?? null,
    scene: normalizeText(payload.scene),
    scope: payload.scope,
  });
  return sha256Hex(canonical);
}
