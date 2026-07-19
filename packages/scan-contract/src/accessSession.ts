export const ACCESS_SESSION_SCHEMA_VERSION =
  "grimodex/access-session/1" as const;

export interface AccessSessionV1 {
  schemaVersion: typeof ACCESS_SESSION_SCHEMA_VERSION;
  subject: string;
  expiresAt: string;
  fullScanEnabled: boolean;
  hostedEditorAiEnabled: boolean;
}

export type AccessSessionValidationResult =
  | { ok: true; value: AccessSessionV1 }
  | { ok: false; errors: Array<{ path: string; message: string }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAccessSession(
  value: unknown,
): AccessSessionValidationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [{ path: "/", message: "access session must be an object" }],
    };
  }
  const errors: Array<{ path: string; message: string }> = [];
  const expectedKeys = [
    "expiresAt",
    "fullScanEnabled",
    "hostedEditorAiEnabled",
    "schemaVersion",
    "subject",
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    errors.push({
      path: "/",
      message: "access session properties are invalid",
    });
  }
  if (value.schemaVersion !== ACCESS_SESSION_SCHEMA_VERSION) {
    errors.push({
      path: "/schemaVersion",
      message: "access session schema version is invalid",
    });
  }
  if (
    typeof value.subject !== "string" ||
    value.subject.length < 1 ||
    value.subject.length > 128
  ) {
    errors.push({ path: "/subject", message: "account subject is invalid" });
  }
  if (
    typeof value.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    errors.push({
      path: "/expiresAt",
      message: "account session expiry is invalid",
    });
  }
  if (typeof value.fullScanEnabled !== "boolean") {
    errors.push({
      path: "/fullScanEnabled",
      message: "Full Scan capability is invalid",
    });
  }
  if (typeof value.hostedEditorAiEnabled !== "boolean") {
    errors.push({
      path: "/hostedEditorAiEnabled",
      message: "Hosted Editor capability is invalid",
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as unknown as AccessSessionV1 };
}
