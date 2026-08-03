import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import type { DocumentKey } from "@/features/editor/document/documentKey";
import { isInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import { useExternalWriteStore } from "./externalWriteStore";

export interface DocumentWriteNotification {
  domain: string;
  opType: string;
  entityId?: string | null;
}

/**
 * Fan a same-renderer write back into open editor sessions.
 *
 * The external write poller excludes this renderer's recorder session, so
 * Agent/tool writes must call this directly. Clean buffers reload to acquire
 * the new persisted version; dirty buffers retain their text and surface a
 * conflict instead of being overwritten.
 */
export function notifySameRendererDocumentWrite(
  documentKey: DocumentKey,
  notification: DocumentWriteNotification,
  options?: { inlineAiPending?: boolean },
): "conflict" | "reload" {
  const dirty = useEditorSessionStore.getState().isDocumentDirty(documentKey);
  const pending = options?.inlineAiPending ?? isInlineAiPending();
  const external = useExternalWriteStore.getState();

  if (dirty || pending) {
    external.pushConflict({
      documentKey,
      sceneId: documentKey.id,
      domain: notification.domain,
      opType: notification.opType,
      entityId: notification.entityId ?? documentKey.id,
    });
    return "conflict";
  }

  external.bumpReloadNonce(documentKey);
  return "reload";
}
