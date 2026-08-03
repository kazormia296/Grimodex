export interface LiveReaderModelOverride {
  model: string | null;
  provider: string | null;
  apiVariant: string | null;
  endpointId: string | null;
}

interface SettingReader {
  get: (key: string, defaultValue?: string) => string;
}

const READER_MODEL_KEY = "aiModel.role.reader";
const ROLE_PROVIDERS_KEY = "aiModel.roleProviders";

function parseReaderProviderOverride(raw: string): {
  provider: string | null;
  endpointId: string | null;
} {
  if (!raw.trim()) return { provider: null, endpointId: null };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { provider: null, endpointId: null };
    }
    const reader = (parsed as Record<string, unknown>).reader;
    if (!reader || typeof reader !== "object" || Array.isArray(reader)) {
      return { provider: null, endpointId: null };
    }
    const entry = reader as Record<string, unknown>;
    return {
      provider:
        typeof entry.provider === "string" && entry.provider.trim()
          ? entry.provider.trim()
          : null,
      endpointId:
        typeof entry.endpointId === "string" && entry.endpointId.trim()
          ? entry.endpointId.trim()
          : null,
    };
  } catch {
    return { provider: null, endpointId: null };
  }
}

/**
 * Resolve only the reader role settings needed by the live path.
 *
 * The general model-routing registry is intentionally kept out of the editor's
 * startup graph. Reader settings use the same persisted keys and provider
 * variant rule as the full resolver, while the one known structured-output
 * exclusion remains fail-safe.
 */
export function resolveLiveReaderModelOverride(
  settings: SettingReader,
): LiveReaderModelOverride {
  const model = settings.get(READER_MODEL_KEY, "").trim();
  if (!model || isKnownStructuredOutputMismatch(model)) {
    return { model: null, provider: null, apiVariant: null, endpointId: null };
  }

  const { provider, endpointId } = parseReaderProviderOverride(
    settings.get(ROLE_PROVIDERS_KEY, ""),
  );
  return {
    model,
    provider,
    apiVariant: provider === "sakana" ? "responses" : null,
    endpointId,
  };
}

function isKnownStructuredOutputMismatch(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized === "deepseek-r1" ||
    normalized.startsWith("deepseek-r1-") ||
    normalized === "deepseek/deepseek-r1" ||
    normalized.startsWith("deepseek/deepseek-r1-")
  );
}
