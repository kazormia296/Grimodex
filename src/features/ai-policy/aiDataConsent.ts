export type AiDataConsentRoute = "scan" | "hosted-editor" | "byok";

export interface AiDataConsentIdentity {
  policyVersion: string;
  route: AiDataConsentRoute;
  provider: string;
}

export interface AiDataConsentRecord extends AiDataConsentIdentity {
  acceptedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isConsentRoute(value: unknown): value is AiDataConsentRoute {
  return value === "scan" || value === "hosted-editor" || value === "byok";
}

function parseConsentIdentity(value: unknown): AiDataConsentIdentity | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.policyVersion) ||
    !isConsentRoute(value.route) ||
    !isNonEmptyString(value.provider)
  ) {
    return null;
  }
  return {
    policyVersion: value.policyVersion,
    route: value.route,
    provider: value.provider,
  };
}

export function createAiDataConsentRecord(
  identity: AiDataConsentIdentity,
  acceptedAt = new Date().toISOString(),
): AiDataConsentRecord {
  const parsedIdentity = parseConsentIdentity(identity);
  if (!parsedIdentity) throw new Error("AI data consent identity is invalid");
  if (!isNonEmptyString(acceptedAt) || Number.isNaN(Date.parse(acceptedAt))) {
    throw new Error("AI data consent timestamp is invalid");
  }
  return { ...parsedIdentity, acceptedAt };
}

export function isAiDataConsentCurrent(
  value: unknown,
  currentIdentity: AiDataConsentIdentity,
): value is AiDataConsentRecord {
  const expected = parseConsentIdentity(currentIdentity);
  if (!expected || !isRecord(value)) return false;
  const stored = parseConsentIdentity(value);
  if (
    !stored ||
    !isNonEmptyString(value.acceptedAt) ||
    Number.isNaN(Date.parse(value.acceptedAt))
  ) {
    return false;
  }
  return (
    stored.policyVersion === expected.policyVersion &&
    stored.route === expected.route &&
    stored.provider === expected.provider
  );
}
