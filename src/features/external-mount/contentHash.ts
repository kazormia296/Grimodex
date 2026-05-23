/** SHA-256 hex of normalized text (LF). Matches Rust `external_mount::hash`. */
export async function contentHash(text: string): Promise<string> {
  const normalized = text.replace(/\r\n/g, "\n");
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function contentHashSync(text: string): string {
  // Used only where async crypto is unavailable; tests may mock.
  let hash = 0;
  const normalized = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
