/**
 * API キーの service/account 命名 + 解決規則（Electron 移行 Phase 3 バッチ3a）。
 *
 * Grimodex は Tauri 版で API キーを OS keyring に `(service, account)` で保存する。
 * Electron 版はキー保管を safeStorage へ移すが、**命名規則と解決規則は Tauri と
 * 完全一致**させる（`src-tauri/crates/grimodex-ai/src/lib.rs` の keyring_service /
 * keyring_user / keyring_user_candidates と `commands/ai.rs` の resolve_api_key の
 * TS 移植）。これにより将来 keyring→safeStorage 移行ツールを書くときの対応も自明になる。
 *
 * このモジュールは electron / node 組み込みに依存しない純関数のみ（keyStore.ts が
 * safeStorage と暗号文ストアを与える）。node 環境の単体テスト対象。
 */

/** 既定の keyring account。OpenAI 互換のみ endpoint_id を account に使う。 */
export const KEYRING_USER = "grimodex-user";

/** OpenAI 互換の移行既定エンドポイント id。legacy フォールバックの対象。 */
export const LEGACY_OPENAI_COMPAT_ENDPOINT_ID = "default";

/** provider 単位の service 名（Rust keyring_service と一致）。 */
const KEYRING_SERVICES: Readonly<Record<string, string>> = {
  openrouter: "grimodex-openrouter",
  openai: "grimodex-openai",
  anthropic: "grimodex-anthropic",
  ollama: "grimodex-ollama",
  "openai-compatible": "grimodex-openai-compatible",
  sakana: "grimodex-sakana",
  "ai-novelist": "grimodex-ai-novelist",
  cli: "grimodex-cli",
};

/** provider → keyring service 名。未知 provider は入力エラー（Rust の enum 網羅性に相当）。 */
export function keyringService(provider: string): string {
  const service = KEYRING_SERVICES[provider];
  if (service === undefined) {
    throw new Error(`unknown AI provider: ${provider}`);
  }
  return service;
}

/**
 * keyring の account（Rust keyring_user と一致）。OpenAI 互換は endpoint_id を
 * account に載せてエンドポイントごとに別キーを保存する（service は provider 単位で不変）。
 * それ以外のプロバイダは単一の `KEYRING_USER`。
 */
export function keyringUser(
  provider: string,
  endpointId: string | null,
): string {
  if (provider === "openai-compatible" && endpointId && endpointId.length > 0) {
    return endpointId;
  }
  return KEYRING_USER;
}

/**
 * 指定 (provider, endpoint_id) のキー解決で試す account を優先順に返す
 * （Rust keyring_user_candidates と一致）。OpenAI 互換の移行既定エンドポイント
 * (`"default"`) は自分の user を引き、無ければ旧 user (`grimodex-user`) に
 * フォールバックする。get は先頭一致を返し、delete は全員を消す（非対称バグ防止）。
 */
export function keyringUserCandidates(
  provider: string,
  endpointId: string | null,
): string[] {
  const primary = keyringUser(provider, endpointId);
  if (
    provider === "openai-compatible" &&
    endpointId === LEGACY_OPENAI_COMPAT_ENDPOINT_ID
  ) {
    // primary == "default"。legacy user は必ず別名なので重複しない。
    return [primary, KEYRING_USER];
  }
  return [primary];
}

/** (service, account) → 平文キー or null を返すルックアップ関数。 */
export type KeyLookup = (service: string, account: string) => string | null;

/**
 * 送信系で使う実 API キーを解決する（Rust commands::ai::resolve_api_key の TS 版）。
 * - Ollama / Cli: keyring に触れず空文字（ローカル LLM / CLI 認証）
 * - OpenaiCompatible: 任意（候補を引き、無ければ空文字）
 * - その他: 必須（候補を引き、無ければ throw）
 *
 * `getKey` は候補 account を順に引く（keyring_user_candidates と同じく先頭一致）。
 */
export function resolveApiKey(
  provider: string,
  endpointId: string | null,
  getKey: KeyLookup,
): string {
  if (provider === "ollama" || provider === "cli") {
    return "";
  }
  // OpenaiCompatible のみ endpoint 単位、他は None 相当（get_api_key の endpoint 引数に一致）。
  const lookupEndpoint = provider === "openai-compatible" ? endpointId : null;
  const service = keyringService(provider);
  for (const account of keyringUserCandidates(provider, lookupEndpoint)) {
    const key = getKey(service, account);
    if (key !== null) {
      return key;
    }
  }
  if (provider === "openai-compatible") {
    return ""; // 任意（未設定は空文字）
  }
  // Rust: `No API key configured for {provider}`（provider の Display = wire 文字列）。
  throw new Error(`No API key configured for ${provider}`);
}

/**
 * キーの有無だけを返す（Rust has_api_key = get_api_key(provider, endpoint_id).is_some()）。
 * ollama/cli も含めて候補を引く（Rust の has_api_key に ollama/cli 特例は無い）。
 */
export function hasApiKey(
  provider: string,
  endpointId: string | null,
  getKey: KeyLookup,
): boolean {
  const service = keyringService(provider);
  return keyringUserCandidates(provider, endpointId).some(
    (account) => getKey(service, account) !== null,
  );
}

/** 最小限の AiSettings 形（effective provider/endpoint 解決に必要な部分のみ）。 */
export interface AiSettingsLite {
  provider?: unknown;
  openaiCompatibleEndpoints?: unknown;
  activeOpenaiCompatibleEndpointId?: unknown;
}

/**
 * FE 引数（provider/endpoint override）と設定から、キー解決に使う**実効**
 * provider/endpoint を求める（Rust apply_provider_override の provider/endpoint 部分の subset）。
 * - provider: 引数 override（非空）優先、無ければ設定の既定
 * - endpoint: 既知 id の引数 override のみ採用、それ以外は設定の active を据え置き
 *   （未知 id で別サーバへ無言リターゲットしない契約）
 */
export function effectiveProviderEndpoint(
  settings: AiSettingsLite,
  argProvider: unknown,
  argEndpointId: unknown,
): { provider: string; endpointId: string | null } {
  const provider =
    typeof argProvider === "string" && argProvider.length > 0
      ? argProvider
      : typeof settings.provider === "string"
        ? settings.provider
        : "";

  const endpoints = Array.isArray(settings.openaiCompatibleEndpoints)
    ? settings.openaiCompatibleEndpoints
    : [];
  const isKnownEndpoint = (id: string): boolean =>
    endpoints.some(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { id?: unknown }).id === id,
    );

  let endpointId: string | null =
    typeof settings.activeOpenaiCompatibleEndpointId === "string"
      ? settings.activeOpenaiCompatibleEndpointId
      : null;
  if (
    typeof argEndpointId === "string" &&
    argEndpointId.length > 0 &&
    isKnownEndpoint(argEndpointId)
  ) {
    endpointId = argEndpointId;
  }

  return { provider, endpointId };
}
