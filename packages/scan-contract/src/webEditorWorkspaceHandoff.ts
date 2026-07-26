import type { ScanValidationError } from "./validate.js";

export const WEB_EDITOR_WORKSPACE_HANDOFF_SCHEMA_VERSION =
  "grimodex/web-editor-workspace-handoff/1" as const;

export const WEB_EDITOR_WORKSPACE_HANDOFF_MAX_DATABASE_BYTES = 64 * 1024 * 1024;

const WEB_EDITOR_WORKSPACE_HANDOFF_ENCODING = "base64" as const;
const SQLITE_MAGIC = new TextEncoder().encode("SQLite format 3\0");
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const HANDOFF_KEYS = [
  "createdAt",
  "databaseBase64",
  "encoding",
  "projectId",
  "schemaVersion",
  "sourceMode",
  "title",
  "uiLanguage",
] as const;

const MAX_PROJECT_ID_LENGTH = 96;
const MAX_TITLE_LENGTH = 200;
const MAX_FILENAME_LENGTH = 128;
const HANDOFF_FILENAME_SUFFIX = ".grimodex-handoff";

export type WebEditorSourceMode = "scan" | "standalone";
export type WebEditorUiLanguage = "ja" | "en";

export interface WebEditorWorkspaceHandoffV1 {
  schemaVersion: typeof WEB_EDITOR_WORKSPACE_HANDOFF_SCHEMA_VERSION;
  encoding: typeof WEB_EDITOR_WORKSPACE_HANDOFF_ENCODING;
  databaseBase64: string;
  createdAt: string;
  sourceMode: WebEditorSourceMode;
  uiLanguage: WebEditorUiLanguage;
  projectId: string;
  title: string;
}

export interface BuildWebEditorWorkspaceHandoffInput {
  databaseBytes: Uint8Array;
  createdAt: string;
  sourceMode: WebEditorSourceMode;
  uiLanguage: WebEditorUiLanguage;
  projectId: string;
  title: string;
}

export interface ParseWebEditorWorkspaceHandoffOptions {
  maxDatabaseBytes?: number;
}

export type WebEditorWorkspaceHandoffValidationResult =
  | { ok: true; value: WebEditorWorkspaceHandoffV1 }
  | { ok: false; errors: ScanValidationError[] };

function error(
  code: string,
  path: string,
  message: string,
): ScanValidationError {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === HANDOFF_KEYS.length &&
    keys.every((key, index) => key === HANDOFF_KEYS[index])
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function decodedBase64Length(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;

  for (let index = 0; index < contentLength; index += 1) {
    if (BASE64_ALPHABET.indexOf(value[index]!) < 0) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value[index] !== "=") return false;
  }

  // RFC 4648 canonical encodings require unused pad bits to be zero.
  if (padding === 2) {
    const lastValue = BASE64_ALPHABET.indexOf(value[value.length - 3]!);
    return lastValue >= 0 && (lastValue & 0x0f) === 0;
  }
  if (padding === 1) {
    const lastValue = BASE64_ALPHABET.indexOf(value[value.length - 2]!);
    return lastValue >= 0 && (lastValue & 0x03) === 0;
  }
  return true;
}

function decodeBase64Prefix(value: string, length: number): Uint8Array {
  const output = new Uint8Array(Math.min(length, decodedBase64Length(value)));
  let outputIndex = 0;

  for (
    let offset = 0;
    offset < value.length && outputIndex < length;
    offset += 4
  ) {
    const a = BASE64_ALPHABET.indexOf(value[offset]!);
    const b = BASE64_ALPHABET.indexOf(value[offset + 1]!);
    const c =
      value[offset + 2] === "="
        ? 0
        : BASE64_ALPHABET.indexOf(value[offset + 2]!);
    const d =
      value[offset + 3] === "="
        ? 0
        : BASE64_ALPHABET.indexOf(value[offset + 3]!);
    const packed = (a << 18) | (b << 12) | (c << 6) | d;

    output[outputIndex] = (packed >>> 16) & 0xff;
    outputIndex += 1;
    if (value[offset + 2] !== "=" && outputIndex < output.length) {
      output[outputIndex] = (packed >>> 8) & 0xff;
      outputIndex += 1;
    }
    if (value[offset + 3] !== "=" && outputIndex < output.length) {
      output[outputIndex] = packed & 0xff;
      outputIndex += 1;
    }
  }

  return output;
}

