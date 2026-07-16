const HEX = [...Array(256).keys()].map((value) =>
  value.toString(16).padStart(2, "0"),
);

export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new RangeError("token byte length must be between 16 and 128");
  }
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((item) => HEX[item]!).join("");
}

export async function sha256HexBytes(
  value: ArrayBuffer | Uint8Array,
): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((item) => HEX[item]!).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(value));
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

export function isFeatureEnabled(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}
