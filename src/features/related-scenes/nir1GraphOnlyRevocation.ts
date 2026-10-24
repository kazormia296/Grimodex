/**
 * Renderer-internal notice that the author revoked a Scene's body declaration
 * in this window (CP-3b D8, DR-CP3B-9). It carries the Scene ID only: no
 * excerpt, title or token. Related Scenes uses it to drop a shown Graph-only
 * row of that Scene and query once more; a revoke anywhere else (another
 * window, MCP, restore) is left to the click-time re-qualification.
 *
 * Imported by the body declaration chunk and the Scene context chunk only,
 * never by a startup module.
 */
import { debugLog } from "@/lib/debugLog";

const listeners = new Set<(sceneId: string) => void>();

export function notifyNir1GraphOnlyRevoked(sceneId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(sceneId);
    } catch {
      // Never the Scene ID or the error text: a fixed message only.
      debugLog.warn("related-scenes", "graph-only revocation listener failed");
    }
  }
}

export function subscribeNir1GraphOnlyRevocation(
  listener: (sceneId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