function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SQLITE_MAGIC.byteLength) return false;
  return SQLITE_MAGIC.every((byte, index) => bytes[index] === byte);
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const bytesPerChunk = 12_288;

  for (
    let chunkStart = 0;
    chunkStart < bytes.length;
    chunkStart += bytesPerChunk
  ) {
    const chunkEnd = Math.min(bytes.length, chunkStart + bytesPerChunk);
    let chunk = "";
    let index = chunkStart;
    for (; index + 2 < chunkEnd; index += 3) {
      const packed =
        (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
      chunk += BASE64_ALPHABET[(packed >>> 18) & 0x3f]!;
      chunk += BASE64_ALPHABET[(packed >>> 12) & 0x3f]!;
      chunk += BASE64_ALPHABET[(packed >>> 6) & 0x3f]!;
      chunk += BASE64_ALPHABET[packed & 0x3f]!;
    }
    const remaining = chunkEnd - index;
    if (remaining === 1) {
      const packed = bytes[index]! << 16;
      chunk += BASE64_ALPHABET[(packed >>> 18) & 0x3f]!;
      chunk += BASE64_ALPHABET[(packed >>> 12) & 0x3f]!;
      chunk += "==";
    } else if (remaining === 2) {
      const packed = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
      chunk += BASE64_ALPHABET[(packed >>> 18) & 0x3f]!;
      chunk += BASE64_ALPHABET[(packed >>> 12) & 0x3f]!;
      chunk += BASE64_ALPHABET[(packed >>> 6) & 0x3f]!;
      chunk += "=";
    }
    chunks.push(chunk);
  }

  return chunks.join("");
}

function validateMetadata(
  value: Record<string, unknown>,
  errors: ScanValidationError[],
): void {
  if (!isIsoTimestamp(value.createdAt)) {
    errors.push(
      error(
        "schema:format",
        "/createdAt",
        "createdAt must be a canonical ISO timestamp",
      ),
    );
  }
  if (value.sourceMode !== "scan" && value.sourceMode !== "standalone") {
    errors.push(
      error(
        "schema:enum",
        "/sourceMode",
        "sourceMode must be scan or standalone",
      ),
    );
  }
  if (value.uiLanguage !== "ja" && value.uiLanguage !== "en") {
    errors.push(
      error("schema:enum", "/uiLanguage", "uiLanguage must be ja or en"),
    );
  }
  if (
    typeof value.projectId !== "string" ||
    value.projectId.length === 0 ||
    value.projectId.length > MAX_PROJECT_ID_LENGTH ||
    !PROJECT_ID_PATTERN.test(value.projectId)
  ) {
    errors.push(error("schema:pattern", "/projectId", "projectId is invalid"));
  }
  if (
    typeof value.title !== "string" ||
    value.title.trim().length === 0 ||
    value.title.length > MAX_TITLE_LENGTH ||
    CONTROL_CHARACTERS.test(value.title)
  ) {
    errors.push(
      error(
        "schema:limit",
        "/title",
        "title must be a non-empty single-line string of at most 200 characters",
      ),
    );
  }
}

function normalizeMaxDatabaseBytes(
  options: ParseWebEditorWorkspaceHandoffOptions,
): number {
  const maxDatabaseBytes =
    options.maxDatabaseBytes ?? WEB_EDITOR_WORKSPACE_HANDOFF_MAX_DATABASE_BYTES;
  if (!Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes < 0) {
    throw new RangeError(
      "maxDatabaseBytes must be a non-negative safe integer",
    );
  }
  return maxDatabaseBytes;
}

