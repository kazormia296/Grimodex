import type { AiModel } from "../types";

const STORAGE_KEY = "grimodex.openrouterModelCaps.v1";
const CURRENT_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000; // 24h

interface StoredMeta {
  ctx?: number;
  out?: number;
  tools: 0 | 1;
  reasoning: 0 | 1;
  inPerM?: number;
  outPerM?: number;
}

interface StorageFormat {
  version: number;
  fetchedAt: number;
  models: Record<string, StoredMeta>;
}

export interface DynamicModelMeta {
  ctx?: number;
  out?: number;
  tools: boolean;
  reasoning: boolean;
  inPerM?: number;
  outPerM?: number;
}

// Module-level registry (id → meta)
let registry = new Map<string, StoredMeta>();
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(STORAGE_KEY)
        : null;
    if (!raw) return;
    const parsed: StorageFormat = JSON.parse(raw);
    if (parsed?.version !== CURRENT_VERSION || !parsed.models) return;
    for (const [id, meta] of Object.entries(parsed.models)) {
      registry.set(id, meta as StoredMeta);
    }
  } catch {
    // corrupt JSON — silent fail, keeps registry empty
  }
}

function persist(): void {
  if (typeof localStorage === "undefined") return;
  const models: Record<string, StoredMeta> = {};
  for (const [id, meta] of registry) {
    models[id] = meta;
  }
  const storage: StorageFormat = {
    version: CURRENT_VERSION,
    fetchedAt: Date.now(),
    models,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
  } catch {
    // storage quota — silent fail
  }
}

function parsePricingPerMillion(
  priceStr: string | undefined,
): number | undefined {
  if (!priceStr) return undefined;
  // OpenRouter pricing is USD per token; multiply by 1M for per-million rate
  const perToken = parseFloat(priceStr);
  if (!isFinite(perToken) || perToken <= 0) return undefined;
  return perToken * 1_000_000;
}

/**
 * OpenRouter /models レスポンスから AiModel[] を動的 capability レジストリに登録する。
 * "/" を含む id のみ登録し bare id との衝突を構造的に排除する。
 */
export function registerDynamicModelCaps(models: AiModel[]): void {
  hydrate();
  let changed = false;
  for (const m of models) {
    if (!m.id.includes("/")) continue;
    const { contextLength, maxCompletionTokens, supportedParameters } = m;
    if (
      contextLength === undefined &&
      maxCompletionTokens === undefined &&
      !supportedParameters
    )
      continue;

    const meta: StoredMeta = {
      tools: supportedParameters?.includes("tools") ? 1 : 0,
      reasoning: supportedParameters?.includes("reasoning") ? 1 : 0,
    };
    if (contextLength != null) meta.ctx = contextLength;
    if (maxCompletionTokens != null) meta.out = maxCompletionTokens;
    const inPerM = parsePricingPerMillion(m.pricingPrompt);
    const outPerM = parsePricingPerMillion(m.pricingCompletion);
    if (inPerM !== undefined) meta.inPerM = inPerM;
    if (outPerM !== undefined) meta.outPerM = outPerM;

    registry.set(m.id, meta);
    changed = true;
  }
  if (changed) persist();
}

/**
 * モデル ID で動的 capability を引く。
 * - legacy "openrouter/<id>" prefix を strip して再試行する。
 * - 未登録 → null（呼び出し元はハードコード fallback を使う）。
 */
export function getDynamicModelMeta(modelId: string): DynamicModelMeta | null {
  hydrate();

  let raw = registry.get(modelId);

  // Strip legacy "openrouter/" prefix and retry
  if (!raw && modelId.startsWith("openrouter/")) {
    raw = registry.get(modelId.slice("openrouter/".length));
  }

  if (!raw) return null;

  return {
    ctx: raw.ctx,
    out: raw.out,
    tools: raw.tools === 1,
    reasoning: raw.reasoning === 1,
    inPerM: raw.inPerM,
    outPerM: raw.outPerM,
  };
}

/**
 * localStorage のキャッシュが stale かどうかを返す。
 * TTL を超えているか、データが存在しない場合に true。
 */
export function isDynamicCapsStale(ttlMs = DEFAULT_TTL_MS): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return true;
    const parsed: StorageFormat = JSON.parse(raw);
    if (parsed?.version !== CURRENT_VERSION) return true;
    return Date.now() - parsed.fetchedAt > ttlMs;
  } catch {
    return true;
  }
}

/** テスト用: in-memory レジストリと hydration 状態をリセットする（localStorage はそのまま）。 */
export function __resetDynamicModelCapsForTests(): void {
  registry = new Map();
  hydrated = false;
}
