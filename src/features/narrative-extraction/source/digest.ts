import type { Sha256Digest } from "./types";

/** True when a string contains a UTF-16 surrogate without its pair. */
export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function compareJsonKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function encodeStableJson(
  value: unknown,
  ancestors: Set<object>,
): string | undefined {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      if (hasLoneSurrogate(value)) {
        throw new TypeError(
          "stable JSON cannot contain a lone UTF-16 surrogate",
        );
      }
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "bigint":
      throw new TypeError("stable JSON cannot encode bigint values");
    case "object":
      break;
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError("stable JSON cannot encode cyclic values");
  }
  ancestors.add(objectValue);

  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => encodeStableJson(item, ancestors) ?? "null")
        .join(",")}]`;
    }

    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      return encodeStableJson(toJson.call(value), ancestors);
    }

    const record = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const key of Object.keys(record).sort(compareJsonKeys)) {
      if (hasLoneSurrogate(key)) {
        throw new TypeError(
          "stable JSON cannot contain a lone UTF-16 surrogate in an object key",
        );
      }
      const encoded = encodeStableJson(record[key], ancestors);
      if (encoded !== undefined) {
        entries.push(`${JSON.stringify(key)}:${encoded}`);
      }
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}

/** Deterministic JSON: object keys are sorted; array order is preserved. */
export function stableJsonStringify(value: unknown): string {
  const encoded = encodeStableJson(value, new Set());
  if (encoded === undefined) {
    throw new TypeError("stable JSON root must be JSON-serializable");
  }
  return encoded;
}

export async function sha256Digest(value: string): Promise<Sha256Digest> {
  if (hasLoneSurrogate(value)) {
    throw new TypeError("SHA-256 input cannot contain a lone UTF-16 surrogate");
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

export async function digestStableJson(value: unknown): Promise<Sha256Digest> {
  return sha256Digest(stableJsonStringify(value));
}