export function parseWebEditorWorkspaceHandoff(
  input: unknown,
  options: ParseWebEditorWorkspaceHandoffOptions = {},
): WebEditorWorkspaceHandoffValidationResult {
  const maxDatabaseBytes = normalizeMaxDatabaseBytes(options);
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        error(
          "schema:type",
          "/",
          "Web Editor workspace handoff must be an object",
        ),
      ],
    };
  }

  const errors: ScanValidationError[] = [];
  if (!hasExactKeys(input)) {
    errors.push(
      error(
        "schema:properties",
        "/",
        "workspace handoff properties are invalid",
      ),
    );
  }
  if (input.schemaVersion !== WEB_EDITOR_WORKSPACE_HANDOFF_SCHEMA_VERSION) {
    errors.push(
      error(
        "schema:const",
        "/schemaVersion",
        "workspace handoff version is invalid",
      ),
    );
  }
  if (input.encoding !== WEB_EDITOR_WORKSPACE_HANDOFF_ENCODING) {
    errors.push(
      error(
        "schema:const",
        "/encoding",
        "workspace handoff encoding must be base64",
      ),
    );
  }
  validateMetadata(input, errors);

  const maxBase64Length = Math.ceil(maxDatabaseBytes / 3) * 4;
  if (
    typeof input.databaseBase64 === "string" &&
    input.databaseBase64.length > maxBase64Length
  ) {
    errors.push(
      error(
        "limit",
        "/databaseBase64",
        `encoded database exceeds the ${maxDatabaseBytes} byte limit`,
      ),
    );
  } else if (
    typeof input.databaseBase64 !== "string" ||
    !isCanonicalBase64(input.databaseBase64)
  ) {
    errors.push(
      error(
        "schema:pattern",
        "/databaseBase64",
        "databaseBase64 must be canonical base64",
      ),
    );
  } else {
    const decodedLength = decodedBase64Length(input.databaseBase64);
    if (decodedLength > maxDatabaseBytes) {
      errors.push(
        error(
          "limit",
          "/databaseBase64",
          `decoded database exceeds the ${maxDatabaseBytes} byte limit`,
        ),
      );
    } else if (
      !hasSqliteMagic(
        decodeBase64Prefix(input.databaseBase64, SQLITE_MAGIC.byteLength),
      )
    ) {
      errors.push(
        error(
          "schema:format",
          "/databaseBase64",
          "databaseBase64 does not contain a SQLite database",
        ),
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: input as unknown as WebEditorWorkspaceHandoffV1,
  };
}

export function buildWebEditorWorkspaceHandoff(
  input: BuildWebEditorWorkspaceHandoffInput,
): WebEditorWorkspaceHandoffV1 {
  if (!(input.databaseBytes instanceof Uint8Array)) {
    throw new TypeError("databaseBytes must be a Uint8Array");
  }
  if (
    input.databaseBytes.byteLength >
    WEB_EDITOR_WORKSPACE_HANDOFF_MAX_DATABASE_BYTES
  ) {
    throw new RangeError(
      `databaseBytes exceeds the ${WEB_EDITOR_WORKSPACE_HANDOFF_MAX_DATABASE_BYTES} byte limit`,
    );
  }
  if (!hasSqliteMagic(input.databaseBytes)) {
    throw new Error("databaseBytes does not contain a SQLite database");
  }

  const handoff: WebEditorWorkspaceHandoffV1 = {
    schemaVersion: WEB_EDITOR_WORKSPACE_HANDOFF_SCHEMA_VERSION,
    encoding: WEB_EDITOR_WORKSPACE_HANDOFF_ENCODING,
    databaseBase64: encodeBase64(input.databaseBytes),
    createdAt: input.createdAt,
    sourceMode: input.sourceMode,
    uiLanguage: input.uiLanguage,
    projectId: input.projectId,
    title: input.title,
  };
  const parsed = parseWebEditorWorkspaceHandoff(handoff);
  if (!parsed.ok) {
    throw new Error(
      `Invalid Web Editor workspace handoff: ${parsed.errors
        .map((item) => `${item.path} ${item.message}`)
        .join("; ")}`,
    );
  }
  return parsed.value;
}

function truncateFilenameStem(value: string, maxCodeUnits: number): string {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > maxCodeUnits) break;
    result += character;
  }
  return result;
}

export function buildWebEditorHandoffFilename(title: string): string {
  let stem = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, "-")
    .replace(/\.\.+/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/-+/gu, "-")
    .trim()
    .replace(/^[.\s-]+|[.\s-]+$/gu, "");

  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) {
    stem = `grimodex-${stem}`;
  }
  if (!stem) stem = "grimodex-web-editor";

  const maxStemLength = MAX_FILENAME_LENGTH - HANDOFF_FILENAME_SUFFIX.length;
  stem =
    truncateFilenameStem(stem, maxStemLength).replace(/[.\s-]+$/gu, "") ||
    "grimodex-web-editor";
  return `${stem}${HANDOFF_FILENAME_SUFFIX}`;
}
