import type { ChatMessage } from "./chatTypes";
import { stripToolProtocol } from "./toolProtocol";

function activeCodexHistory(messages: readonly ChatMessage[]) {
  return messages.flatMap((message) => {
    if (message.isSummarized) return [];
    // App Server history is another model-consumption boundary. Apply the
    // same assistant-history sanitizer as the HTTP/exec payload path while
    // preserving persisted system messages such as linked-session context.
    // Dynamic prompt packets never enter this projection: callers pass the
    // persisted pre-turn conversation before adding the current system prompt.
    const content =
      message.role === "assistant"
        ? stripToolProtocol(message.content)
        : message.content;
    if (content.trim().length === 0) return [];
    return [{ role: message.role, content }];
  });
}

/**
 * Stable revision for the user-visible conversation that is imported into a
 * newly-created Codex thread. The current dynamic Grimodex context is sent as
 * a separate packet and is therefore absent from this persisted projection.
 */
export async function computeChatHistoryRevision(
  messages: readonly ChatMessage[],
): Promise<string> {
  const canonical = JSON.stringify(activeCodexHistory(messages));
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
  const lines = activeCodexHistory(messages).map(
    (message) => `[${message.role}]\n${message.content}`,
  );
  return lines.length > 0 ? lines.join("\n\n") : undefined;
}
