import type { EditorSeedV1 } from "./scanBundleV1.js";
import { parseEditorSeed, type ScanValidationError } from "./validate.js";

const EDITOR_HANDOFF_FRAGMENT_KEY = "scan-import";
const EDITOR_UI_LANGUAGE_FRAGMENT_KEY = "ui-language";
export const EDITOR_HANDOFF_SCHEMA_VERSION =
  "grimodex/editor-handoff/1" as const;

export type EditorUiLanguage = "ja" | "en";

export interface HostedAiSessionV1 {
  scanId: string;
  token: string;
  expiresAt: string;
}

export interface EditorHandoffEnvelopeV1 {
  schemaVersion: typeof EDITOR_HANDOFF_SCHEMA_VERSION;
  seed: EditorSeedV1;
  hostedAiSession: HostedAiSessionV1;
}

export type EditorHandoffValidationResult =
  | { ok: true; value: EditorHandoffEnvelopeV1 }
  | { ok: false; errors: ScanValidationError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(
  code: string,
  path: string,
  message: string,
): ScanValidationError {
  return { code, path, message };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

export function parseEditorHandoffEnvelope(
  input: unknown,
): EditorHandoffValidationResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [error("schema:type", "/", "editor handoff must be an object")],
    };
  }
  const errors: ScanValidationError[] = [];
  if (!hasExactKeys(input, ["hostedAiSession", "schemaVersion", "seed"])) {
    errors.push(
      error("schema:properties", "/", "editor handoff properties are invalid"),
    );
  }
  if (input.schemaVersion !== EDITOR_HANDOFF_SCHEMA_VERSION) {
    errors.push(
      error(
        "schema:const",
        "/schemaVersion",
        "invalid editor handoff schema version",
      ),
    );
  }

  const seedResult = parseEditorSeed(input.seed);
  if (!seedResult.ok) {
    errors.push(
      ...seedResult.errors.map((seedError) => ({
        ...seedError,
        path: `/seed${seedError.path === "/" ? "" : seedError.path}`,
      })),
    );
  }

  const session = input.hostedAiSession;
  if (!isRecord(session)) {
    errors.push(
      error(
        "schema:type",
        "/hostedAiSession",
        "hosted AI session must be an object",
      ),
    );
  } else {
    if (!hasExactKeys(session, ["expiresAt", "scanId", "token"])) {
      errors.push(
        error(
          "schema:properties",
          "/hostedAiSession",
          "hosted AI session properties are invalid",
        ),
      );
    }
    if (
      typeof session.scanId !== "string" ||
      session.scanId.length === 0 ||
      session.scanId.length > 96 ||
      !/^[A-Za-z0-9._:-]+$/.test(session.scanId)
    ) {
      errors.push(
        error(
          "schema:pattern",
          "/hostedAiSession/scanId",
          "hosted AI session scan id is invalid",
        ),
      );
    }
    if (
      typeof session.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(session.token)
    ) {
      errors.push(
        error(
          "schema:pattern",
          "/hostedAiSession/token",
          "hosted AI session token is invalid",
        ),
      );
    }
    if (
      typeof session.expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        session.expiresAt,
      ) ||
      !Number.isFinite(Date.parse(session.expiresAt))
    ) {
      errors.push(
        error(
          "schema:format",
          "/hostedAiSession/expiresAt",
          "hosted AI session expiry must be an ISO timestamp",
        ),
      );
    }
  }

  if (errors.length > 0 || !seedResult.ok || !isRecord(session)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_HANDOFF_SCHEMA_VERSION,
      seed: seedResult.value,
      hostedAiSession: session as unknown as HostedAiSessionV1,
    },
  };
}

/**
 * Builds the cross-origin handoff URL for a Scan-created Editor seed.
 *
 * The token is deliberately isolated in the fragment so it is not sent to the
 * Editor host, then consumed by the Editor bootstrap after removing it from
 * browser history.
 */
export function buildEditorHandoffUrl(
  editorUrl: string,
  editorToken: string,
  uiLanguage?: EditorUiLanguage,
): string {
  if (editorToken.length === 0) {
    throw new Error("Editor handoff token must not be empty");
  }

  const url = new URL(editorUrl);
  url.search = "";
  const fragment = new URLSearchParams({
    [EDITOR_HANDOFF_FRAGMENT_KEY]: editorToken,
  });
  if (uiLanguage) {
    fragment.set(EDITOR_UI_LANGUAGE_FRAGMENT_KEY, uiLanguage);
  }
  url.hash = fragment.toString();
  return url.toString();
}
