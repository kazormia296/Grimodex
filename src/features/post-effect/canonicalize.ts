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
  /**
   * プロバイダ横断（per-role）の送信先 provider。未指定 = ハッシュに含めない。
   * model 文字列が同一でも別プロバイダなら別キャッシュにするための識別軸。
   */
  provider?: string | null;
  /** OpenAI 互換の送信先エンドポイント。未指定 = ハッシュに含めない。 */
  endpointId?: string | null;
}

/**
 * プロバイダ横断（per-role）の送信先。input_hash のキャッシュ識別キーに混ぜる。
 * builder / view から computeInputHash へ provider/endpointId を糸通しするための型。
 */
export type HashRoute = Pick<InputHashPayload, "provider" | "endpointId">;

/**
 * Compute sha256 input_hash for a post-effect run.
 * Phase ID は入力に含めない（解決後の値が payload に既に反映）。
 *
 * provider / endpointId は「設定されているときだけ」キーに混ぜる。未設定（= active
 * プロバイダ単独運用、従来の大多数のケース）では従来とまったく同じ正規化文字列を
 * 生成し、既存キャッシュエントリと byte 互換を保つ。横断割り当て時のみ送信先が
 * キーに反映され、同一 model 名・別プロバイダの衝突（stale 結果の誤返却）を防ぐ。
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
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.endpointId ? { endpoint_id: payload.endpointId } : {}),
  });
  return sha256Hex(canonical);
}
