const MAX_DEFAULT_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".markdown"]);
const ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/octet-stream",
]);

export interface UploadIntentInput {
  filename: string;
  contentType: string;
  size: number;
}

export interface ValidatedUploadIntent extends UploadIntentInput {
  extension: string;
}

function extensionOf(filename: string): string {
  const lower = filename.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

export function validateUploadIntent(
  input: unknown,
  maxBytes = MAX_DEFAULT_UPLOAD_BYTES,
): ValidatedUploadIntent {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("upload intent body must be an object");
  }
  const value = input as Record<string, unknown>;
  const filename =
    typeof value.filename === "string" ? value.filename.trim() : "";
  const contentType =
    typeof value.contentType === "string"
      ? value.contentType.trim().toLowerCase()
      : "";
  const size = typeof value.size === "number" ? value.size : Number.NaN;
  const extension = extensionOf(filename);
  if (
    filename.length === 0 ||
    filename.length > 240 ||
    filename.includes("\u0000")
  ) {
    throw new Error("filename is invalid");
  }
  if (!ALLOWED_EXTENSIONS.has(extension))
    throw new Error("unsupported upload extension");
  if (!ALLOWED_MIME_TYPES.has(contentType))
    throw new Error("unsupported upload content type");
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
    throw new Error(`upload exceeds the ${maxBytes}-byte limit`);
  }
  return { filename, contentType, size, extension };
}

export function parseMaxUploadBytes(value: string | undefined): number {
  if (value === undefined) return MAX_DEFAULT_UPLOAD_BYTES;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : MAX_DEFAULT_UPLOAD_BYTES;
}
