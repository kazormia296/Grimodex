import type { ChatMessage } from "./chatTypes";

/**
 * Stable revision for the user-visible conversation that is imported into a
 * newly-created Codex thread. System prompt snapshots are intentionally not
 * included: the current Grimodex context is sent as a separate packet.
 */
export async function computeChatHistoryRevision(
  messages: readonly ChatMessage[],
): Promise<string> {
  const canonical = JSON.stringify(
    messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        model: message.model ?? null,
        metadata: message.metadata ?? null,
        isSummarized: message.isSummarized ?? 0,
      })),
  );
  const bytes = new TextEncoder().encode(canonical);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  // Chromium always provides Web Crypto, but keep non-browser tests and
  // constrained WebViews deterministic instead of silently using a random id.
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildCodexBootstrapHistory(
  messages: readonly ChatMessage[],
): string | undefined {
  const lines = messages
    .filter((message) => message.role !== "system" && message.content.trim())
    .map((message) => `[${message.role}]\n${message.content}`);
  return lines.length > 0 ? lines.join("\n\n") : undefined;
}
